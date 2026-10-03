import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import {base58} from '@metaplex-foundation/umi/serializers';
import policy from '../../metadata/policy.json' with {type:'json'};
import {createOrderModel,createProtocolOrderModel,validateOrderStorageOptions} from '../orders/journal-model.mjs';
import {createOrderPlanner} from '../orders/transaction-model.mjs';
import {prepareAssetClaim,validateAssetClaim,finalizeAssetRequest,verifyBuyerSigningResponse} from '../orders/signing.mjs';
import {validateSequentialOrder,currentItemIndex} from '../orders/sequential.mjs';
import {preparationFor,validatePreparation} from '../orders/preparation.mjs';
import {validateBuyerSubmission,validateBuyerResult,submissionBinding} from '../orders/submission.mjs';
import {validateConsoleConfig,createScopeIndex} from '../orders/buyer-console/config.mjs';
import {makeBuyerGateway,validateBuyerGatewayConfig} from '../orders/gateway/worker.mjs';
import {prepareBuyerGateway} from '../orders/gateway/prepare.mjs';
import {createOrderPreflight} from '../orders/preflight.mjs';
import {runOrderCheck} from '../orders/check.mjs';
const key=label=>Keypair.fromSeed(createHash('sha256').update('hidden-orders:'+label).digest());
const address=label=>key(label).publicKey.toBase58();
const profile={storageMode:'hidden-settings',hiddenCommitmentSha256:'a'.repeat(64)};
const other={...profile,hiddenCommitmentSha256:'b'.repeat(64)};
const block={blockhash:address('hash'),lastValidBlockHeight:2000};
const origin='https://hidden-buyer.test';
const fields={id:'hidden-order',cluster:'devnet',buyer:address('buyer'),machine:address('machine'),collection:address('collection'),guard:address('guard'),quantity:1,available:9999,assets:[address('asset-0')]};
function fixture(quantity=1){
  const model=createOrderModel(policy,profile),planner=createOrderPlanner(model);
  const order=model.createOrder({...fields,quantity,assets:Array.from({length:quantity},(_,i)=>address('asset-'+i))});
  const template=planner.buildOrderTransactions(order,block).templates[0];
  const candidate={orderRevision:0,itemIndex:0,...block,transactionBase64:Buffer.from(template.unsignedBytes).toString('base64')};
  const prepared=prepareAssetClaim(order,candidate),partial=VersionedTransaction.deserialize(template.unsignedBytes);
  partial.sign([key('asset-0')]);
  const request=finalizeAssetRequest(prepared.order,prepared.claim,partial.signatures[1]);
  const signed=VersionedTransaction.deserialize(Buffer.from(request.transactionBase64,'base64'));signed.sign([key('buyer')]);
  const response={transactionBase64:Buffer.from(signed.serialize()).toString('base64')};
  return{model,planner,order,candidate,prepared,request,response,template};
}
const config=order=>({version:2,origin,cluster:order.cluster,machine:order.machine,collection:order.collection,guard:order.guard,...profile});
function proof(order,claim,signature,index=1){return{kind:'verified',cluster:order.cluster,machine:order.machine,collection:order.collection,buyer:order.buyer,
  asset:claim.asset,blockhash:claim.blockhash,messageSha256:claim.messageSha256,commitment:'finalized',slot:650,signature,accountSlot:700,
  account:{program:'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',owner:order.buyer,collection:order.collection,name:`CoolBears #${index}`,uri:policy.website+`/metadata/hidden-indexed/${index}.json`}};}

test('hidden records require explicit trusted profile; default orders preserve exact v1 shape',()=>{
  const legacy=createOrderModel(policy),hidden=createOrderModel(policy,profile),order=hidden.createOrder(fields);
  const before=legacy.createOrder(fields);
  assert.equal(before.version,1);assert.ok(!Object.hasOwn(before,'storageMode'));assert.ok(!Object.hasOwn(before,'hiddenCommitmentSha256'));
  assert.equal(order.version,2);assert.equal(order.storageMode,profile.storageMode);assert.equal(order.hiddenCommitmentSha256,profile.hiddenCommitmentSha256);
  assert.throws(()=>legacy.validateOrder(order));assert.throws(()=>hidden.validateOrder(before));
  assert.throws(()=>createOrderModel(policy,other).validateOrder(order),/ORDER_STORAGE_PROFILE_MISMATCH/);
  assert.throws(()=>legacy.createOrder({...fields,...profile}),/ORDER_STORAGE_PROFILE_MISMATCH/);
  assert.throws(()=>hidden.createOrder({...fields,...other}),/ORDER_STORAGE_PROFILE_MISMATCH/);
  for(const invalid of [null,[],{storageMode:'legacy'},{hiddenCommitmentSha256:profile.hiddenCommitmentSha256},{...profile,hiddenCommitmentSha256:'0'.repeat(64)}, {...profile,hiddenCommitmentSha256:'A'.repeat(64)},{...profile,secret:'never'}])assert.throws(()=>validateOrderStorageOptions(invalid));
});

