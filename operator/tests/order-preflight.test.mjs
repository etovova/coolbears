// Real SDK layouts and RPC transport; all responses and addresses are fixtures.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { CANDY_MACHINE_HIDDEN_SECTION } from '@metaplex-foundation/mpl-core-candy-machine';
import { getCandyMachineAccountDataSerializer as machineSerializer } from '../node_modules/@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/types/candyMachineAccountData.js';
import { getCollectionV1AccountDataSerializer as collectionSerializer } from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData.js';
import { buildDeploymentPlan } from '../deployment/plan.mjs';
import { verifyOrderAccounts, verifyExpectedAccounts, expectedAccountAddresses } from '../deployment/accounts.mjs';
import { insertionAccounts } from './fixtures/group-accounts.mjs';
import { GENESIS_HASHES } from '../deployment/rpc.mjs';
import { policy } from '../prepare.mjs';
import { createOrder, transitionOrder } from '../orders/journal.mjs';
import { checkPreparedOrder, preflightOrder } from '../orders/preflight.mjs';
import { prepareAssetClaim, finalizeAssetRequest } from '../orders/signing.mjs';
import { buildOrderTransactions } from '../orders/transactions.mjs';
import { ed25519 } from '@noble/curves/ed25519';
import { validateWalletCheck } from '../orders/wallet-client.mjs';
import {baseAssetBytes} from '../orders/mint-cost.mjs';
import {preparationFor} from '../orders/preparation.mjs';
import {MPL_CORE_PROGRAM_ID} from '@metaplex-foundation/mpl-core';
import { runOrderCheck } from '../orders/check.mjs';

