// Browser custody, asset signing and durable buyer response evidence. No wallet calls, RPC or dispatch.
import policy from '../../metadata/policy.json' with { type: 'json' };
import { base58 } from '@metaplex-foundation/umi/serializers';
import { createOrderModel } from './journal-model.mjs';
import { prepareAssetClaim, validateAssetClaim, finalizeAssetRequest, validateAssetRequest, verifyBuyerSigningResponse, buyerRequestId } from './signing.mjs';
import {signedBytesId,validateBuyerSubmission,validateBuyerResult} from './submission.mjs';
import {validateCostApproval} from './cost-approval.mjs';
import {validateBuyerExpiryResult,expiryRecord} from './expiry-review.mjs';
import {validateReplacementResult,validateReplacementClaim} from './replacement.mjs';
const model = createOrderModel(policy);
const DATABASE = 'coolbears-buyer-custody-v1';
const STORES = ['orders', 'keys', 'events', 'signing'];
const MAX_REVISION = 1024, MAX_BYTES = 262144;
const requireThat = (ok, code) => { if (!ok) throw Error(code); };
const fields = ['id', 'cluster', 'buyer', 'machine', 'collection', 'guard'];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function checkedScope(input) {
  // The validation placeholder must be distinct even when buyer is the owner.
  const scope = Object.fromEntries(fields.map(key => [key, input?.[key]]));
  const candidates = Array.from({ length: 8 }, (_, index) => base58.deserialize(new Uint8Array(32).fill(index + 1))[0]);
  const placeholder = candidates.find(value => ![...Object.values(scope), policy.owner].includes(value));
  model.createOrder({ ...scope, quantity: 1, available: 1, assets: [placeholder] });
  requireThat(scope.cluster === 'devnet', 'DEVNET_ONLY');
  return scope;
}
function bounded(order) {
  model.validateOrder(order);
  requireThat(order.revision <= MAX_REVISION && new TextEncoder().encode(JSON.stringify(order)).length <= MAX_BYTES, 'ORDER_STORAGE_LIMIT');
  return order;
}
function keyShape(record, scopeKey, item) {
  const key = record?.privateKey, pub = record?.publicKey;
  requireThat(record?.version === 1 && record.scopeKey === scopeKey && record.index === item.index && record.asset === item.asset, 'ASSET_KEY_MISSING');
  requireThat(key instanceof CryptoKey && key.type === 'private' && !key.extractable && key.algorithm.name === 'Ed25519' && equal([...key.usages], ['sign']), 'INVALID_ASSET_KEY');
  requireThat(pub instanceof CryptoKey && pub.type === 'public' && pub.algorithm.name === 'Ed25519' && equal([...pub.usages], ['verify']), 'INVALID_ASSET_KEY');
}
export function createBuyerStorage({ indexedDB = globalThis.indexedDB, crypto = globalThis.crypto, locks = globalThis.navigator?.locks } = {}) {
  let opening, connection, closed = false;
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
  function validate([order, keys, events, signing], scope, scopeKey) {
    if (order === undefined) { requireThat(keys.length === 0 && events.length === 0 && signing.length === 0, 'ORPHANED_ORDER_DATA'); return null; }
    bounded(order);
    requireThat(fields.every(field => order[field] === scope[field]), 'ORDER_SCOPE_MISMATCH');
    requireThat(keys.length === order.quantity, 'ASSET_KEY_MISSING');
    for (const item of order.items) keyShape(keys[item.index], scopeKey, item);
    requireThat(events.length === order.revision + 1 && events[0]?.type === 'create', 'CORRUPT_ORDER_HISTORY');
    let replay = bounded(events[0].order);
    requireThat(replay.revision === 0 && !replay.paused && replay.items.every(item => !item.attempts.length), 'CORRUPT_ORDER_HISTORY');
    for (let i = 1; i < events.length; i++) replay = model.transitionOrder(replay, events[i]);
    requireThat(equal(replay, order), 'CORRUPT_ORDER_HISTORY');
    const batches=groups(signing);
    if(signing.length)requireThat(batches.length===order.items[0].attempts.length,'ASSET_CLAIM_HISTORY');
    for(const [i,records]of batches.entries()){
      const claim=records[0]?.record;
      requireThat(claim.attempt===i+1&&equal(Object.keys(records[0]).sort(),(i===0?['phase','record']:['phase','record','replacement']).sort()),'ASSET_CLAIM_HISTORY');
      requireThat(equal(events[claim.orderRevision],{type:'prepare',revision:claim.orderRevision-1,index:0,blockhash:claim.blockhash,
        lastValidBlockHeight:claim.lastValidBlockHeight,messageSha256:claim.messageSha256,...(i===1?{retry:true}:{})}),'ASSET_CLAIM_HISTORY');
      signingState(order,records);walletState(order,records,events);submissionState(order,records,events);
      if(i===1){
        validateReplacementClaim(order,claim,records[0].replacement);
        const source=submissionState(order,batches[0],events);
        requireThat(source?.status==='expired'&&equal(records[0].replacement.prior,source.expiryRecord),'REPLACEMENT_HISTORY');
      }
    }
    return order;
  }
  async function proveKeys(order, records, scopeKey) {
    for (const item of order.items) {
      const record = records[item.index]; keyShape(record, scopeKey, item);
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
  }
  function groups(records){
    requireThat(records.length<=12,'CORRUPT_ASSET_SIGNING');const batches=[];
    for(const record of records){if(record?.phase==='claimed')batches.push([]);
      requireThat(batches.length>0&&batches.length<=2,'CORRUPT_ASSET_SIGNING');batches.at(-1).push(record);}
    return batches;
  }
  const current=records=>groups(records).at(-1)??[];
  function signingState(order, records) {
    records=current(records);
    requireThat(records.length <= 6, 'CORRUPT_ASSET_SIGNING');
    if (!records.length) return null;
    const [claimed, ready] = records;
    requireThat(claimed?.phase === 'claimed' && (!ready || ready.phase === 'ready'), 'CORRUPT_ASSET_SIGNING');
    validateAssetClaim(order, claimed.record);
    if (ready) validateAssetRequest(order, claimed.record, ready.record);
    return { status: ready ? 'asset-partial-saved' : 'asset-signing-unknown',
      claim: structuredClone(claimed.record), request: ready ? structuredClone(ready.record) : null,
      mode: 'offline-devnet-asset-signing', networkVerified: false, blockhashVerified: false, guardPriceVerified: false,
      readyToSign: false, readyToSubmit: false, salesOpen: false };
  }
  function walletState(order, records, events) {
    records=current(records);
    if (records.length < 3) return null;
    const assetClaim=records[0].record,number=assetClaim.attempt;
    const claim = records[2]?.record, response = records[3]?.record;
    const shape = (value, names) => value && equal(Object.keys(value).sort(), names.split(' ').sort());
    requireThat(records[2]?.phase === 'wallet-claimed'
      && ((claim.version===1&&shape(claim,'version claimId requestId orderRevision'))
        ||(claim.version===2&&shape(claim,'version claimId requestId orderRevision costApproval')))
      && /^[a-f0-9]{64}$/.test(claim.claimId) && claim.requestId === buyerRequestId(records[1].record)
      && claim.orderRevision === assetClaim.orderRevision+1 && order.revision >= claim.orderRevision, 'CORRUPT_WALLET_CLAIM');
    if(claim.version===2)validateCostApproval(claim.costApproval,{order,claim:records[0].record,request:records[1].record});
    requireThat(equal(events[claim.orderRevision], {type:'unknown',revision:assetClaim.orderRevision,index:0,attempt:number}), 'WALLET_CLAIM_HISTORY');
    if (response) {
      requireThat(records[3].phase === 'buyer-response'
        && shape(response, 'version claimId orderRevision transactionBase64 signature messageSha256')
        && response.version === 1 && response.claimId === claim.claimId
        && Number.isSafeInteger(response.orderRevision) && response.orderRevision > claim.orderRevision
        && response.orderRevision <= order.revision, 'CORRUPT_BUYER_RESPONSE');
      let before = events[0].order;
      for (let n = 1; n < response.orderRevision; n++) before = model.transitionOrder(before, events[n]);
      const verified = verifyBuyerSigningResponse(before, records[0].record, records[1].record,
        {transactionBase64:response.transactionBase64});
      requireThat(verified.signature === response.signature && verified.messageSha256 === response.messageSha256
        && equal(events[response.orderRevision], {type:'signature',revision:before.revision,index:0,attempt:number,
          signature:response.signature,messageSha256:response.messageSha256}), 'BUYER_RESPONSE_HISTORY');
    }
    return {status:response ? 'buyer-response-saved' : 'wallet-response-unknown',
      claim:structuredClone(claim), response:response ? structuredClone(response) : null,
      readyToSign:false, readyToSubmit:false, salesOpen:false};
  }
  function submissionState(order,records,events) {
    records=current(records);
    const wallet=walletState(order,records,events);
    if(!wallet?.response)return null;
    const input={order:structuredClone(order),claim:structuredClone(records[0].record),request:structuredClone(records[1].record),
      response:{transactionBase64:wallet.response.transactionBase64}};
    const number=input.claim.attempt;let expiryEvidence=null;
    const reviewed=records.at(-1)?.phase==='expiry-reviewed'?records.at(-1).record:null;
    const sendClaim=records[4]?.phase==='expiry-reviewed'?null:records[4]?.record;
    if(sendClaim){
      requireThat(records[4].phase==='send-claimed'&&equal(Object.keys(sendClaim).sort(),
        ['version','claimId','orderRevision','transactionSha256','signature'].sort())&&sendClaim.version===1
        &&/^[a-f0-9]{64}$/.test(sendClaim.claimId)&&sendClaim.signature===wallet.response.signature
        &&sendClaim.transactionSha256===signedBytesId(wallet.response.transactionBase64)
        &&Number.isSafeInteger(sendClaim.orderRevision)&&sendClaim.orderRevision>wallet.response.orderRevision
        &&sendClaim.orderRevision<=order.revision,'CORRUPT_SEND_CLAIM');
      requireThat(equal(events[sendClaim.orderRevision],{type:'unknown',revision:sendClaim.orderRevision-1,index:0,attempt:number}),'SEND_CLAIM_HISTORY');
      let prior=events[0].order;
      for(let i=1;i<sendClaim.orderRevision;i++)prior=model.transitionOrder(prior,events[i]);
      requireThat(!prior.paused,'SEND_CLAIM_HISTORY');validateBuyerSubmission({...input,order:prior});
    }
    const outcome=order.items[0].attempts[number-1].state;
    requireThat(records.length===(sendClaim?5:4)+(reviewed?1:0),'CORRUPT_EXPIRY_REVIEW');
    if(reviewed){
      requireThat(records.length===(sendClaim?6:5)&&equal(Object.keys(reviewed).sort(),['version','orderRevision','report'].sort())
        &&reviewed.version===1&&Number.isSafeInteger(reviewed.orderRevision)&&reviewed.orderRevision>wallet.response.orderRevision
        &&reviewed.orderRevision<=order.revision&&outcome==='expired','CORRUPT_EXPIRY_REVIEW');
      let prior=events[0].order;
      for(let i=1;i<reviewed.orderRevision;i++)prior=model.transitionOrder(prior,events[i]);
      validateBuyerExpiryResult(reviewed.report,{...input,order:prior});
      expiryEvidence=expiryRecord({...input,order:prior},reviewed.report);
      requireThat(reviewed.report.status==='expired'&&equal(events[reviewed.orderRevision],
        {type:'reconcile',revision:prior.revision,index:0,attempt:number,proof:reviewed.report.proof}),'EXPIRY_REVIEW_HISTORY');
    }
    requireThat(outcome!=='expired'||reviewed,'EXPIRY_REVIEW_REQUIRED');
    return {status:['verified','expired'].includes(outcome)?outcome:sendClaim?'send-claimed':'ready',
      input,expiryRecord:expiryEvidence,costApproval:wallet.claim.costApproval?structuredClone(wallet.claim.costApproval):null,sendClaim:sendClaim?structuredClone(sendClaim):null,readyToSubmit:false,salesOpen:false};
  }
  async function snapshotData(scope, scopeKey) {
    const data = await transaction('readonly', (tx, resolve, abort) => load(tx, scopeKey, resolve, abort));
    const order = validate(data, scope, scopeKey);
    if (order) await proveKeys(order, data[1], scopeKey);
    return { order, keys: data[1], events: data[2], signing: data[3] };
  }
  async function snapshot(scope, scopeKey) { return (await snapshotData(scope, scopeKey)).order; }
  async function locked(input, action) {
    requireCapabilities();
    const scope = checkedScope(structuredClone(input)), scopeKey = JSON.stringify(scope);
    return locks.request(`coolbears:buyer-order:v1:${scopeKey}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
      requireThat(lock, 'ORDER_BUSY');
      return action(scope, scopeKey);
    });
  }
  // Trusted adapter only. Evidence + unchanged order/event CAS; never a retry grant.
  function saveProof(input,report,expiry=false){
    const frozen=structuredClone(report),outcome=expiry?'expired':'verified';
    return locked(input,async(scope,scopeKey)=>{
      const before=await snapshotData(scope,scopeKey),state=before.order&&submissionState(before.order,before.signing,before.events);
      requireThat(state&&!['verified','expired'].includes(state.status),'RECOVERY_STATE');
      if(expiry)validateBuyerExpiryResult(frozen,state.input);else validateBuyerResult(frozen,state.input,{recovery:true});
      requireThat(frozen.status===outcome,'RECOVERY_NOT_VERIFIED');
      const number=state.input.claim.attempt;
      const event={type:'reconcile',revision:before.order.revision,index:0,attempt:number,proof:frozen.proof};
      const order=bounded(model.transitionOrder(before.order,event));
      const record=expiry?{phase:'expiry-reviewed',record:{version:1,orderRevision:order.revision,report:frozen}}:null;
      await transaction('readwrite',(tx,resolve,abort)=>load(tx,scopeKey,data=>{
        requireThat(equal(validate(data,scope,scopeKey),before.order)&&equal(data[3],before.signing),'STALE_REVISION');
        tx.objectStore('events').add(event,[scopeKey,order.revision]);tx.objectStore('orders').put(order,scopeKey);
        if(record)tx.objectStore('signing').add(record,[scopeKey,0,number,5]);resolve(true);
      },abort));
      const after=await snapshotData(scope,scopeKey);
      requireThat(equal(after.order,order)&&equal(after.signing,record?[...before.signing,record]:before.signing),'PROOF_NOT_SAVED');
      return {status:outcome,signature:order.items[0].attempts[number-1].signature,orderRevision:order.revision,
        ...(expiry?{retryAuthorized:false}:{}),readyToSubmit:false,salesOpen:false};
    });
  }
  async function prepareSigning(input,candidate,replacementReport){
      const frozen=structuredClone(candidate),report=replacementReport&&structuredClone(replacementReport);
      return locked(input, async (scope, scopeKey) => {
        const before = await snapshotData(scope, scopeKey);
        requireThat(before.order, 'MISSING_ORDER');
        requireThat(frozen?.orderRevision===before.order.revision,'STALE_REVISION');
        if(report){
          const source=submissionState(before.order,before.signing,before.events);
          requireThat(source?.status==='expired'&&source.input.claim.attempt===1,'REPLACEMENT_NOT_READY');
          validateReplacementResult(report,source.input);requireThat(equal(report.record.prior,source.expiryRecord),'REPLACEMENT_HISTORY');
        }else requireThat(before.signing.length===0,'ASSET_SIGNING_EXISTS');
        const prepared = prepareAssetClaim(before.order, frozen),number=prepared.claim.attempt;
        requireThat(number===(report?2:1),'REPLACEMENT_NOT_READY');
        bounded(prepared.order);
        const claimed = { phase: 'claimed', record: prepared.claim,...(report?{replacement:report.record}:{}) };
        await transaction('readwrite', (tx, resolve, abort) => load(tx, scopeKey, data => {
          requireThat(equal(validate(data, scope, scopeKey), before.order) && equal(data[3],before.signing), 'STALE_REVISION');
          tx.objectStore('events').add(prepared.event, [scopeKey, prepared.order.revision]);
          tx.objectStore('orders').put(prepared.order, scopeKey);
          tx.objectStore('signing').add(claimed, [scopeKey, 0, number, 0]);
          resolve(true);
        }, abort));
        // Native signing starts only after the intent has committed and been read back.
        const saved = await snapshotData(scope, scopeKey);
        requireThat(equal(saved.order, prepared.order) && equal(saved.signing, [...before.signing,claimed]), 'ASSET_CLAIM_CHANGED');
        const message = validateAssetClaim(saved.order, prepared.claim);
        let signature;
        try { signature = new Uint8Array(await crypto.subtle.sign('Ed25519', saved.keys[0].privateKey, message)); }
        catch { throw Error('ASSET_SIGNING_FAILED'); }
        const request = finalizeAssetRequest(saved.order, prepared.claim, signature);
        await transaction('readwrite', (tx, resolve, abort) => load(tx, scopeKey, data => {
          requireThat(equal(validate(data, scope, scopeKey), saved.order) && equal(data[3], saved.signing), 'ASSET_CLAIM_CHANGED');
          tx.objectStore('signing').add({ phase: 'ready', record: request }, [scopeKey, 0, number, 1]);
          resolve(true);
        }, abort));
        const final = await snapshotData(scope, scopeKey);
        requireThat(equal(final.order, saved.order) && equal(final.signing, [...before.signing,claimed, {phase:'ready',record:request}]), 'ASSET_REQUEST_NOT_SAVED');
        return signingState(final.order, final.signing);
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
    prepareReplacementSigning(input,report,{authorizeReplacementSigning=false}={}){
      requireThat(authorizeReplacementSigning===true,'EXPLICIT_REPLACEMENT_SIGNING_REQUIRED');
      const frozen=structuredClone(report);return prepareSigning(input,frozen?.candidate,frozen);
    },
    readAssetSigning(input) {
      return locked(input, async (scope, scopeKey) => {
        const current = await snapshotData(scope, scopeKey);
        return current.order ? signingState(current.order, current.signing) : null;
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
          && before.order.items[0].attempts[number-1].state === 'wallet-pending'
          && requestId === buyerRequestId(records[1].record), 'WALLET_NOT_READY');
        validateCostApproval(approval,{order:before.order,claim:records[0].record,request:records[1].record},{now:Date.now()});
        const event = {type:'unknown',revision:orderRevision,index:0,attempt:number};
        const order = bounded(model.transitionOrder(before.order, event));
        const claimId = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2,'0')).join('');
        const claimed = {phase:'wallet-claimed',record:{version:2,claimId,requestId,orderRevision:order.revision,costApproval:approval}};
        await transaction('readwrite', (tx, resolve, abort) => load(tx, scopeKey, data => {
          requireThat(equal(validate(data, scope, scopeKey), before.order) && equal(data[3], before.signing), 'STALE_REVISION');
          tx.objectStore('events').add(event, [scopeKey, order.revision]);
          tx.objectStore('orders').put(order, scopeKey);
          tx.objectStore('signing').add(claimed, [scopeKey,0,number,2]); resolve(true);
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
        requireThat(frozen.claimId === state.claim.claimId, 'WALLET_CLAIM_MISMATCH');
        if (state.response) {
          requireThat(state.response.transactionBase64 === frozen.transactionBase64, 'BUYER_RESPONSE_CONFLICT');
          return state; // Lost commit acknowledgment: read the same bytes, no event.
        }
        const verified = verifyBuyerSigningResponse(before.order, records[0].record, records[1].record,
          {transactionBase64:frozen.transactionBase64});
        const event = {type:'signature',revision:before.order.revision,index:0,attempt:number,
          signature:verified.signature,messageSha256:verified.messageSha256};
        const order = bounded(model.transitionOrder(before.order, event));
        const saved = {phase:'buyer-response',record:{version:1,claimId:frozen.claimId,orderRevision:order.revision,
          transactionBase64:verified.transactionBase64,signature:verified.signature,messageSha256:verified.messageSha256}};
        await transaction('readwrite', (tx, resolve, abort) => load(tx, scopeKey, data => {
          requireThat(equal(validate(data, scope, scopeKey), before.order) && equal(data[3], before.signing), 'STALE_REVISION');
          tx.objectStore('events').add(event, [scopeKey, order.revision]);
          tx.objectStore('orders').put(order, scopeKey);
          tx.objectStore('signing').add(saved, [scopeKey,0,number,3]); resolve(true);
        }, abort));
        const after = await snapshotData(scope, scopeKey);
        requireThat(equal(after.order, order) && equal(after.signing, [...before.signing,saved]), 'BUYER_RESPONSE_NOT_SAVED');
        return walletState(after.order, after.signing, after.events);
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
        const event={type:'unknown',revision:before.order.revision,index:0,attempt:number};
        const order=bounded(model.transitionOrder(before.order,event));
        const record={phase:'send-claimed',record:{version:1,claimId:[...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join(''),
          orderRevision:order.revision,transactionSha256,signature:order.items[0].attempts[number-1].signature}};
        await transaction('readwrite',(tx,resolve,abort)=>load(tx,scopeKey,data=>{
          requireThat(equal(validate(data,scope,scopeKey),before.order)&&equal(data[3],before.signing),'STALE_REVISION');
          tx.objectStore('events').add(event,[scopeKey,order.revision]);tx.objectStore('orders').put(order,scopeKey);
          tx.objectStore('signing').add(record,[scopeKey,0,number,4]);resolve(true);
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
    readBuyerAttempt(input,number) {
      requireThat([1,2].includes(number),'ATTEMPT_NUMBER');
      return locked(input,async(scope,scopeKey)=>{
        const saved=await snapshotData(scope,scopeKey),batches=groups(saved.signing),records=batches[number-1];
        if(!records)return null;
        const revision=batches[number]?.[0]?.record.orderRevision-1;
        let order=saved.order;
        if(Number.isSafeInteger(revision)){order=saved.events[0].order;for(let n=1;n<=revision;n++)order=model.transitionOrder(order,saved.events[n]);}
        return{order:structuredClone(order),signing:signingState(order,records),wallet:walletState(order,records,saved.events),
          submission:submissionState(order,records,saved.events)};
      });
    },
    // Caller is the trusted recovery adapter. CAS + exact proof binding, never retry authorization.
    saveBuyerProof(input,report) {
      return saveProof(input,report);
    },
    saveBuyerExpiry(input,report) {
      return saveProof(input,report,true);
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
