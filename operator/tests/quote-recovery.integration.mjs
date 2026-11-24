// Intercepted RPC fixtures and official unsigned SDK instructions only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';
import { policy } from '../../scripts/hidden-metadata.mjs';
import { Keypair } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { prepareAssetClaim, finalizeAssetRequest } from '../orders/signing.mjs';
import { GENESIS_HASHES } from '../deployment/rpc.mjs';
import { createAccountVerifier } from '../deployment/accounts-model.mjs';
import { createOrderModel } from '../orders/journal-model.mjs';
import { createOrderPlanner } from '../orders/transaction-model.mjs';
import { createOrderChecker } from '../orders/public-preflight-model.mjs';
import { baseAssetBytes, CORE_CREATE_LAMPORTS } from '../orders/mint-cost.mjs';
import { hiddenAccountFixtures, fixtureRpcAccount } from './fixtures/hidden-accounts.mjs';

const address = label => { for (let n = 0; ; n++) {
  const bytes = createHash('sha256').update(`hidden-preflight-fixture:${label}:${n}`).digest();
  if (PublicKey.isOnCurve(bytes)) return new PublicKey(bytes).toBase58();
} };
const options = { storageMode: 'hidden-settings', hiddenCommitmentSha256:
  createHash('sha256').update('SYNTHETIC-PREFLIGHT-PRIVATE-MAPPING').digest('hex') };
const roles = { machine: address('machine'), collection: address('collection') };
const fixture = hiddenAccountFixtures({ policy, storageOptions: options, roles });
const model = createOrderModel(policy, options), planner = createOrderPlanner(model);
const verifier = createAccountVerifier(policy, options);
const checker = createOrderChecker(policy, { ...model, ...planner, ...verifier }, options);
const blockhash = address('blockhash'), endpoint = 'https://hidden-preflight-fixture.test/';

function harness({ redeemed = 0, finalRedeemed = redeemed, simulatedIndex = redeemed + 1,
  balance, orderMutation, mutate } = {}) {
  const assetKey=Keypair.fromSeed(new Uint8Array(32).fill(19)); const order = model.createOrder({ id: 'hidden-cost-fixture', cluster: 'devnet', buyer: policy.owner,
    machine: roles.machine, collection: roles.collection, guard: fixture.guard,
    quantity: 1, available: 9999, assets:[assetKey.publicKey.toBase58()] });
  const block={blockhash,lastValidBlockHeight:2000}, transactionBase64=Buffer.from(planner.buildOrderTransactions(order,block).templates[0].unsignedBytes).toString('base64');
  const {claim,order:saved}=prepareAssetClaim(order,{orderRevision:0,itemIndex:0,...block,transactionBase64});
  const request=finalizeAssetRequest(saved,claim,ed25519.sign(VersionedTransaction.deserialize(Buffer.from(transactionBase64,'base64')).message.serialize(),assetKey.secretKey.slice(0,32)));
  const blockhashAnchor={version:1,orderIdentitySha256:claim.orderIdentitySha256,messageSha256:claim.messageSha256,...block,sourceSlot:600};
  const assetSize = baseAssetBytes(policy, order, redeemed + 1, options).length;
  const rent = BigInt((assetSize + 128) * 5080);
  const budgetAssetSize = baseAssetBytes(policy, order, policy.supply - 1, options).length;
  const budgetRent = BigInt((budgetAssetSize + 128) * 5080);
  const actualMinimum = 200000000n + 10000n + rent + CORE_CREATE_LAMPORTS;
  const minimum = 200000000n + 10000n + budgetRent + CORE_CREATE_LAMPORTS;
  let accountReads = 0; const calls = [];
  const fetchImpl = async (_url, init) => {
    const call = JSON.parse(init.body); calls.push(call);
    if (call.method === 'getMultipleAccounts') accountReads++;
    const currentRedeemed = accountReads > 1 ? finalRedeemed : redeemed;
    const assets = baseAssetBytes(policy, order, simulatedIndex, options);
    let result = {
      getGenesisHash: GENESIS_HASHES.devnet,
      getMultipleAccounts: { context: { slot: 600 }, value: [
        {executable:true,owner:'BPFLoaderUpgradeab1e11111111111111111111111',lamports:1}, {executable:true,owner:'BPFLoaderUpgradeab1e11111111111111111111111',lamports:1}, {executable:true,owner:'BPFLoaderUpgradeab1e11111111111111111111111',lamports:1},
        fixture.machineAccount(currentRedeemed), fixture.guardAccount(),
        fixture.collectionAccount(currentRedeemed), null] },
      getBalance: { context: { slot: 600 }, value: balance ?? Number(minimum) },
      getLatestBlockhash: { context: { slot: 600 }, value: { blockhash, lastValidBlockHeight: 2000 } },
      getFeeForMessage: { context: { slot: 600 }, value: 10000 },
      getMinimumBalanceForRentExemption: (call.params[0] + 128) * 5080,
      simulateTransaction: { context: { slot: 600 }, value: { err: null,
        unitsConsumed: 99999, accounts: [fixtureRpcAccount(assets, MPL_CORE_PROGRAM_ID,
          Number(rent + CORE_CREATE_LAMPORTS))] } },
      isBlockhashValid: { context: { slot: 600 }, value: true }, getBlockHeight: 1800,
    }[call.method];
    assert.notEqual(result, undefined, call.method);
    if (mutate) result = mutate(call, result, accountReads); if (result?.jsonRpcError) return new Response(JSON.stringify({jsonrpc:'2.0',id:call.id,error:{code:-32016,message:'Minimum context slot has not been reached'}}));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
  };
  return { order, calls, assetSize, rent, budgetAssetSize, budgetRent, actualMinimum, minimum, run: () => checker.checkPreparedOrder({claim,request,blockhashAnchor,
    readOrder: () => orderMutation ? orderMutation(structuredClone(order)) : structuredClone(saved), endpoint, fetchImpl }) };
}


test('saved unsigned NFT gets its quote even if a final balance read briefly falls behind',async()=>{
  let refused=0;const h=harness({mutate:(call,result,reads)=>call.method==='getBalance'&&reads>1&&!refused++?{jsonRpcError:true}:result});
  const r=await h.run();assert.equal(r.status,'wallet-check-passed',JSON.stringify(r));assert.equal(h.calls.filter(c=>c.method==='simulateTransaction').length,1);
  const b=h.calls.filter(c=>c.method==='getBalance');assert.equal(b.length,3);assert.deepEqual(b[1].params,b[2].params);
  assert.equal(r.signaturesCreated+r.transactionsSent+r.journalWrites,0);
});
test('an expired unsigned message with no fee result stops before simulation; invalid simulation cannot become a quote',async()=>{
  const noFee=harness({mutate:(call,res)=>call.method==='getFeeForMessage'?{...res,value:null}:res});
  assert.equal((await noFee.run()).code,'FEE_UNAVAILABLE');assert.equal(noFee.calls.some(c=>c.method==='simulateTransaction'),false);
  const h=harness({mutate:(c,r)=>c.method==='simulateTransaction'?{...r,value:{...r.value,err:'BlockhashNotFound'}}:r});
  const rejected=await h.run();assert.equal(rejected.code,'SIMULATION_FAILED');assert.equal(rejected.readyToSign,false);
});
