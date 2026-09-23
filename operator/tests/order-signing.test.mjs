import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { createHash } from 'node:crypto';
import { createOrder, transitionOrder } from '../orders/journal.mjs';
import { buildOrderTransactions } from '../orders/transactions.mjs';
import { prepareAssetClaim, validateAssetClaim, finalizeAssetRequest, validateAssetRequest, verifyBuyerSigningResponse } from '../orders/signing.mjs';
const key = n => Keypair.fromSeed(createHash('sha256').update(`buyer-signing-fixture-${n}`).digest());
const buyer = key('buyer'), asset = key('asset');
const address = n => key(n).publicKey.toBase58();
const block = {blockhash:address('hash'),lastValidBlockHeight:2000};
const encode = tx => Buffer.from(tx.serialize()).toString('base64');
function fixture(quantity=1) {
  const order=createOrder({id:'signing-fixture',cluster:'devnet',buyer:buyer.publicKey.toBase58(),machine:address('machine'),collection:address('collection'),guard:address('guard'),quantity,available:9999,
    assets:Array.from({length:quantity},(_,i)=>i===0?asset.publicKey.toBase58():address(`asset-${i}`))});
  const template=buildOrderTransactions(order,block).templates[0];
  const input={orderRevision:0,itemIndex:0,...block,transactionBase64:Buffer.from(template.unsignedBytes).toString('base64')};
  const prepared=prepareAssetClaim(order,input);
  const partial=VersionedTransaction.deserialize(template.unsignedBytes);partial.sign([asset]);
  const request=finalizeAssetRequest(prepared.order,prepared.claim,partial.signatures[1]);
  const signed=VersionedTransaction.deserialize(Buffer.from(request.transactionBase64,'base64'));signed.sign([buyer]);
  return {order,input,prepared,partial,request,response:{transactionBase64:encode(signed)}};
}
for(const quantity of [1,50]) test(`exact first message of ${quantity}-item order binds stable asset and buyer-only response`,()=>{
  const f=fixture(quantity);assert.equal(f.prepared.order.revision,1);assert.equal(f.prepared.order.items[0].attempts[0].state,'wallet-pending');
  assert.ok(f.partial.signatures[0].every(x=>x===0));assert.ok(f.partial.signatures[1].some(Boolean));
  assert.deepEqual(validateAssetRequest(f.prepared.order,f.prepared.claim,f.request),f.request);
  const verified=verifyBuyerSigningResponse(f.prepared.order,f.prepared.claim,f.request,f.response);
  assert.equal(verified.readyToSubmit,false);assert.equal(verified.salesOpen,false);assert.equal(verified.messageSha256,f.request.messageSha256);
  assert.equal(f.order.revision,0);assert.ok(f.order.items.every(i=>i.attempts.length===0));
});

test('network and order history labels cannot turn stale/paused/retry input into a fresh signing claim',()=>{
  const f=fixture();
  assert.throws(()=>prepareAssetClaim({...f.order,cluster:'mainnet-beta'},f.input),/DEVNET_ONLY/);
  assert.throws(()=>prepareAssetClaim(f.order,{...f.input,orderRevision:1}),/STALE_REVISION/);
  assert.throws(()=>prepareAssetClaim({...f.order,paused:true},f.input),/FRESH_ORDER_REQUIRED/);
  assert.throws(()=>prepareAssetClaim(f.prepared.order,{...f.input,orderRevision:1}),/FRESH_ORDER_REQUIRED/);
  assert.throws(()=>prepareAssetClaim(fixture(2).order,{...f.input,itemIndex:1}),/FIRST_ITEM_REQUIRED/);
  assert.throws(()=>prepareAssetClaim(f.order,{...f.input,extra:true}),/SIGNING_FIELDS/);
});

test('unsigned-byte comparison blocks changed account roles, guard, collection, compute budget, instructions and lookup tables',()=>{
  const f=fixture();
  const mutations=[
    tx=>{tx.message.staticAccountKeys[0]=key('other').publicKey;},
    tx=>{tx.message.staticAccountKeys[1]=key('other').publicKey;},
    tx=>{tx.message.staticAccountKeys[tx.message.staticAccountKeys.findIndex(k=>k.toBase58()===f.order.guard)]=key('other').publicKey;},
    tx=>{tx.message.staticAccountKeys[tx.message.staticAccountKeys.findIndex(k=>k.toBase58()===f.order.collection)]=key('other').publicKey;},
    tx=>{tx.message.staticAccountKeys[tx.message.staticAccountKeys.findIndex(k=>k.toBase58()===f.order.treasury)]=key('other').publicKey;},
    tx=>{tx.message.compiledInstructions[0].data[1]^=1;},
    tx=>{tx.message.compiledInstructions[1].data[0]^=1;},
    tx=>{tx.message.compiledInstructions.push(tx.message.compiledInstructions[0]);},
    tx=>{tx.message.header.numReadonlySignedAccounts=1;},
    tx=>{tx.message.addressTableLookups.push({accountKey:key('lookup').publicKey,writableIndexes:[0],readonlyIndexes:[]});},
    tx=>{tx.message.recentBlockhash=address('other');},
    tx=>{tx.signatures[0].fill(1);},
    tx=>{tx.signatures[1].fill(1);},
  ];
  for(const mutate of mutations){const tx=VersionedTransaction.deserialize(Buffer.from(f.input.transactionBase64,'base64'));mutate(tx);assert.throws(()=>prepareAssetClaim(f.order,{...f.input,transactionBase64:encode(tx)}),/ORDER_MESSAGE_MISMATCH/);}
});