test('hidden and previous v1 local journals coexist and cannot overwrite or resume one another',()=>{
  const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},legacy=createOrderModel(policy),f=fixture();
  legacy.saveOrder(storage,legacy.createOrder(fields));f.model.saveOrder(storage,f.order);
  assert.equal(values.size,2);assert.ok(values.has('coolbears:offline-order:v1:'+fields.id));
  assert.equal(legacy.readOrder(storage,fields.id).version,1);assert.equal(f.model.readOrder(storage,fields.id).version,2);
  assert.equal(createOrderModel(policy,other).readOrder(storage,fields.id),null);
  f.model.saveOrder(storage,f.prepared.order,0);
  assert.throws(()=>f.model.saveOrder(storage,{...f.prepared.order,hiddenCommitmentSha256:other.hiddenCommitmentSha256},0));
  assert.equal(legacy.readOrder(storage,fields.id).revision,0);
});

for(const quantity of [1,50])test(`hidden ${quantity}-item unsigned planning charges buyer, preserves 0.2 SOL and binds profile in signing identity`,()=>{
  const f=fixture(quantity),legacy=createOrderModel(policy).createOrder({...fields,quantity,assets:f.order.items.map(i=>i.asset)});
  const oldTemplate=createOrderPlanner(createOrderModel(policy)).buildOrderTransactions(legacy,block).templates[0];
  assert.deepEqual(f.template.unsignedBytes,oldTemplate.unsignedBytes);
  assert.equal(f.template.feePayer,f.order.buyer);assert.equal(f.template.payment.destination,policy.owner);assert.equal(f.template.payment.lamports,'200000000');
  assert.deepEqual(f.template.requiredSigners,[f.order.buyer,f.order.items[0].asset]);
  const oldClaim=prepareAssetClaim(legacy,{...f.candidate,transactionBase64:Buffer.from(oldTemplate.unsignedBytes).toString('base64')}).claim;
  assert.notEqual(f.prepared.claim.orderIdentitySha256,oldClaim.orderIdentitySha256);
  assert.throws(()=>validateAssetClaim({...f.prepared.order,...other},f.prepared.claim),/ASSET_CLAIM_BINDING/);
  assert.throws(()=>validateAssetClaim({...f.prepared.order,version:1,storageMode:undefined},f.prepared.claim));
  const result=verifyBuyerSigningResponse(f.prepared.order,f.prepared.claim,f.request,f.response);
  assert.equal(result.readyToSubmit,false);assert.equal(result.salesOpen,false);
  validatePreparation(f.order,preparationFor(f.order,block,600));
});

test('hidden finalized proofs accept exact plain decimal mint metadata and reject padded/legacy/foreign/zero/out-of-range/name mismatches',()=>{
  const f=fixture(),signed=verifyBuyerSigningResponse(f.prepared.order,f.prepared.claim,f.request,f.response);
  const order=f.model.transitionOrder(f.prepared.order,{type:'signature',revision:1,index:0,attempt:1,signature:signed.signature,messageSha256:signed.messageSha256});
  const valid=proof(order,f.prepared.claim,signed.signature,9999);
  assert.equal(f.model.transitionOrder(order,{type:'reconcile',revision:2,index:0,attempt:1,proof:valid}).items[0].attempts[0].state,'verified');
  const accountChanges=[{uri:policy.website+'/metadata/hidden-indexed/0001.json'},{uri:policy.website+'/metadata/hidden/0001.json'},
    {uri:'https://foreign.test/metadata/hidden-indexed/1.json'},{name:'CoolBears #0001'},{name:'CoolBears #1 — Hidden Bear'},
    {uri:policy.website+'/metadata/hidden-indexed/0.json'},{uri:policy.website+'/metadata/hidden-indexed/10000.json'}];
  for(const change of accountChanges)assert.throws(()=>f.model.transitionOrder(order,{type:'reconcile',revision:2,index:0,attempt:1,proof:{...valid,account:{...valid.account,...change}}}),/WRONG_METADATA/);
  const verified=f.model.transitionOrder(order,{type:'reconcile',revision:2,index:0,attempt:1,proof:valid});
  assert.equal(currentItemIndex(verified),null);assert.doesNotThrow(()=>validateSequentialOrder(verified));
});