const address = label => {
  for (let n = 0; ; n++) { const bytes = createHash('sha256').update(`order-read:${label}:${n}`).digest();
    if (PublicKey.isOnCurve(bytes)) return new PublicKey(bytes).toBase58(); }
};
const endpoint = 'https://order-fixture.test/?api-key=SECRET-FIXTURE', blockhash = address('hash');
const originalFetch = globalThis.fetch;
let plan, full;
before(async () => {
  globalThis.fetch = () => assert.fail('Live network forbidden');
  plan = await buildDeploymentPlan({ cluster: 'devnet', collection: address('collection'), reservedAsset: address('other'),
    machine: address('machine'), blockhash, lastValidBlockHeight: 1000, machineRentLamports: '5000000000' });
  full = insertionAccounts({ steps: plan.steps }, 9999);
});
after(() => { globalThis.fetch = originalFetch; });
function order(quantity = 1, changes = {}) {
  return createOrder({ id: 'buyer-read-fixture', cluster: 'devnet', buyer: policy.owner,
    machine: plan.roles.machine, guard: plan.roles.guard, collection: plan.roles.collection,
    quantity, available: 9999, assets: Array.from({ length: quantity }, (_, n) => address(`asset-${n}`)), ...changes });
}
const bytes = account => Buffer.from(account.data[0], 'base64');
function changeAccount(account, edit) {
  const data = bytes(account); edit(data); return { ...account, data: [data.toString('base64'), 'base64'] };
}
function accounts(redeemed = 0) {
  const value = structuredClone(full);
  value[5] = changeAccount(value[5], data => {
    const [base] = machineSerializer().deserialize(data);
    data.set(machineSerializer().serialize({ ...base, itemsRedeemed: BigInt(redeemed) }));
  });
  value[3] = changeAccount(value[3], data => {
    const [base] = collectionSerializer().deserialize(data);
    data.set(collectionSerializer().serialize({ ...base, numMinted: redeemed + 1, currentSize: redeemed + 1 }));
  });
  return value;
}
function harness({ quantity = 1, buyer = policy.owner, redeemed = 0, transform, revise, prepared = false } = {}) {
  let saved = order(quantity, { buyer }), reads = 0, accountReads = 0;
  let signing;
  if (prepared) {
    const asset = Keypair.fromSeed(new Uint8Array(32).fill(19));
    saved = order(1, {buyer,assets:[asset.publicKey.toBase58()]});
    const block = {blockhash,lastValidBlockHeight:2000};
    const transactionBase64 = Buffer.from(buildOrderTransactions(saved,block).templates[0].unsignedBytes).toString('base64');
    const value = prepareAssetClaim(saved,{orderRevision:0,itemIndex:0,...block,transactionBase64});
    saved = value.order;
    const message = VersionedTransaction.deserialize(Buffer.from(transactionBase64,'base64')).message.serialize();
    signing = {blockhashAnchor:preparationFor(order(1,{buyer,assets:[asset.publicKey.toBase58()]}),block,600).anchor,claim:value.claim,request:finalizeAssetRequest(saved,value.claim,ed25519.sign(message,asset.secretKey.slice(0,32)))};
  }
  const base = accounts(redeemed), calls = [];
  const readOrder = () => { reads++; if (reads > 1 && revise) saved = revise(saved); return structuredClone(saved); };
  const fetchImpl = async (url, init) => {
    assert.equal(url, endpoint); const call = JSON.parse(init.body); calls.push(call);
    assert.equal(init.redirect, 'error');
    if (call.method === 'getMultipleAccounts') accountReads++;
    let result = {
      getGenesisHash: GENESIS_HASHES.devnet,
      getMultipleAccounts: { context: { slot: 600 }, value: [...base.slice(0, 3), base[5], base[6], base[3], ...Array(quantity).fill(null)] },
      getBalance: { context: { slot: 600 }, value: 20000000000 },
      getLatestBlockhash: { context: { slot: 600 }, value: { blockhash, lastValidBlockHeight: 2000 } },
      getFeeForMessage: { context: { slot: 600 }, value: 10000 },
      getMinimumBalanceForRentExemption: 1999999,
      simulateTransaction: { context: { slot: 600 }, value: { err: null, unitsConsumed: 99999, accounts:[{owner:MPL_CORE_PROGRAM_ID,executable:false,lamports:3499999,data:[Buffer.from(baseAssetBytes(policy,saved)).toString('base64'),'base64']}] } },
      isBlockhashValid: { context: { slot: 600 }, value: true }, getBlockHeight: 1800,
    }[call.method];
    assert.notEqual(result, undefined, call.method);
    if (transform) result = transform(call, result, accountReads);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
  };
  return { calls, readOrder, fetchImpl, signing, initial: () => structuredClone(saved),
    run: () => prepared ? checkPreparedOrder({readOrder,endpoint,fetchImpl,...signing}) : preflightOrder({ readOrder, endpoint, fetchImpl }) };
}
for (const quantity of [1, 50]) test(`fresh ${quantity}-item order validates a full machine and only simulates the first exact message`, async () => {
  const h = harness({ quantity, redeemed: 7 }), before = h.initial();
  const report = await h.run(); assert.equal(report.status, 'preflight-passed', JSON.stringify(report));
  assert.equal(report.itemsRemaining, 9992); assert.equal(report.quantity, quantity);
  assert.equal(report.budget.orderItemPriceLamports, String(200000000n * BigInt(quantity)));
  assert.equal(report.budget.nextItemKnownMinimumLamports, '203509999'); assert.equal(report.budget.baseAssetBytes, 158);
  assert.equal(report.budget.complete, true); assert.equal(report.budget.protocolChargesLamports, '1500000');
  assert.equal(report.budget.fullOrderTotalLamports, null);
  const sim = h.calls.filter(x => x.method === 'simulateTransaction'); assert.equal(sim.length, 1);
  assert.equal(sim[0].params[0], report.candidate.transactionBase64);
  assert.equal(sim[0].params[1].sigVerify, false); assert.equal(sim[0].params[1].replaceRecentBlockhash, false);
  const tx = VersionedTransaction.deserialize(Buffer.from(report.candidate.transactionBase64, 'base64'));
  assert.equal(tx.version, 0); assert.equal(tx.message.staticAccountKeys[0].toBase58(), before.buyer);
  assert.ok(tx.signatures.every(signature => signature.every(byte => byte === 0)));
  assert.equal(createHash('sha256').update(tx.message.serialize()).digest('hex'), report.candidate.messageSha256);
  assert.equal(h.calls.length, 11); assert.deepEqual(h.initial(), before);
  assert.equal(report.readyToSign, false); assert.equal(report.salesOpen, false);
  assert.equal(report.signaturesCreated + report.transactionsSent + report.journalWrites, 0);
});

