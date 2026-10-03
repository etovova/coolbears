// Browser custody, asset signing and durable buyer response evidence. No wallet calls, RPC or dispatch.
import policy from '../../metadata/policy.json' with { type: 'json' };
import { base58 } from '@metaplex-foundation/umi/serializers';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import { createOrderModel } from './journal-model.mjs';
import {validateSequentialOrder,currentItemIndex} from './sequential.mjs';
import { prepareAssetClaim, validateAssetClaim, finalizeAssetRequest, validateAssetRequest, verifyBuyerSigningResponse, buyerRequestId } from './signing.mjs';
import {signedBytesId,validateBuyerSubmission,validateBuyerResult} from './submission.mjs';
import {validateCostApproval} from './cost-approval.mjs';
import {validateBuyerExpiryResult,expiryRecord} from './expiry-review.mjs';
import {failureRecord} from './failure-record.mjs';
import {validateMissingBuyerResponse,validateResponseRecovery,recoveredSubmission} from './response-recovery.mjs';
import {validateResponseExpiry} from './response-expiry.mjs';
import {responseExpiryReplacementSource} from './response-expiry-replacement.mjs';
import {validateReplacementResult,validateReplacementClaim,validateReplacementAcknowledgment} from './replacement.mjs';
import {validatePrewalletInput,validatePrewalletRecovery,prewalletSubmission,prewalletReplacementSource} from './prewallet-recovery.mjs';
import {validatePrewalletExpiry} from './prewallet-expiry.mjs';
import {prewalletExpiryReplacementSource} from './prewallet-expiry-replacement.mjs';
import {networkProfile} from '../deployment/network.mjs';
const DATABASE = 'coolbears-buyer-custody-v1';
const STORES = ['orders', 'keys', 'events', 'signing'];
const MAX_REVISION = 1024, MAX_BYTES = 262144;
const requireThat = (ok, code) => { if (!ok) throw Error(code); };
const BASE_FIELDS = ['id', 'cluster', 'buyer', 'machine', 'collection', 'guard'];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const responseExpiryProvenance=source=>source.input.walletClaim?{request:source.input.request,walletClaim:source.input.walletClaim}:undefined;
function keyShape(record, scopeKey, item) {
  const key = record?.privateKey, pub = record?.publicKey;
  requireThat(record?.version === 1 && record.scopeKey === scopeKey && record.index === item.index && record.asset === item.asset, 'ASSET_KEY_MISSING');
  requireThat(key instanceof CryptoKey && key.type === 'private' && !key.extractable && key.algorithm.name === 'Ed25519' && equal([...key.usages], ['sign']), 'INVALID_ASSET_KEY');
  requireThat(pub instanceof CryptoKey && pub.type === 'public' && pub.algorithm.name === 'Ed25519' && equal([...pub.usages], ['verify']), 'INVALID_ASSET_KEY');
}
export function createBuyerStorage({ indexedDB = globalThis.indexedDB, crypto = globalThis.crypto, locks = globalThis.navigator?.locks, storageOptions = {}, cluster = 'devnet', authorizeMainnet = false } = {}) {
  const network=networkProfile(cluster);
  requireThat(typeof authorizeMainnet==='boolean','STORAGE_CONFIGURATION');
  requireThat(network.cluster!=='mainnet-beta'||authorizeMainnet,'MAINNET_OPT_IN_REQUIRED');
  requireThat(network.cluster==='mainnet-beta'||!authorizeMainnet,'MAINNET_SCOPE_REQUIRED');
  const model = createOrderModel(policy, storageOptions);
  const hidden = storageOptions.storageMode === 'hidden-settings';
  const profile = hidden ? { storageMode: 'hidden-settings', hiddenCommitmentSha256: storageOptions.hiddenCommitmentSha256 } : {};
  const fields = [...BASE_FIELDS, ...Object.keys(profile)];
  function checkedScope(input) {
    // The validation placeholder must be distinct even when buyer is the owner.
    requireThat(hidden || (!Object.hasOwn(input ?? {}, 'storageMode') && !Object.hasOwn(input ?? {}, 'hiddenCommitmentSha256')), 'ORDER_STORAGE_PROFILE_MISMATCH');
    const scope = Object.fromEntries(fields.map(key => [key, input?.[key]]));
    if (hidden) requireThat(scope.storageMode === 'hidden-settings' && scope.hiddenCommitmentSha256 === profile.hiddenCommitmentSha256, 'ORDER_STORAGE_PROFILE_MISMATCH');
    const candidates = Array.from({ length: 8 }, (_, index) => base58.deserialize(new Uint8Array(32).fill(index + 1))[0]);
    const placeholder = candidates.find(value => ![...Object.values(scope), policy.owner].includes(value));
    model.createOrder({ ...scope, quantity: 1, available: 1, assets: [placeholder] });
    requireThat(scope.cluster === network.cluster, 'ORDER_NETWORK_SCOPE_MISMATCH');
    return scope;
  }
  function bounded(order) {
    model.validateOrder(order);
    validateSequentialOrder(order);
    requireThat(order.revision <= MAX_REVISION && new TextEncoder().encode(JSON.stringify(order)).length <= MAX_BYTES, 'ORDER_STORAGE_LIMIT');
    return order;
  }

  let opening, connection, closed = false;
  // One bounded, successful canonical snapshot only. Custody is never cached.
  // A typed fingerprint distinguishes missing/undefined properties and array
  // holes; every changed byte in retained evidence invalidates its validation.
  let evidenceCache=null;
  const replaySnapshots=new WeakMap();
  function token(value){
    if(value===null)return 'null';
    const type=typeof value;
    if(type!=='object')return type+':'+(type==='number'&&Object.is(value,-0)?'-0':JSON.stringify(value));
    const prototype=Object.getPrototypeOf(value);
    requireThat(Array.isArray(value)?prototype===Array.prototype:[Object.prototype,null].includes(prototype),'CORRUPT_ORDER_HISTORY');
    const names=Reflect.ownKeys(value);requireThat(names.every(name=>typeof name==='string'),'CORRUPT_ORDER_HISTORY');
    return (Array.isArray(value)?'array':prototype===null?'null-object':'object')+'{'+names.map(name=>JSON.stringify(name)+':'+token(value[name])).join(',')+'}';
  }
  const prefixHash=(previous,event)=>bytesToHex(sha256(new TextEncoder().encode(previous+'\n'+event)));
  // Only results actually returned by this instance's original native sign call.
  // No caller-supplied bytes, keys, re-signing or eviction of unresolved results.
  // This is volatile recovery, not persistence or device-loss recovery.
  const nativeResults = new Map(), nativeSlots = new Set(), MAX_NATIVE_RESULTS = 50;
  const requireCapabilities = () => requireThat(!closed && indexedDB?.open && crypto?.subtle && locks?.request && globalThis.isSecureContext !== false, 'STORAGE_UNAVAILABLE');
  function database() {
    requireCapabilities();
    return opening ??= new Promise((resolve, reject) => {
      let settled = false;
      const request = indexedDB.open(DATABASE, 2);
      const timer = setTimeout(() => fail(), 5000);
      function fail() { if (!settled) { settled = true; clearTimeout(timer); reject(Error('STORAGE_UNAVAILABLE')); } }
      request.onupgradeneeded = () => {
        if (settled || closed) { request.transaction.abort(); return; }
        for (const store of STORES) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
      };
      request.onblocked = request.onerror = fail;
      request.onsuccess = () => {
        if (settled || closed) { request.result.close(); fail(); return; }
        settled = true; clearTimeout(timer); connection = request.result;
        connection.onversionchange = () => { closed = true; connection.close(); };
        resolve(connection);
      };
    });
  }
  // action and all IDB callbacks remain synchronous: no crypto awaits inside tx.
  async function transaction(mode, action) {
    const db = await database();
    return new Promise((resolve, reject) => {
      let tx, result, failure, done = false;
      const fail = error => { if (!done) { done = true; clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => { try { tx?.abort(); } catch {} fail(Error('STORAGE_UNCERTAIN')); }, 10000);
      try {
        tx = db.transaction(STORES, mode, { durability: 'strict' });
        requireThat(mode === 'readonly' || tx.durability === 'strict', 'STORAGE_DURABILITY_UNSUPPORTED');
        tx.oncomplete = () => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
        tx.onabort = tx.onerror = () => fail(failure ?? Error('STORAGE_WRITE_FAILED'));
        const abort = error => { failure = error; try { tx.abort(); } catch {} fail(error); };
        action(tx, value => { result = value; }, abort);
      } catch (error) { try { tx?.abort(); } catch {} fail(error); }
    });
  }
  function load(tx, scopeKey, callback, abort) {
    const queries = [tx.objectStore('orders').get(scopeKey),
      tx.objectStore('keys').getAll(IDBKeyRange.bound([scopeKey, 0], [scopeKey, 50])),
      tx.objectStore('events').getAll(IDBKeyRange.bound([scopeKey, 0], [scopeKey, MAX_REVISION + 1])),
      tx.objectStore('signing').getAll(IDBKeyRange.bound([scopeKey], [scopeKey, []]))];
    let left = queries.length;
    queries.forEach(request => { request.onsuccess = () => {
      if (--left !== 0) return;
      try { callback(queries.map(request => request.result)); } catch (error) { abort(error); }
    }; });
  }
  // Canonical evidence remains readable after custody loss.
  function validateEvidence([order, keys, events, signing], scope) {
    if (order === undefined) { requireThat(keys.length === 0 && events.length === 0 && signing.length === 0, 'ORPHANED_ORDER_DATA'); return null; }
    const identity=token([scope,order,events,signing]);
    if(evidenceCache?.identity===identity){replaySnapshots.set(events,evidenceCache.orders);return order;}
    bounded(order);
    requireThat(fields.every(field => order[field] === scope[field]), 'ORDER_SCOPE_MISMATCH');
    requireThat(events.length === order.revision + 1 && events[0]?.type === 'create', 'CORRUPT_ORDER_HISTORY');
    const scopeToken=token(scope),eventTokens=events.map(token),cached=evidenceCache?.scopeToken===scopeToken?evidenceCache:null;
    let matched=0;while(matched<eventTokens.length&&cached?.eventTokens[matched]===eventTokens[matched])matched++;
    while(matched>0&&!cached.orders[matched-1])matched--;
    const orders=matched?cached.orders.slice(0,matched):[],prefixes=matched?cached.prefixes.slice(0,matched):[];
    if(!matched){const initial=bounded(structuredClone(events[0].order));
      requireThat(initial.revision===0&&!initial.paused&&initial.items.every(item=>!item.attempts.length),'CORRUPT_ORDER_HISTORY');
      orders.push(initial);prefixes.push(prefixHash('',eventTokens[0]));}
    for(let i=orders.length;i<events.length;i++){
      orders.push(model.transitionOrder(orders[i-1],events[i]));prefixes.push(prefixHash(prefixes[i-1],eventTokens[i]));
    }
    requireThat(equal(orders.at(-1),order),'CORRUPT_ORDER_HISTORY');
    replaySnapshots.set(events,orders);
    const validatedBatches=new Set();
    const batches=groups(signing);
    if(signing.length)requireThat(batches.length===order.items.reduce((n,item)=>n+item.attempts.length,0),'ASSET_CLAIM_HISTORY');
    for(const [i,records]of batches.entries()){
      const claim=records[0]?.record,previous=batches[i-1]?.[0]?.record;
      requireThat((i===0?claim.itemIndex===0&&claim.attempt===1:
        claim.itemIndex===previous.itemIndex?claim.attempt===previous.attempt+1:claim.itemIndex===previous.itemIndex+1&&claim.attempt===1)
        &&equal(Object.keys(records[0]).sort(),(claim.attempt===1?['phase','record']:['phase','record','replacement']).sort()),'ASSET_CLAIM_HISTORY');
      requireThat(equal(events[claim.orderRevision],{type:'prepare',revision:claim.orderRevision-1,index:claim.itemIndex,blockhash:claim.blockhash,
        lastValidBlockHeight:claim.lastValidBlockHeight,messageSha256:claim.messageSha256,...(claim.attempt===2?{retry:true}:{})}),'ASSET_CLAIM_HISTORY');
      const historical=atRevision(events,batches[i+1]?.[0]?.record.orderRevision-1,order);
      const batchToken=prefixes[historical.revision]+'|'+token([historical,records,...(claim.attempt===2?[batches[i-1]]:[])]);
      validatedBatches.add(batchToken);
      if(cached?.validatedBatches.has(batchToken))continue;
      prewalletState(historical,records,events);signingState(historical,records);walletState(historical,records,events);submissionState(historical,records,events);
      if(claim.attempt===2){
        validateReplacementClaim(historical,claim,records[0].replacement);
        const prior=atRevision(events,claim.orderRevision-1,order);
        const source=replacementState(prior,batches[i-1],events);
        requireThat(source&&['expired','failed'].includes(source.status)&&equal(records[0].replacement.prior,source.status==='failed'?source.failureRecord:source.expiryRecord)
          &&equal(records[0].replacement.prewallet,source.prewalletRecord)
          &&equal(records[0].replacement.responseExpiry,responseExpiryProvenance(source)),'REPLACEMENT_HISTORY');
      }
    }
    // Failed replay/signature validation never replaces the last valid cache.
    // Repeated pause/resume events do not retain a full order clone each. Keep
    // only revisions referenced by canonical signing records and the latest.
    const retained=new Set([0,order.revision]);
    for(const row of signing){const revision=row.record?.orderRevision;
      if(Number.isSafeInteger(revision)){retained.add(revision);retained.add(revision-1);}}
    const kept=orders.map((value,index)=>retained.has(index)?value:undefined);
    evidenceCache={identity,scopeToken,eventTokens,orders:kept,prefixes,validatedBatches};
    return order;
  }
  function validateKeys(order, records, scopeKey) {
    requireThat(records.length === order.quantity, 'ASSET_KEY_MISSING');
    for (const item of order.items) keyShape(records[item.index], scopeKey, item);
  }
  function validate(data, scope, scopeKey) {
    const order = validateEvidence(data, scope);
    if (order) validateKeys(order, data[1], scopeKey);
    return order;
  }
  async function proveKey(item, record, scopeKey) {
    keyShape(record, scopeKey, item);
    try {
      const pub = new Uint8Array(await crypto.subtle.exportKey('raw', record.publicKey));
      requireThat(pub.length === 32 && base58.deserialize(pub)[0] === item.asset, 'ASSET_KEY_MISMATCH');
      // Internal domain-separated random challenge. Never a caller's transaction.
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const prefix = new TextEncoder().encode(`CoolBears custody proof v1\n${scopeKey}\n${item.index}\n`);
      const challenge = new Uint8Array(prefix.length + nonce.length); challenge.set(prefix); challenge.set(nonce, prefix.length);
      const signature = await crypto.subtle.sign('Ed25519', record.privateKey, challenge);
      requireThat(await crypto.subtle.verify('Ed25519', record.publicKey, signature, challenge), 'ASSET_KEY_MISMATCH');
    } catch { throw Error('ASSET_KEY_MISMATCH'); }
  }
  async function proveKeys(order, records, scopeKey) {
    for (const item of order.items) await proveKey(item, records[item.index], scopeKey);
  }
  async function custodyState(order, records, scopeKey) {
    let code = null;
    try { validateKeys(order, records, scopeKey); } catch (error) { code = error.message; }
    const items = [];
    for (const item of order.items) {
      let problem = null;
      // IDB getAll compacts missing rows. Locate each retained key by its
      // canonical index instead of treating later keys as the missing one.
      const matches = records.filter(record => record?.index === item.index);
      try {
        requireThat(matches.length === 1, 'ASSET_KEY_MISSING');
        await proveKey(item, matches[0], scopeKey);
      } catch (error) { problem = error.message; }
      items.push({ index:item.index, asset:item.asset, status:problem ? 'unavailable' : 'available', code:problem });
      code ??= problem;
    }
    return { status:code ? 'unavailable' : 'available', code, items };
  }
  function groups(records){
    requireThat(records.length<=600,'CORRUPT_ASSET_SIGNING');const batches=[];
    for(const record of records){if(record?.phase==='claimed')batches.push([]);
      requireThat(batches.length>0&&batches.length<=100,'CORRUPT_ASSET_SIGNING');batches.at(-1).push(record);}
    return batches;
  }
  function atRevision(events,revision,fallback){
    if(!Number.isSafeInteger(revision))return fallback;
    requireThat(revision>=0&&revision<events.length,'CORRUPT_ORDER_HISTORY');
    const cached=replaySnapshots.get(events);if(cached?.[revision])return cached[revision];
    let start=revision;while(start>0&&!cached?.[start])start--;
    let order=cached?.[start]??events[0].order;
    for(let n=start+1;n<=revision;n++)order=model.transitionOrder(order,events[n]);return order;
  }
  const current=records=>groups(records).at(-1)??[];
  const hasPrewallet=records=>['prewallet-recovered','prewallet-expired'].includes(records.at(-1)?.phase);
  const hasResponseExpiry=records=>records.at(-1)?.phase==='response-expired';
  function responseExpiryState(order,records,events){
    records=current(records);if(!hasResponseExpiry(records))return null;
    const saved=records.at(-1),r=saved.record,claim=records[0]?.record;
    requireThat(records.length===4&&records[1]?.phase==='ready'&&records[2]?.phase==='wallet-claimed'
      &&equal(Object.keys(saved).sort(),['phase','record'])&&r?.version===1
      &&equal(Object.keys(r).sort(),['orderRevision','report','version'])
      &&Number.isSafeInteger(r.orderRevision)&&r.orderRevision>records[2].record.orderRevision
      &&r.orderRevision<=order.revision,'CORRUPT_RESPONSE_EXPIRY');
    const prior=atRevision(events,r.orderRevision-1,order);
    validateResponseExpiry(r.report,{order:prior,claim,request:records[1].record,walletClaim:records[2].record});
    const attempt=order.items[claim.itemIndex].attempts[claim.attempt-1];
    requireThat(r.report.status==='response-expired'&&attempt.state==='expired'&&attempt.signature===null
      &&equal(events[r.orderRevision],{type:'reconcile',revision:prior.revision,index:claim.itemIndex,attempt:claim.attempt,proof:r.report.proof}),
      'RESPONSE_EXPIRY_HISTORY');
    return{status:'expired',report:structuredClone(r.report),signature:null,orderRevision:r.orderRevision,
      retryAuthorized:false,readyToSubmit:false,salesOpen:false};
  }
  function prewalletState(order,records,events){
    records=current(records);if(!hasPrewallet(records))return null;
    const saved=records.at(-1),r=saved.record,claim=records[0]?.record,ready=records[1]?.phase==='ready'?records[1]:null;
    requireThat(records.length===(ready?3:2)&&equal(Object.keys(saved).sort(),['phase','record'])
      &&r?.version===1&&equal(Object.keys(r).sort(),['orderRevision','report','version'])
      &&Number.isSafeInteger(r.orderRevision)&&r.orderRevision>claim.orderRevision&&r.orderRevision<=order.revision,'CORRUPT_PREWALLET_RECOVERY');
    const prior=atRevision(events,r.orderRevision-1,order);
    const expired=saved.phase==='prewallet-expired';
    (expired?validatePrewalletExpiry:validatePrewalletRecovery)(r.report,{order:prior,claim,request:ready?.record??null});
    const result=expired?{status:'expired',proof:r.report.proof}:r.report.result;
    requireThat(r.report.status===saved.phase&&order.items[claim.itemIndex].attempts[claim.attempt-1].state===result.status
      &&equal(events[r.orderRevision],{type:'reconcile',revision:prior.revision,index:claim.itemIndex,attempt:claim.attempt,proof:result.proof}),'PREWALLET_HISTORY');
    return{status:result.status,report:structuredClone(r.report),
      ...(result.status==='failed'?{feeLamports:r.report.result.evidence.feeLamports}:{}),
      retryAuthorized:false,readyToSubmit:false,salesOpen:false};
  }
  function signingState(order, records) {
    records=current(records);
    requireThat(records.length <= 6, 'CORRUPT_ASSET_SIGNING');
    if (!records.length) return null;
    const claimed=records[0],ready=records[1]?.phase==='ready'?records[1]:undefined,closed=hasPrewallet(records)||hasResponseExpiry(records);
    requireThat(claimed?.phase === 'claimed' && (!records[1]||ready||closed), 'CORRUPT_ASSET_SIGNING');
    validateAssetClaim(order, claimed.record);
    if (ready) validateAssetRequest(order, claimed.record, ready.record);
    return { status:closed?'asset-signing-reconciled':ready ? 'asset-partial-saved' : 'asset-signing-unknown',
      claim: structuredClone(claimed.record), request: ready ? structuredClone(ready.record) : null,
      mode: `offline-${network.cluster}-asset-signing`, networkVerified: false, blockhashVerified: false, guardPriceVerified: false,
      readyToSign: false, readyToSubmit: false, salesOpen: false };
  }
  function walletState(order, records, events) {
    records=current(records);
    if(hasPrewallet(records))return null;
    if (records.length < 3) return null;
    const assetClaim=records[0].record,number=assetClaim.attempt;
    const claim = records[2]?.record, expired=hasResponseExpiry(records),response = expired?undefined:records[3]?.record;
    const shape = (value, names) => value && equal(Object.keys(value).sort(), names.split(' ').sort());
    requireThat(records[2]?.phase === 'wallet-claimed'
      && ((claim.version===1&&shape(claim,'version claimId requestId orderRevision'))
        ||(claim.version===2&&shape(claim,'version claimId requestId orderRevision costApproval')))
      && /^[a-f0-9]{64}$/.test(claim.claimId) && claim.requestId === buyerRequestId(records[1].record)
      && claim.orderRevision === assetClaim.orderRevision+1 && order.revision >= claim.orderRevision, 'CORRUPT_WALLET_CLAIM');
    if(claim.version===2)validateCostApproval(claim.costApproval,{order,claim:records[0].record,request:records[1].record});
    requireThat(equal(events[claim.orderRevision], {type:'unknown',revision:assetClaim.orderRevision,index:assetClaim.itemIndex,attempt:number}), 'WALLET_CLAIM_HISTORY');
    if (response) {
      requireThat(records[3].phase === 'buyer-response'
        && shape(response, 'version claimId orderRevision transactionBase64 signature messageSha256')
        && response.version === 1 && response.claimId === claim.claimId
        && Number.isSafeInteger(response.orderRevision) && response.orderRevision > claim.orderRevision
        && response.orderRevision <= order.revision, 'CORRUPT_BUYER_RESPONSE');
      const before=atRevision(events,response.orderRevision-1,order);
      const verified = verifyBuyerSigningResponse(before, records[0].record, records[1].record,
        {transactionBase64:response.transactionBase64});
      requireThat(verified.signature === response.signature && verified.messageSha256 === response.messageSha256
        && equal(events[response.orderRevision], {type:'signature',revision:before.revision,index:assetClaim.itemIndex,attempt:number,
          signature:response.signature,messageSha256:response.messageSha256}), 'BUYER_RESPONSE_HISTORY');
    }
    if(expired)responseExpiryState(order,records,events);
    else if(!response)requireThat(records.length===3&&order.items[assetClaim.itemIndex].attempts[number-1].state==='unknown'
      &&order.items[assetClaim.itemIndex].attempts[number-1].signature===null,'MISSING_RESPONSE_HISTORY');
    return {status:expired?'response-expired':response ? 'buyer-response-saved' : 'wallet-response-unknown',
      claim:structuredClone(claim), response:response ? structuredClone(response) : null,
      readyToSign:false, readyToSubmit:false, salesOpen:false};
  }
  function submissionState(order,records,events) {
    records=current(records);
    const wallet=walletState(order,records,events);
    if(!wallet?.response)return null;
    const input={order:structuredClone(order),claim:structuredClone(records[0].record),request:structuredClone(records[1].record),
      response:{transactionBase64:wallet.response.transactionBase64}};
    const number=input.claim.attempt;let expiryEvidence=null,failureEvidence=null;
    const terminalPhases=['expiry-reviewed','failure-reviewed'],reviewType=records.at(-1)?.phase;
    const reviewed=terminalPhases.includes(reviewType)?records.at(-1).record:null;
    const sendClaim=terminalPhases.includes(records[4]?.phase)?null:records[4]?.record;
    if(sendClaim){
      requireThat(records[4].phase==='send-claimed'&&equal(Object.keys(sendClaim).sort(),
        ['version','claimId','orderRevision','transactionSha256','signature'].sort())&&sendClaim.version===1
        &&/^[a-f0-9]{64}$/.test(sendClaim.claimId)&&sendClaim.signature===wallet.response.signature
        &&sendClaim.transactionSha256===signedBytesId(wallet.response.transactionBase64)
        &&Number.isSafeInteger(sendClaim.orderRevision)&&sendClaim.orderRevision>wallet.response.orderRevision
        &&sendClaim.orderRevision<=order.revision,'CORRUPT_SEND_CLAIM');
      requireThat(equal(events[sendClaim.orderRevision],{type:'unknown',revision:sendClaim.orderRevision-1,index:input.claim.itemIndex,attempt:number}),'SEND_CLAIM_HISTORY');
      const prior=atRevision(events,sendClaim.orderRevision-1,order);
      requireThat(!prior.paused,'SEND_CLAIM_HISTORY');validateBuyerSubmission({...input,order:prior});
    }
    const outcome=order.items[input.claim.itemIndex].attempts[number-1].state;
    requireThat(records.length===(sendClaim?5:4)+(reviewed?1:0),'CORRUPT_EXPIRY_REVIEW');
    if(reviewed){
      const expected=reviewType==='expiry-reviewed'?'expired':'failed';
      requireThat(records.length===(sendClaim?6:5)&&equal(Object.keys(reviewed).sort(),['version','orderRevision','report'].sort())
        &&reviewed.version===1&&Number.isSafeInteger(reviewed.orderRevision)&&reviewed.orderRevision>wallet.response.orderRevision
        &&reviewed.orderRevision<=order.revision&&outcome===expected,'CORRUPT_EXPIRY_REVIEW');
      const prior=atRevision(events,reviewed.orderRevision-1,order);
      if(expected==='expired'){
        validateBuyerExpiryResult(reviewed.report,{...input,order:prior});expiryEvidence=expiryRecord({...input,order:prior},reviewed.report);
      }else failureEvidence=failureRecord({...input,order:prior},reviewed.report);
      requireThat(reviewed.report.status===expected&&equal(events[reviewed.orderRevision],
        {type:'reconcile',revision:prior.revision,index:input.claim.itemIndex,attempt:number,proof:reviewed.report.proof}),'EXPIRY_REVIEW_HISTORY');
    }
    requireThat(!['expired','failed'].includes(outcome)||reviewed,'TERMINAL_REVIEW_REQUIRED');
    return {status:['verified','expired','failed'].includes(outcome)?outcome:sendClaim?'send-claimed':'ready',
      input,expiryRecord:expiryEvidence,failureRecord:failureEvidence,costApproval:wallet.claim.costApproval?structuredClone(wallet.claim.costApproval):null,sendClaim:sendClaim?structuredClone(sendClaim):null,readyToSubmit:false,salesOpen:false};
  }
  function costSummary(saved){
    const {order,signing}=saved;if(!order)return null;
    requireThat(!order.items.some(item=>item.attempts.length)||signing.length>0,'ASSET_CLAIM_HISTORY');
    const failures=[];
    for(const records of groups(signing)){
      const claim=records[0].record,last=records.at(-1);
      const report=last.phase==='failure-reviewed'?last.record.report:
        last.phase==='prewallet-recovered'&&last.record.report.result.status==='failed'?last.record.report.result:null;
      if(report)failures.push({itemIndex:claim.itemIndex,attempt:claim.attempt,feeLamports:report.evidence.feeLamports});
    }
    const index=currentItemIndex(order),verified=index??order.quantity;
    const records=current(signing),claim=records[0]?.record;
    const quote=claim?.itemIndex===index?records.find(record=>record.phase==='wallet-claimed')?.record.costApproval?.quote:null;
    return {quantity:order.quantity,verified,remaining:order.quantity-verified,currentItemIndex:index,
      verifiedItemPriceLamports:(BigInt(order.unitPriceLamports)*BigInt(verified)).toString(),
      knownFailedFeesLamports:failures.reduce((sum,row)=>sum+BigInt(row.feeLamports),0n).toString(),failedAttempts:failures,
      approvedCurrentTemplate:quote?{quoteId:quote.quoteId,issuedAt:quote.issuedAt,expiresAt:quote.expiresAt,
        totalLamports:quote.budget.totalLamports,projectedRemainingTotalLamports:
          (BigInt(quote.budget.totalLamports)*BigInt(order.quantity-verified)).toString(),projectionOnly:true}:null,
      successfulTransactionFeesLamports:null,actualOrderTotalLamports:null,
      nextItemRequiresFreshQuote:index!==null,readyToSubmit:false,salesOpen:false};
  }
  async function snapshotData(scope, scopeKey) {
    const data = await transaction('readonly', (tx, resolve, abort) => load(tx, scopeKey, resolve, abort));
    const order = validate(data, scope, scopeKey);
    if (order) await proveKeys(order, data[1], scopeKey);
    return { order, keys: data[1], events: data[2], signing: data[3] };
  }
  function responseRecoveryState(saved){
    if(!saved.order)return null;
    const records=current(saved.signing),wallet=walletState(saved.order,records,saved.events);
    if(!wallet)return null;
    if(wallet.status==='response-expired')return responseExpiryState(saved.order,records,saved.events);
    if(wallet.response){
      const state=submissionState(saved.order,records,saved.events);
      return ['verified','failed'].includes(state.status)?{status:state.status,
        ...(state.status==='failed'?{feeLamports:state.failureRecord.evidence.feeLamports}:{})}:null;
    }
    const input={order:structuredClone(saved.order),claim:structuredClone(records[0].record),
      request:structuredClone(records[1].record),walletClaim:structuredClone(wallet.claim)};
    validateMissingBuyerResponse(input);return{status:'wallet-response-unknown',input};
  }
  function prewalletRecoveryState(saved){
    if(!saved.order)return null;
    const records=current(saved.signing),terminal=prewalletState(saved.order,records,saved.events);
    if(terminal)return terminal;
    if(!records.length||records.length>2)return null;
    const input={order:structuredClone(saved.order),claim:structuredClone(records[0].record),request:records[1]?.record?structuredClone(records[1].record):null};
    validatePrewalletInput(input);return{status:'prewallet-unknown',input};
  }
  async function snapshot(scope, scopeKey) { return (await snapshotData(scope, scopeKey)).order; }
  function replacementState(order,records,events){
    records=current(records);
    const responseExpired=hasResponseExpiry(records);
    if(!hasPrewallet(records)&&!responseExpired)return submissionState(order,records,events);
    const terminal=responseExpired?responseExpiryState(order,records,events):prewalletState(order,records,events);
    if(!['expired','failed'].includes(terminal.status)||records[0].record.attempt!==1)return null;
    const prior=structuredClone(order);prior.items[records[0].record.itemIndex].attempts=prior.items[records[0].record.itemIndex].attempts.slice(0,1);
    if(order.items[records[0].record.itemIndex].attempts.length>1)prior.revision=records.at(-1).record.orderRevision;
    if(responseExpired)return responseExpiryReplacementSource(prior,records[0].record,terminal.report,records[1].record,records[2].record);
    return terminal.status==='expired'
      ?prewalletExpiryReplacementSource(prior,records[0].record,terminal.report,records[1]?.phase==='ready'?records[1].record:null)
      :prewalletReplacementSource(prior,records[0].record,terminal.report);
  }
  async function locked(input, action) {
    requireCapabilities();
    const scope = checkedScope(structuredClone(input)), scopeKey = JSON.stringify(scope);
    return locks.request(`coolbears:buyer-order:v1:${scopeKey}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
      requireThat(lock, 'ORDER_BUSY');
      return action(scope, scopeKey);
    });
  }
  function savePrewalletTerminal(input,report,expired){
    const frozen=structuredClone(report);
    return locked(input,async(scope,scopeKey)=>{
      const before=await snapshotData(scope,scopeKey),state=prewalletRecoveryState(before);
      requireThat(state?.status==='prewallet-unknown','PREWALLET_REQUIRED');
      (expired?validatePrewalletExpiry:validatePrewalletRecovery)(frozen,state.input);
      requireThat(frozen.status===(expired?'prewallet-expired':'prewallet-recovered'),'PREWALLET_NOT_VERIFIED');
      const retained=nativeResults.get(scopeKey);
      if(retained&&!expired)requireThat(equal(retained.request,prewalletSubmission(state.input,frozen.response).request),'ASSET_REQUEST_CONFLICT');
      const number=state.input.claim.attempt,event={type:'reconcile',revision:before.order.revision,index:state.input.claim.itemIndex,attempt:number,proof:expired?frozen.proof:frozen.result.proof};
      const order=bounded(model.transitionOrder(before.order,event));
      const record={phase:expired?'prewallet-expired':'prewallet-recovered',record:{version:1,orderRevision:order.revision,report:frozen}};
      await transaction('readwrite',(tx,resolve,abort)=>load(tx,scopeKey,data=>{
        requireThat(equal(validate(data,scope,scopeKey),before.order)&&equal(data[3],before.signing),'STALE_REVISION');
        tx.objectStore('events').add(event,[scopeKey,order.revision]);tx.objectStore('orders').put(order,scopeKey);
        tx.objectStore('signing').add(record,[scopeKey,state.input.claim.itemIndex,number,6]);resolve(true);
      },abort));
      const after=await snapshotData(scope,scopeKey);
      requireThat(equal(after.order,order)&&equal(after.signing,[...before.signing,record]),'PREWALLET_NOT_SAVED');
      nativeResults.delete(scopeKey);nativeSlots.delete(scopeKey);
      return prewalletRecoveryState(after);
    });
  }
  // Trusted adapter only. Evidence + unchanged order/event CAS; never a retry grant.
  function saveProof(input,report,outcome='verified'){
    const frozen=structuredClone(report),expiry=outcome==='expired',failed=outcome==='failed';
    return locked(input,async(scope,scopeKey)=>{
      const before=await snapshotData(scope,scopeKey),state=before.order&&submissionState(before.order,before.signing,before.events);
      requireThat(state&&!['verified','expired','failed'].includes(state.status),'RECOVERY_STATE');
      if(expiry)validateBuyerExpiryResult(frozen,state.input);else validateBuyerResult(frozen,state.input,{recovery:true});
      requireThat(frozen.status===outcome,'RECOVERY_NOT_VERIFIED');
      const number=state.input.claim.attempt;
      const event={type:'reconcile',revision:before.order.revision,index:state.input.claim.itemIndex,attempt:number,proof:frozen.proof};
      const order=bounded(model.transitionOrder(before.order,event));
      const record=expiry||failed?{phase:expiry?'expiry-reviewed':'failure-reviewed',record:{version:1,orderRevision:order.revision,report:frozen}}:null;
      await transaction('readwrite',(tx,resolve,abort)=>load(tx,scopeKey,data=>{
        requireThat(equal(validate(data,scope,scopeKey),before.order)&&equal(data[3],before.signing),'STALE_REVISION');
        tx.objectStore('events').add(event,[scopeKey,order.revision]);tx.objectStore('orders').put(order,scopeKey);
        if(record)tx.objectStore('signing').add(record,[scopeKey,state.input.claim.itemIndex,number,5]);resolve(true);
      },abort));
      const after=await snapshotData(scope,scopeKey);
      requireThat(equal(after.order,order)&&equal(after.signing,record?[...before.signing,record]:before.signing),'PROOF_NOT_SAVED');
      return {status:outcome,signature:order.items[state.input.claim.itemIndex].attempts[number-1].signature,orderRevision:order.revision,
        ...(expiry||failed?{retryAuthorized:false}:{}),...(failed?{feeLamports:frozen.evidence.feeLamports}:{}),readyToSubmit:false,salesOpen:false};
    });
  }
  async function persistNativeResult(scope,scopeKey,saved,retained){
    const records=current(saved.signing),claim=records[0]?.record;
    requireThat(equal(records[0],retained.claimed),'ASSET_CLAIM_CHANGED');
    validateAssetRequest(saved.order,claim,retained.request);
    if(records[1]){
      // A lost commit acknowledgment, or a later wallet step, is read-only.
      requireThat(equal(records[1],{phase:'ready',record:retained.request}),'ASSET_REQUEST_CONFLICT');
    }else{
      requireThat(records.length===1&&saved.order.items[claim.itemIndex].attempts.at(-1)?.state==='wallet-pending','ASSET_CLAIM_CHANGED');
      await transaction('readwrite',(tx,resolve,abort)=>load(tx,scopeKey,data=>{
        requireThat(equal(validate(data,scope,scopeKey),saved.order)&&equal(data[3],saved.signing),'ASSET_CLAIM_CHANGED');
        tx.objectStore('signing').add({phase:'ready',record:retained.request},[scopeKey,claim.itemIndex,claim.attempt,1]);resolve(true);
      },abort));
      const after=await snapshotData(scope,scopeKey);
      requireThat(equal(after.order,saved.order)&&equal(after.signing,[...saved.signing,{phase:'ready',record:retained.request}]),'ASSET_REQUEST_NOT_SAVED');
      saved=after;
    }
    // Never discard the only retained result until durable bytes were read back.
    nativeResults.delete(scopeKey);
    nativeSlots.delete(scopeKey);
    return signingState(saved.order,saved.signing);
  }
  async function prepareSigning(input,candidate,replacementReport,acknowledgedFeeLamports){
      const frozen=structuredClone(candidate),report=replacementReport&&structuredClone(replacementReport);
      return locked(input, async (scope, scopeKey) => {
        const before = await snapshotData(scope, scopeKey);
        requireThat(before.order, 'MISSING_ORDER');
        requireThat(!before.order.items.some(item=>item.attempts.length)||before.signing.length>0,'ASSET_CLAIM_HISTORY');
        requireThat(frozen?.orderRevision===before.order.revision,'STALE_REVISION');
        if(report){
          const source=replacementState(before.order,before.signing,before.events);
          requireThat(source&&['expired','failed'].includes(source.status)&&source.input.claim.attempt===1,'REPLACEMENT_NOT_READY');
          const prior=source.status==='failed'?source.failureRecord:source.expiryRecord;
          validateReplacementResult(report,source.input);requireThat(equal(report.record.prior,prior)
            &&equal(report.record.prewallet,source.prewalletRecord)
            &&equal(report.record.responseExpiry,responseExpiryProvenance(source)),'REPLACEMENT_HISTORY');
          validateReplacementAcknowledgment(source.input,prior,acknowledgedFeeLamports);
        }else requireThat(currentItemIndex(before.order)===frozen.itemIndex
          &&!groups(before.signing).some(records=>records[0].record.itemIndex===frozen.itemIndex),'ASSET_SIGNING_EXISTS');
        requireThat(!nativeSlots.has(scopeKey)&&nativeSlots.size<MAX_NATIVE_RESULTS,'NATIVE_RESULTS_PENDING');
        const prepared = prepareAssetClaim(before.order, frozen),number=prepared.claim.attempt;
        requireThat(number===(report?2:1),'REPLACEMENT_NOT_READY');
        bounded(prepared.order);
        const claimed = { phase: 'claimed', record: prepared.claim,...(report?{replacement:report.record}:{}) };
        nativeSlots.add(scopeKey);
        try {
          await transaction('readwrite', (tx, resolve, abort) => load(tx, scopeKey, data => {
            requireThat(equal(validate(data, scope, scopeKey), before.order) && equal(data[3],before.signing), 'STALE_REVISION');
            tx.objectStore('events').add(prepared.event, [scopeKey, prepared.order.revision]);
            tx.objectStore('orders').put(prepared.order, scopeKey);
            tx.objectStore('signing').add(claimed, [scopeKey, prepared.claim.itemIndex, number, 0]);
            resolve(true);
          }, abort));
          // Native signing starts only after the intent has committed and been read back.
          const saved = await snapshotData(scope, scopeKey);
          requireThat(equal(saved.order, prepared.order) && equal(saved.signing, [...before.signing,claimed]), 'ASSET_CLAIM_CHANGED');
          const message = validateAssetClaim(saved.order, prepared.claim);
          let signature;
          try { signature = new Uint8Array(await crypto.subtle.sign('Ed25519', saved.keys[prepared.claim.itemIndex].privateKey, message)); }
          catch { throw Error('ASSET_SIGNING_FAILED'); }
          const request = finalizeAssetRequest(saved.order, prepared.claim, signature);
          const retained=structuredClone({claimed,request});nativeResults.set(scopeKey,retained);
          return await persistNativeResult(scope,scopeKey,saved,retained);
        } finally { if(!nativeResults.has(scopeKey))nativeSlots.delete(scopeKey); }
      });
  }
  return {
    async create(input) {
      const frozen = structuredClone(input);
      return locked(frozen, async (scope, scopeKey) => {
        const quantity = frozen.quantity, available = frozen.available;
        requireThat(Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= policy.maxPerOrder && Number.isSafeInteger(available) && available >= quantity && available < policy.supply, 'INVALID_QUANTITY');
        requireThat(await snapshot(scope, scopeKey) === null, 'ORDER_EXISTS');
        const records = [];
        try {
          for (let index = 0; index < quantity; index++) {
            const pair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
            const asset = base58.deserialize(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))[0];
            records.push({ version: 1, scopeKey, index, asset, privateKey: pair.privateKey, publicKey: pair.publicKey });
          }
        } catch { throw Error('ASSET_KEY_UNSUPPORTED'); }
        const order = bounded(model.createOrder({ ...scope, quantity, available, assets: records.map(record => record.asset) }));
        await proveKeys(order, records, scopeKey);
        await transaction('readwrite', (tx, resolve, abort) => load(tx, scopeKey, data => {
          requireThat(validate(data, scope, scopeKey) === null, 'ORDER_EXISTS');
          tx.objectStore('orders').add(order, scopeKey);
          records.forEach(record => tx.objectStore('keys').add(record, [scopeKey, record.index]));
          tx.objectStore('events').add({ type: 'create', order }, [scopeKey, 0]);
          resolve(order);
        }, abort));
        // A completed write is not enough: re-read and prove cloned CryptoKeys.
        const persisted = await snapshot(scope, scopeKey);
        requireThat(equal(persisted, order), 'ORDER_NOT_SAVED');
        return persisted;
      });
    },
    read(input) { return locked(input, snapshot); },
    readCostSummary(input) { return locked(input,async(scope,scopeKey)=>costSummary(await snapshotData(scope,scopeKey))); },
    // Evidence-only inspection. Never repairs keys, persists recovered data,
    // invokes a transaction signer or grants permission to continue purchasing.
    readRecoverySnapshot(input) {
      return locked(input, async (scope, scopeKey) => {
        const data = await transaction('readonly', (tx, resolve, abort) => load(tx, scopeKey, resolve, abort));
        const order = validateEvidence(data, scope);
        if (!order) return null;
        // Generic journal primitives can retain model events without native
        // signing rows. Such an attempt is not complete recovery evidence.
        requireThat(!order.items.some(item => item.attempts.length) || data[3].length > 0, 'ASSET_CLAIM_HISTORY');
        const saved = { order, events:data[2], signing:data[3] };
        const evidence = { assetSigning:signingState(order, saved.signing),
          buyerWallet:walletState(order, saved.signing, saved.events),
          submission:submissionState(order, saved.signing, saved.events),
          responseRecovery:responseRecoveryState(saved), prewalletRecovery:prewalletRecoveryState(saved) };
        return { mode:'read-only-recovery', order:structuredClone(order), ...evidence,
          custody:await custodyState(order, data[1], scopeKey), readOnly:true,
          readyToSign:false, readyToSubmit:false, retryAuthorized:false, salesOpen:false, transactionsSent:0 };
      });
    },
    async append(input, event) {
      const frozen = structuredClone(event);
      requireThat(new TextEncoder().encode(JSON.stringify(frozen)).length <= 16384, 'EVENT_STORAGE_LIMIT');
      return locked(input, async (scope, scopeKey) => {
        const before = await snapshot(scope, scopeKey);
        requireThat(before, 'MISSING_ORDER');
        requireThat(frozen?.revision === before.revision, 'STALE_REVISION');
        const next = bounded(model.transitionOrder(before, frozen));
        await transaction('readwrite', (tx, resolve, abort) => load(tx, scopeKey, data => {
          requireThat(data[3].length===0||['pause','resume'].includes(frozen.type),'SIGNING_HISTORY_ADAPTER_REQUIRED');
          const current = validate(data, scope, scopeKey);
          requireThat(equal(current, before), 'STALE_REVISION');
          tx.objectStore('events').add(frozen, [scopeKey, next.revision]);
          tx.objectStore('orders').put(next, scopeKey);
          resolve(next);
        }, abort));
        const persisted = await snapshot(scope, scopeKey);
        requireThat(equal(persisted, next), 'ORDER_NOT_SAVED');
        return persisted;
      });
    },
    prepareAssetSigning(input,candidate){return prepareSigning(input,candidate);},
    prepareReplacementSigning(input,report,{authorizeReplacementSigning=false,acknowledgedFeeLamports}={}){
      requireThat(authorizeReplacementSigning===true,'EXPLICIT_REPLACEMENT_SIGNING_REQUIRED');
      const frozen=structuredClone(report);return prepareSigning(input,frozen?.candidate,frozen,acknowledgedFeeLamports);
    },
    readAssetSigning(input) {
      return locked(input, async (scope, scopeKey) => {
        const current = await snapshotData(scope, scopeKey);
        return current.order ? signingState(current.order, current.signing) : null;
      });
    },
    // Recover the exact original result only; this never calls the transaction
    // signer, invokes a wallet, refreshes a hash or changes the order/events.
    recoverAssetSigning(input) {
      return locked(input,async(scope,scopeKey)=>{
        const saved=await snapshotData(scope,scopeKey);
        if(!saved.order)return null;
        if(hasPrewallet(current(saved.signing))||hasResponseExpiry(current(saved.signing))){
          nativeResults.delete(scopeKey);nativeSlots.delete(scopeKey);
          return signingState(saved.order,saved.signing);
        }
        const retained=nativeResults.get(scopeKey);
        return retained?persistNativeResult(scope,scopeKey,saved,retained):signingState(saved.order,saved.signing);
      });
    },
    // Consume the single wallet invocation before opening it. The order becomes
    // unknown immediately; a later signature is evidence, never a send grant.
    claimBuyerWallet(input, {orderRevision, requestId, costApproval} = {}) {
      const approval=structuredClone(costApproval);
      return locked(input, async (scope, scopeKey) => {
        const before = await snapshotData(scope, scopeKey);
        const records=current(before.signing),assetClaim=records[0]?.record,number=assetClaim?.attempt;
        requireThat(before.order?.revision===orderRevision&&orderRevision===assetClaim?.orderRevision,'STALE_REVISION');
        requireThat(!before.order.paused && records.length === 2
          && before.order.items[assetClaim.itemIndex].attempts[number-1].state === 'wallet-pending'
          && requestId === buyerRequestId(records[1].record), 'WALLET_NOT_READY');
        validateCostApproval(approval,{order:before.order,claim:records[0].record,request:records[1].record},{now:Date.now()});
        const event = {type:'unknown',revision:orderRevision,index:assetClaim.itemIndex,attempt:number};
        const order = bounded(model.transitionOrder(before.order, event));
        const claimId = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2,'0')).join('');
        const claimed = {phase:'wallet-claimed',record:{version:2,claimId,requestId,orderRevision:order.revision,costApproval:approval}};
        await transaction('readwrite', (tx, resolve, abort) => load(tx, scopeKey, data => {
          requireThat(equal(validate(data, scope, scopeKey), before.order) && equal(data[3], before.signing), 'STALE_REVISION');
          tx.objectStore('events').add(event, [scopeKey, order.revision]);
          tx.objectStore('orders').put(order, scopeKey);
          tx.objectStore('signing').add(claimed, [scopeKey,assetClaim.itemIndex,number,2]); resolve(true);
        }, abort));
        const after = await snapshotData(scope, scopeKey);
        requireThat(equal(after.order, order) && equal(after.signing, [...before.signing,claimed]), 'WALLET_CLAIM_NOT_SAVED');
        return walletState(after.order, after.signing, after.events);
      });
    },
    saveBuyerResponse(input, response) {
      const frozen = structuredClone(response);
      requireThat(frozen && equal(Object.keys(frozen).sort(), ['claimId','transactionBase64'])
        && typeof frozen.transactionBase64 === 'string' && frozen.transactionBase64.length <= 1644, 'BUYER_RESPONSE_FIELDS');
      return locked(input, async (scope, scopeKey) => {
        const before = await snapshotData(scope, scopeKey);
        const records=current(before.signing),number=records[0]?.record?.attempt;
        requireThat(before.order && records.length >= 3, 'WALLET_CLAIM_REQUIRED');
        const state = walletState(before.order, before.signing, before.events);
        requireThat(state,'WALLET_CLAIM_REQUIRED');
        requireThat(frozen.claimId === state.claim.claimId, 'WALLET_CLAIM_MISMATCH');
        requireThat(state.status!=='response-expired','RESPONSE_EXPIRED');
        if (state.response) {
          requireThat(state.response.transactionBase64 === frozen.transactionBase64, 'BUYER_RESPONSE_CONFLICT');
          return state; // Lost commit acknowledgment: read the same bytes, no event.
        }
        const verified = verifyBuyerSigningResponse(before.order, records[0].record, records[1].record,
          {transactionBase64:frozen.transactionBase64});
        const event = {type:'signature',revision:before.order.revision,index:records[0].record.itemIndex,attempt:number,
          signature:verified.signature,messageSha256:verified.messageSha256};
        const order = bounded(model.transitionOrder(before.order, event));
        const saved = {phase:'buyer-response',record:{version:1,claimId:frozen.claimId,orderRevision:order.revision,
          transactionBase64:verified.transactionBase64,signature:verified.signature,messageSha256:verified.messageSha256}};
        await transaction('readwrite', (tx, resolve, abort) => load(tx, scopeKey, data => {
          requireThat(equal(validate(data, scope, scopeKey), before.order) && equal(data[3], before.signing), 'STALE_REVISION');
          tx.objectStore('events').add(event, [scopeKey, order.revision]);
          tx.objectStore('orders').put(order, scopeKey);
          tx.objectStore('signing').add(saved, [scopeKey,records[0].record.itemIndex,number,3]); resolve(true);
        }, abort));
        const after = await snapshotData(scope, scopeKey);
        requireThat(equal(after.order, order) && equal(after.signing, [...before.signing,saved]), 'BUYER_RESPONSE_NOT_SAVED');
        return walletState(after.order, after.signing, after.events);
      });
    },
    readBuyerResponseRecovery(input){
      return locked(input,async(scope,scopeKey)=>responseRecoveryState(await snapshotData(scope,scopeKey)));
    },
    readBuyerResponseReplacement(input){
      return locked(input,async(scope,scopeKey)=>{
        const saved=await snapshotData(scope,scopeKey);
        if(!saved.order||saved.order.items[current(saved.signing)[0]?.record.itemIndex]?.attempts.length!==1||!hasResponseExpiry(current(saved.signing)))return null;
        return replacementState(saved.order,saved.signing,saved.events);
      });
    },
    // Expiry evidence consumes no wallet response and grants no replacement/send permission.
    saveBuyerResponseExpiry(input,report){
      const frozen=structuredClone(report);
      return locked(input,async(scope,scopeKey)=>{
        const before=await snapshotData(scope,scopeKey),state=responseRecoveryState(before);
        requireThat(state?.status==='wallet-response-unknown','MISSING_RESPONSE_REQUIRED');
        validateResponseExpiry(frozen,state.input);requireThat(frozen.status==='response-expired','RESPONSE_EXPIRY_NOT_VERIFIED');
        const number=state.input.claim.attempt,event={type:'reconcile',revision:before.order.revision,index:state.input.claim.itemIndex,attempt:number,proof:frozen.proof};
        const order=bounded(model.transitionOrder(before.order,event));
        const record={phase:'response-expired',record:{version:1,orderRevision:order.revision,report:frozen}};
        await transaction('readwrite',(tx,resolve,abort)=>load(tx,scopeKey,data=>{
          requireThat(equal(validate(data,scope,scopeKey),before.order)&&equal(data[3],before.signing),'STALE_REVISION');
          tx.objectStore('events').add(event,[scopeKey,order.revision]);tx.objectStore('orders').put(order,scopeKey);
          tx.objectStore('signing').add(record,[scopeKey,state.input.claim.itemIndex,number,6]);resolve(true);
        },abort));
        const after=await snapshotData(scope,scopeKey);
        requireThat(equal(after.order,order)&&equal(after.signing,[...before.signing,record]),'RESPONSE_EXPIRY_NOT_SAVED');
        nativeResults.delete(scopeKey);nativeSlots.delete(scopeKey);
        return responseRecoveryState(after);
      });
    },
    readPrewalletRecovery(input){
      return locked(input,async(scope,scopeKey)=>{
        const state=prewalletRecoveryState(await snapshotData(scope,scopeKey));
        if(['verified','failed','expired'].includes(state?.status)){nativeResults.delete(scopeKey);nativeSlots.delete(scopeKey);}
        return state;
      });
    },
    savePrewalletRecovery(input,report){
      return savePrewalletTerminal(input,report,false);
    },
    savePrewalletExpiry(input,report){
      return savePrewalletTerminal(input,report,true);
    },
    readPrewalletReplacement(input){
      return locked(input,async(scope,scopeKey)=>{
        const saved=await snapshotData(scope,scopeKey);
        if(!saved.order||saved.order.items[current(saved.signing)[0]?.record.itemIndex]?.attempts.length!==1||!hasPrewallet(current(saved.signing)))return null;
        return replacementState(saved.order,saved.signing,saved.events);
      });
    },
    // Both events and all evidence commit together; a discovered response is never sendable.
    saveRecoveredBuyerResponse(input,report){
      const frozen=structuredClone(report);
      return locked(input,async(scope,scopeKey)=>{
        const before=await snapshotData(scope,scopeKey),state=responseRecoveryState(before);
        requireThat(state?.status==='wallet-response-unknown','MISSING_RESPONSE_REQUIRED');
        validateResponseRecovery(frozen,state.input);requireThat(frozen.status==='response-recovered','RESPONSE_NOT_VERIFIED');
        const recovered=recoveredSubmission(state.input,frozen.response),number=state.input.claim.attempt;
        const event={type:'reconcile',revision:recovered.input.order.revision,index:state.input.claim.itemIndex,attempt:number,proof:frozen.result.proof};
        const order=bounded(model.transitionOrder(recovered.input.order,event));
        const response={phase:'buyer-response',record:{version:1,claimId:state.input.walletClaim.claimId,
          orderRevision:recovered.input.order.revision,transactionBase64:frozen.response.transactionBase64,
          signature:recovered.event.signature,messageSha256:recovered.event.messageSha256}};
        const failure=frozen.result.status==='failed'?{phase:'failure-reviewed',record:{version:1,orderRevision:order.revision,report:frozen.result}}:null;
        await transaction('readwrite',(tx,resolve,abort)=>load(tx,scopeKey,data=>{
          requireThat(equal(validate(data,scope,scopeKey),before.order)&&equal(data[3],before.signing),'STALE_REVISION');
          tx.objectStore('events').add(recovered.event,[scopeKey,recovered.input.order.revision]);
          tx.objectStore('events').add(event,[scopeKey,order.revision]);tx.objectStore('orders').put(order,scopeKey);
          tx.objectStore('signing').add(response,[scopeKey,state.input.claim.itemIndex,number,3]);
          if(failure)tx.objectStore('signing').add(failure,[scopeKey,state.input.claim.itemIndex,number,5]);resolve(true);
        },abort));
        const after=await snapshotData(scope,scopeKey);
        requireThat(equal(after.order,order)&&equal(after.signing,[...before.signing,response,...(failure?[failure]:[])]),'RESPONSE_RECOVERY_NOT_SAVED');
        return{status:frozen.result.status,signature:recovered.event.signature,orderRevision:order.revision,
          ...(failure?{feeLamports:frozen.result.evidence.feeLamports}:{}),retryAuthorized:false,readyToSubmit:false,salesOpen:false};
      });
    },
    claimBuyerSubmission(input,{orderRevision,transactionSha256}={}) {
      return locked(input,async(scope,scopeKey)=>{
        const before=await snapshotData(scope,scopeKey),state=before.order&&submissionState(before.order,before.signing,before.events);
        requireThat(state?.status==='ready'&&!before.order.paused&&before.order.revision===orderRevision,'SEND_NOT_READY');
        validateBuyerSubmission(state.input);
        validateCostApproval(state.costApproval,state.input,{now:Date.now()});
        requireThat(transactionSha256===signedBytesId(state.input.response.transactionBase64),'SEND_BYTES');
        const number=state.input.claim.attempt;
        const event={type:'unknown',revision:before.order.revision,index:state.input.claim.itemIndex,attempt:number};
        const order=bounded(model.transitionOrder(before.order,event));
        const record={phase:'send-claimed',record:{version:1,claimId:[...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join(''),
          orderRevision:order.revision,transactionSha256,signature:order.items[state.input.claim.itemIndex].attempts[number-1].signature}};
        await transaction('readwrite',(tx,resolve,abort)=>load(tx,scopeKey,data=>{
          requireThat(equal(validate(data,scope,scopeKey),before.order)&&equal(data[3],before.signing),'STALE_REVISION');
          tx.objectStore('events').add(event,[scopeKey,order.revision]);tx.objectStore('orders').put(order,scopeKey);
          tx.objectStore('signing').add(record,[scopeKey,state.input.claim.itemIndex,number,4]);resolve(true);
        },abort));
        const after=await snapshotData(scope,scopeKey);
        requireThat(equal(after.order,order)&&equal(after.signing,[...before.signing,record]),'SEND_CLAIM_NOT_SAVED');
        return submissionState(after.order,after.signing,after.events);
      });
    },
    readBuyerSubmission(input) {
      return locked(input,async(scope,scopeKey)=>{const current=await snapshotData(scope,scopeKey);
        return current.order?submissionState(current.order,current.signing,current.events):null;});
    },
    // Read-only historical evidence, reconstructed before the next attempt.
    readBuyerAttempt(input,number,itemIndex=0) {
      requireThat([1,2].includes(number),'ATTEMPT_NUMBER');
      requireThat(Number.isSafeInteger(itemIndex)&&itemIndex>=0&&itemIndex<50,'INVALID_ITEM_INDEX');
      return locked(input,async(scope,scopeKey)=>{
        const saved=await snapshotData(scope,scopeKey),batches=groups(saved.signing),position=batches.findIndex(records=>records[0].record.itemIndex===itemIndex&&records[0].record.attempt===number),records=batches[position];
        if(!records)return null;
        const revision=batches[position+1]?.[0]?.record.orderRevision-1;
        let order=saved.order;
        if(Number.isSafeInteger(revision))order=atRevision(saved.events,revision,order);
        return{order:structuredClone(order),signing:signingState(order,records),wallet:walletState(order,records,saved.events),
          submission:submissionState(order,records,saved.events),...(hasPrewallet(records)?{prewallet:prewalletState(order,records,saved.events)}:{}),
          ...(hasResponseExpiry(records)?{responseExpiry:responseExpiryState(order,records,saved.events)}:{})};
      });
    },
    // Caller is the trusted recovery adapter. CAS + exact proof binding, never retry authorization.
    saveBuyerProof(input,report) {
      return saveProof(input,report);
    },
    saveBuyerExpiry(input,report) {
      return saveProof(input,report,'expired');
    },
    saveBuyerFailure(input,report) {
      return saveProof(input,report,'failed');
    },
    readBuyerResponse(input) {
      return locked(input, async (scope, scopeKey) => {
        const current = await snapshotData(scope, scopeKey);
        return current.order ? walletState(current.order, current.signing, current.events) : null;
      });
    },
    // Closing connections never deletes orders, events or keys.
    close() { closed = true; connection?.close(); },
  };
}