test('hidden unknown wallet outcome survives portable recovery, exact proof and mode mismatch remains blocked',()=>{
  const f=fixture(),model=createProtocolOrderModel(policy);
  let order=model.transitionOrder(f.prepared.order,{type:'unknown',revision:1,index:0,attempt:1});
  const signed=verifyBuyerSigningResponse(order,f.prepared.claim,f.request,f.response);
  order=model.transitionOrder(order,{type:'signature',revision:2,index:0,attempt:1,signature:signed.signature,messageSha256:signed.messageSha256});
  const input={order,claim:f.prepared.claim,request:f.request,response:f.response};
  validateBuyerSubmission(input);
  const p=proof(order,f.prepared.claim,signed.signature);
  const report={...submissionBinding(input),cluster:'devnet',transactionsSent:0,readyToSubmit:false,salesOpen:false,status:'verified',chainVerified:true,proof:p,networkRequests:4};
  assert.doesNotThrow(()=>validateBuyerResult(report,input,{recovery:true}));
  assert.equal(model.nextAction(JSON.parse(JSON.stringify(order))).type,'reconcile');
  assert.throws(()=>validateBuyerSubmission({...input,order:{...order,...other}}),/ASSET_CLAIM_BINDING/);
});
test('hidden console and gateway pin profile; old config rejects hidden keys and hidden gateway denies mode/hash downgrade before any RPC',async()=>{
  const f=fixture(),c=config(f.order);
  assert.deepEqual(validateConsoleConfig(c),c);assert.deepEqual(validateBuyerGatewayConfig(c),c);
  for(const hiddenCommitmentSha256 of ['0'.repeat(64),'A'.repeat(64),new String('a'.repeat(64)),null]){
    assert.throws(()=>validateConsoleConfig({...c,hiddenCommitmentSha256}));assert.throws(()=>validateBuyerGatewayConfig({...c,hiddenCommitmentSha256}));
  }
  const old={version:1,origin,cluster:c.cluster,machine:c.machine,collection:c.collection,guard:c.guard};
  assert.throws(()=>validateConsoleConfig({...old,...profile}));assert.throws(()=>validateBuyerGatewayConfig({...old,...profile}));
  let calls=0;const storage={get:async()=>undefined,put:async()=>{calls++;},transaction:async fn=>fn(storage)};
  const {BuyerCheckGate}=makeBuyerGateway(c),gate=new BuyerCheckGate({storage},{BUYER_HELIUS_API_KEY:'fixture-secret-42'},{fetchImpl:()=>{calls++;throw Error('unexpected RPC');}});
  for(const order of [{...f.order,...other},{...f.order,storageMode:'config-lines'},createOrderModel(policy).createOrder(fields)]){
    const response=await gate.fetch(new Request(origin+'/api/buyer/prepare',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({version:1,nonce:'c'.repeat(64),order:{...order,buyer:policy.owner}})}));
    assert.equal(response.status,400);assert.equal((await response.json()).code,'DEPLOYMENT_STORAGE_PROFILE');
  }
  const send=await gate.fetch(new Request(origin+'/api/buyer/send',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'}));
  assert.equal(send.status,403);assert.equal(calls,0);
  const values=new Map(),localStorage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},locks={request:async(_k,_o,fn)=>fn()};
  const index=createScopeIndex({config:c,localStorage,locks});await index.save({id:fields.id,buyer:fields.buyer});
  assert.equal(createScopeIndex({config:{...c,...other},localStorage,locks}).list().length,0);
  assert.equal(createScopeIndex({config:old,localStorage,locks}).list().length,0);
});

test('explicit hidden gateway preparation pins v2 hash without overwriting the previous candidate and default preparation denies hidden records',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'coolbears-hidden-order-'));
  try{
    const order=fixture().order,file=join(directory,'order.json'),target=join(directory,'gateway');await writeFile(file,JSON.stringify(order));
    await assert.rejects(prepareBuyerGateway(file,origin,{directory:target}));
    const report=await prepareBuyerGateway(file,origin,{directory:target,storageOptions:profile});assert.equal(report.deployed,false);assert.equal(report.salesOpen,false);
    assert.deepEqual(JSON.parse(await readFile(join(target,'config.json'),'utf8')),config(order));
    await assert.rejects(prepareBuyerGateway(file,origin,{directory:target,storageOptions:profile}));
    let output='';const code=await runOrderCheck(['preflight','--storage-profile',join(directory,'profile.json'),file],{output:{write:s=>{output+=s;}}});
    assert.equal(code,1);assert.equal(JSON.parse(output).code,'ORDER_STORAGE_PROFILE');
    let reads=0;const legacy=await createOrderPreflight().preflightOrder({readOrder:()=>{reads++;return order;}});assert.equal(legacy.status,'blocked');assert.equal(reads,1);
  }finally{await rm(directory,{recursive:true,force:true});}
});