test('ordinary buyer is refused by the closed on-chain guard before any fee quote or simulation', async () => {
  const h = harness({ buyer: address('ordinary-buyer'), quantity: 50 });
  assert.equal((await h.run()).code, 'SALES_CLOSED');
  assert.deepEqual(h.calls.map(x => x.method), ['getGenesisHash', 'getMultipleAccounts']);
});
test('sold-out and insufficient supply are refused; planning availability is never trusted', async () => {
  for (const redeemed of [9999, 9950]) { const h = harness({ quantity: 50, redeemed });
    assert.equal((await h.run()).code, 'INSUFFICIENT_SUPPLY'); assert.equal(h.calls.length, 2); }
});
test('paused, existing, mainnet, invalid quantity and unsignable fresh orders stop before RPC', async () => {
  const pristine = order();
  const offCurve = PublicKey.findProgramAddressSync([Buffer.from('unsignable-asset')], new PublicKey(plan.roles.machine))[0].toBase58();
  const pending = transitionOrder(pristine, { type: 'prepare', revision: 0, index: 0,
    blockhash, lastValidBlockHeight: 2000, messageSha256: '0'.repeat(64) });
  for (const saved of [{ ...pristine, paused: true }, pending, { ...pristine, cluster: 'mainnet-beta' },
    { ...pristine, quantity: 51 }, { ...pristine, treasury: address('changed') },
    { ...pristine, items: [{ index: 0, asset: offCurve, attempts: [] }] }]) {
    const report = await preflightOrder({ readOrder: () => saved, endpoint, fetchImpl: () => assert.fail('RPC forbidden') });
    assert.equal(report.status, 'blocked'); assert.equal(report.networkRequests, 0);
  }
});
test('wrong genesis never reads accounts', async () => {
  const h = harness({ transform: (call, result) => call.method === 'getGenesisHash' ? GENESIS_HASHES['mainnet-beta'] : result });
  assert.equal((await h.run()).code, 'RPC_GENESIS'); assert.equal(h.calls.length, 1);
});
test('changed guard, collection royalties, full config lines, indices and program accounts are rejected', async () => {
  const N = 9999, settings = plan.steps[2].expected.configLineSettings;
  const bitmap = CANDY_MACHINE_HIDDEN_SECTION + 4 + N * (settings.nameLength + settings.uriLength), indices = bitmap + Math.floor(N / 8) + 1;
  const mutations = [
    values => { values[0] = { executable: false }; },
    values => { values[3].owner = policy.owner; },
    values => { values[3] = changeAccount(values[3], b => { b[CANDY_MACHINE_HIDDEN_SECTION + 4 + 5000 * (settings.nameLength + settings.uriLength)] ^= 1; }); },
    values => { values[3] = changeAccount(values[3], b => b.writeUInt32LE(0, indices + 4)); },
    values => { values[3] = changeAccount(values[3], b => { b[bitmap] = 0; }); },
    values => { values[3] = changeAccount(values[3], b => b.writeUInt32LE(9998, CANDY_MACHINE_HIDDEN_SECTION)); },
    values => { values[4] = changeAccount(values[4], b => { b[b.length - 1] ^= 1; }); },
    values => { values[4] = changeAccount(values[4], b => { const encoded = Buffer.alloc(8); encoded.writeBigUInt64LE(200000000n);
      const at = b.indexOf(encoded); assert.ok(at >= 0); b[at] ^= 1; }); },
    values => { values[5] = changeAccount(values[5], b => { b[150] ^= 1; }); },
    values => { values[6] = { owner: policy.owner, executable: false }; },
  ];
  for (const mutate of mutations) {
    const h = harness({ transform: (call, result) => { if (call.method === 'getMultipleAccounts') mutate(result.value); return result; } });
    assert.equal((await h.run()).status, 'blocked'); assert.equal(h.calls.length, 2);
  }
});
test('fee, balance, simulation, context and blockhash failures never yield a candidate', async () => {
  const scenarios = [
    ['getFeeForMessage', r => { r.value = null; }], ['getFeeForMessage', r => { r.value = 0; }],
    ['getBalance', r => { r.value = 100; }], ['getBalance', r => { r.value = Number.MAX_SAFE_INTEGER + 1; }],
    ['getLatestBlockhash', r => { r.context.slot = 1; }],
    ['simulateTransaction', r => { r.value.err = { Custom: 1 }; }],
    ['simulateTransaction', r => { r.value.replacementBlockhash = { blockhash }; }],
    ['simulateTransaction', r => { r.value.unitsConsumed = 300001; }],
    ['isBlockhashValid', r => { r.value = false; }],
  ];
  for (const [method, change] of scenarios) {
    const h = harness({ transform: (call, result) => { if (call.method === method) change(result); return result; } });
    const report = await h.run(); assert.equal(report.status, 'blocked', method); assert.equal(report.candidate, undefined);
  }
  const h = harness({ transform: (call, result) => call.method === 'getBlockHeight' ? 1950 : result });
  assert.equal((await h.run()).code, 'BLOCKHASH_TOO_OLD');
});
test('changed accounts, insufficient supply or a new asset after simulation stop; order mutation stops a stale result', async () => {
  const h = harness({ transform: (call, result, reads) => {
    if (call.method === 'getMultipleAccounts' && reads === 2) result.value[4] = null; return result;
  } }); assert.equal((await h.run()).code, 'ACCOUNT_STATE_MISMATCH');
  const sold = accounts(9950);
  const dwindled = harness({ quantity: 50, transform: (call, result, reads) => {
    if (call.method === 'getMultipleAccounts' && reads === 2) {
      result.value[3] = sold[5]; result.value[5] = sold[3];
    } return result;
  } }); assert.equal((await dwindled.run()).code, 'INSUFFICIENT_SUPPLY');
  const occupied = harness({ transform: (call, result, reads) => {
    if (call.method === 'getMultipleAccounts' && reads === 2) result.value[6] = { owner: policy.owner }; return result;
  } }); assert.equal((await occupied.run()).code, 'ASSET_ALREADY_EXISTS');
  const changed = harness({ revise: saved => ({ ...saved, id: 'other-order' }) });
  assert.equal((await changed.run()).code, 'ORDER_CHANGED');
});
test('mint-ready state accepts the remaining random index pool without relaxing deployment checks', () => {
  const values = accounts(5), expected = plan.steps[2].expected, N = 9999, s = expected.configLineSettings;
  const offset = CANDY_MACHINE_HIDDEN_SECTION + 4 + N * (s.nameLength + s.uriLength) + Math.floor(N / 8) + 1;
  values[5] = changeAccount(values[5], b => { const a = b.readUInt32LE(offset), z = b.readUInt32LE(offset + 10 * 4);
    b.writeUInt32LE(z, offset); b.writeUInt32LE(a, offset + 10 * 4);
    b.writeUInt32LE(0xffffffff, offset + (N - 1) * 4); });
  assert.equal(verifyOrderAccounts(order(), [values[5], values[6], values[3]]).itemsRemaining, 9994);
  assert.throws(() => verifyExpectedAccounts({ ...expected, itemsLoaded: N }, expectedAccountAddresses(expected), [values[5], values[6]]));
});
test('CLI reads an existing bounded regular file, preserves it and prints no RPC secrets or transaction bytes', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'order-read-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'order.json'), h = harness(); const content = JSON.stringify(h.initial());
  await writeFile(file, content, { mode: 0o600 }); let output = '';
  const options = { env: { COOLBEARS_BUYER_RPC_URL: endpoint }, fetchImpl: h.fetchImpl, output: { write: text => { output += text; } } };
  assert.equal(await runOrderCheck(['preflight', file], options), 0);
  assert.equal(JSON.parse(output).status, 'preflight-passed');
  assert.doesNotMatch(output, /SECRET-FIXTURE|transactionBase64|order-fixture\.test|\/tmp\//);
  assert.equal(await readFile(file, 'utf8'), content);
  const link = path.join(directory, 'alias'); await symlink(file, link); output = '';
  assert.equal(await runOrderCheck(['preflight', link], options), 1);
  assert.equal(JSON.parse(output).networkRequests, 0);
});
test('429 and hung transport are bounded, sanitized and never retried', async () => {
  let calls = 0;
  const blocked = await preflightOrder({ readOrder: () => order(), endpoint, fetchImpl: () => { calls++; return new Response('SECRET-FIXTURE', { status: 429 }); } });
  assert.equal(blocked.code, 'RPC_HTTP'); assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(blocked), /SECRET/);
  const timed = await preflightOrder({ readOrder: () => order(), endpoint, timeoutMs: 10, fetchImpl: () => new Promise(() => {}) });
  assert.equal(timed.code, 'RPC_TIMEOUT'); assert.equal(timed.networkRequests, 1);
});