test('noncanonical, trailing, oversized or missing bytes never enter the signing claim',()=>{
  const f=fixture();
  for(const transactionBase64 of ['',null,' '.repeat(4),f.input.transactionBase64+'\n','A'.repeat(1648),Buffer.concat([Buffer.from(f.input.transactionBase64,'base64'),Buffer.from([0])]).toString('base64')])
    assert.throws(()=>prepareAssetClaim(f.order,{...f.input,transactionBase64}));
  assert.throws(()=>prepareAssetClaim(f.order,{...f.input,blockhash:address('other')}),/ORDER_MESSAGE_MISMATCH/);
  assert.throws(()=>prepareAssetClaim(f.order,{...f.input,lastValidBlockHeight:0}));
});

test('small-order signer keys are rejected before creating a claim',()=>{
  const f=fixture();const identity=new PublicKey(Uint8Array.from([1,...new Uint8Array(31)])).toBase58();
  assert.throws(()=>prepareAssetClaim({...f.order,buyer:identity},f.input),/UNSIGNABLE_ADDRESS/);
});

test('claim cannot be transplanted to another order, lifetime, asset, revision or attempt',()=>{
  const f=fixture();
  for(const change of [{orderId:'other'},{orderRevision:2},{attempt:2},{itemIndex:1},{asset:address('other')},{lastValidBlockHeight:2001},{orderIdentitySha256:'0'.repeat(64)},{messageSha256:'0'.repeat(64)}])
    assert.throws(()=>validateAssetClaim(f.prepared.order,{...f.prepared.claim,...change}));
  assert.throws(()=>validateAssetClaim({...f.prepared.order,availableAtPlanning:9000},f.prepared.claim),/ASSET_CLAIM_BINDING/);
});

test('self-consistent forged hash still cannot authorize altered SDK message',()=>{
  const f=fixture(),tx=VersionedTransaction.deserialize(Buffer.from(f.input.transactionBase64,'base64'));tx.message.compiledInstructions[0].data[1]^=1;
  const forged={...f.prepared.claim,transactionBase64:encode(tx),messageSha256:createHash('sha256').update(tx.message.serialize()).digest('hex')};
  const order=structuredClone(f.prepared.order);order.items[0].attempts[0].messageSha256=forged.messageSha256;
  assert.throws(()=>validateAssetClaim(order,forged),/ORDER_MESSAGE_MISMATCH/);
});

test('invalid, wrong-key and buyer-signed partial requests are rejected',()=>{
  const f=fixture(),message=validateAssetClaim(f.prepared.order,f.prepared.claim);
  for(const sig of [new Uint8Array(64),new Uint8Array(63),ed25519.sign(message,key('wrong').secretKey.subarray(0,32))])
    assert.throws(()=>finalizeAssetRequest(f.prepared.order,f.prepared.claim,sig));
  assert.throws(()=>validateAssetRequest(f.prepared.order,f.prepared.claim,{...f.request,transactionBase64:f.response.transactionBase64}));
  assert.throws(()=>validateAssetRequest(f.prepared.order,f.prepared.claim,{...f.request,asset:address('other')}),/ASSET_REQUEST_BINDING/);
});

test('wallet response must preserve exact bytes and original asset signature, with a real buyer signature',()=>{
  const f=fixture();
  assert.throws(()=>verifyBuyerSigningResponse(f.prepared.order,f.prepared.claim,f.request,{transactionBase64:f.request.transactionBase64}));
  for(const mutation of ['hash','asset-signature','buyer-signature','role']){
    const tx=VersionedTransaction.deserialize(Buffer.from(f.response.transactionBase64,'base64'));
    if(mutation==='hash'){tx.message.recentBlockhash=address('other');tx.sign([buyer,asset]);}
    if(mutation==='asset-signature')tx.signatures[1][5]^=1;
    if(mutation==='buyer-signature')tx.signatures[0][5]^=1;
    if(mutation==='role')tx.message.staticAccountKeys[0]=key('other').publicKey;
    assert.throws(()=>verifyBuyerSigningResponse(f.prepared.order,f.prepared.claim,f.request,{transactionBase64:encode(tx)}));
  }
  assert.throws(()=>verifyBuyerSigningResponse(f.prepared.order,f.prepared.claim,f.request,{...f.response,extra:true}));
});

test('late verified response is evidence only and does not mutate unknown state or overwrite a known signature',()=>{
  const f=fixture();let unknown=transitionOrder(f.prepared.order,{type:'unknown',revision:1,index:0,attempt:1});
  const before=JSON.stringify(unknown);const result=verifyBuyerSigningResponse(unknown,f.prepared.claim,f.request,f.response);
  assert.equal(JSON.stringify(unknown),before);assert.equal(result.readyToSubmit,false);assert.equal(result.orderRevision,2);
  unknown=transitionOrder(unknown,{type:'signature',revision:2,index:0,attempt:1,messageSha256:f.request.messageSha256,signature:result.signature});
  assert.equal(unknown.items[0].attempts[0].state,'unknown');assert.doesNotThrow(()=>verifyBuyerSigningResponse(unknown,f.prepared.claim,f.request,f.response));
  unknown.items[0].attempts[0].signature=base58.deserialize(new Uint8Array(64).fill(9))[0];
  assert.throws(()=>verifyBuyerSigningResponse(unknown,f.prepared.claim,f.request,f.response),/BUYER_SIGNATURE_CONFLICT/);
  const signed=transitionOrder(f.prepared.order,{type:'signature',revision:1,index:0,attempt:1,messageSha256:f.request.messageSha256,signature:result.signature});
  assert.throws(()=>verifyBuyerSigningResponse(signed,f.prepared.claim,f.request,f.response),/BUYER_RESPONSE_NOT_EXPECTED/);
});