test('prepared sign-only check uses saved partial bytes and hash; never refreshes/replans and binds the wallet contract', async () => {
  const h = harness({prepared:true}), before=h.initial(), report=await h.run();
  assert.equal(report.status,'wallet-check-passed',JSON.stringify(report));
  validateWalletCheck(report,before,h.signing.request);
  assert.equal(report.readyToSign,true);assert.equal(report.readyToSubmit,false);assert.equal(report.salesOpen,false);
  assert.equal(report.budget.complete,true);assert.equal(report.signaturesCreated+report.journalWrites+report.transactionsSent,0);
  assert.equal(h.calls.some(c=>c.method==='getLatestBlockhash'),false);
  assert.equal(h.calls.find(c=>c.method==='simulateTransaction').params[0],h.signing.request.transactionBase64);
  assert.deepEqual(h.initial(),before);
});
test('prepared check blocks stale/mutated/unknown requests, expiry and wrong network without a wallet grant', async () => {
  for(const transform of [
    (call,r)=>call.method==='isBlockhashValid'?{...r,value:false}:r,
    (call,r)=>call.method==='getGenesisHash'?GENESIS_HASHES['mainnet-beta']:r,
    (call,r)=>call.method==='simulateTransaction'?{...r,value:{err:{Custom:1}}}:r,
  ]) {const h=harness({prepared:true,transform});assert.equal((await h.run()).readyToSign,false);}
  const h=harness({prepared:true});
  const unknown=transitionOrder(h.initial(),{type:'unknown',revision:1,index:0,attempt:1});
  const stopped=await checkPreparedOrder({readOrder:()=>unknown,endpoint,...h.signing,fetchImpl:()=>assert.fail('RPC forbidden')});
  assert.equal(stopped.status,'blocked');assert.equal(stopped.networkRequests,0);
  h.signing.request.transactionBase64='AAAA';const report=await h.run();assert.equal(report.status,'blocked');assert.equal(report.networkRequests,0);
});
test('prepared freshness still detects order revision changes and ordinary buyers remain closed', async () => {
  const h=harness({prepared:true,revise:s=>transitionOrder(s,{type:'pause',revision:s.revision})});
  assert.equal((await h.run()).code,'ORDER_CHANGED');
  const buyer=Keypair.fromSeed(new Uint8Array(32).fill(20)).publicKey.toBase58();
  const closed=harness({prepared:true,buyer});assert.equal((await closed.run()).code,'SALES_CLOSED');assert.equal(closed.calls.length,2);
});
test('wallet check rejects forged bindings, missing network checks and expired/future grants', async () => {
  const h=harness({prepared:true}), report=await h.run();
  for(const edit of [r=>r.requestId='0'.repeat(64),r=>r.orderSha256='0'.repeat(64),r=>r.cluster='mainnet-beta',
    r=>r.candidate.transactionBase64='AAAA',r=>r.candidate.lastValidBlockHeight++,r=>r.guardPriceVerified=false,
    r=>r.readyToSubmit=true,r=>r.salesOpen=true,r=>r.expiresAt=Date.now()-1,r=>r.checkedAt=Date.now()+1000,
    r=>r.expiresAt=r.checkedAt+20001]) {
    const changed=structuredClone(report);edit(changed);assert.throws(()=>validateWalletCheck(changed,h.initial(),h.signing.request),/PREFLIGHT_BLOCKED/);
  }
});

test('complete first-item quote includes Core charge; the full quantity is explicitly a projection',async()=>{
  const h=harness({quantity:50}),report=await h.run();
  assert.equal(report.budget.scope,'next-item-current-template');assert.equal(report.budget.priorityFeeLamports,'0');
  assert.equal(report.budget.projectedOrderTotalLamports,String(203509999n*50n));assert.equal(report.budget.projectionOnly,true);
  const poor=harness({transform:(call,r)=>call.method==='getBalance'?{...r,value:202009999}:r});
  assert.equal((await poor.run()).code,'INSUFFICIENT_BALANCE');assert.equal(poor.calls.some(c=>c.method==='simulateTransaction'),false);
});
test('missing, changed or unsupported simulated asset costs never grant signing',async()=>{
  for(const change of [v=>v.accounts=null,v=>v.accounts=[],v=>v.accounts[0]=null,
    v=>v.accounts[0].lamports--,v=>v.accounts[0].lamports++,v=>v.accounts[0].owner=policy.owner,
    v=>v.accounts[0].executable=true,v=>v.accounts[0].data[0]+='AAAA',
    v=>{v.accounts[0].data[0]=Buffer.from(baseAssetBytes(policy,order(),'0000')).toString('base64');}]){
    const h=harness({prepared:true,transform:(call,r)=>{if(call.method==='simulateTransaction')change(r.value);return r;}});
    const report=await h.run();assert.equal(report.code,'MINT_COST_UNVERIFIED');assert.equal(report.readyToSign,false);
  }
});
test('prepared checker refuses missing provenance before RPC and rejects downgraded wallet grants',async()=>{
  const h=harness({prepared:true}),{blockhashAnchor,...signing}=h.signing;
  const blocked=await checkPreparedOrder({readOrder:h.readOrder,endpoint,...signing,fetchImpl:()=>assert.fail('RPC forbidden')});
  assert.equal(blocked.code,'BLOCKHASH_ANCHOR_REQUIRED');assert.equal(blocked.networkRequests,0);
  const report=await h.run();
  for(const mutate of [r=>delete r.blockhashProvenanceVerified,r=>r.budget.complete=false,r=>r.budget.scope='whole-order']){
    const value=structuredClone(report);mutate(value);assert.throws(()=>validateWalletCheck(value,h.initial(),h.signing.request));
  }
});

test('a confirmed RPC response older than the original blockhash source cannot support a wallet check',async()=>{
  const h=harness({prepared:true});h.signing.blockhashAnchor.sourceSlot=700;
  const report=await h.run();assert.equal(report.code,'RPC_CONTEXT');assert.equal(report.readyToSign,false);
  assert.equal(h.calls.find(c=>c.method==='getFeeForMessage').params[1].minContextSlot,700);
});
