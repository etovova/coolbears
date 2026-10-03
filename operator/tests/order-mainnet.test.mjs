// Disposable SDK fixtures only. Every RPC call is intercepted; no real wallet or chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VersionedTransaction} from '@solana/web3.js';
import policy from '../../metadata/policy.json' with {type:'json'};
import {networkProfile} from '../deployment/network.mjs';
import {hiddenBuyerGatewayFixture} from './fixtures/hidden-buyer-gateway.mjs';
import {buyerGatewayFixture} from './fixtures/buyer-gateway.mjs';
import {makeBuyerGateway,validateBuyerGatewayConfig} from '../orders/gateway/worker.mjs';
import {prepareBuyerGateway} from '../orders/gateway/prepare.mjs';
import {validateWalletCheck,createBuyerWalletClient,compatibleBuyerWallet} from '../orders/wallet-client.mjs';
import {createBuyerStorage} from '../orders/browser-storage.mjs';
import {createBuyerSender} from '../orders/sender.mjs';
import {validateAssetClaim} from '../orders/signing.mjs';
import {validateBuyerSubmission,validateBuyerResult,submissionBinding} from '../orders/submission.mjs';
import {runOrderCheck} from '../orders/check.mjs';

const cluster='mainnet-beta',network=networkProfile(cluster),origin='https://mainnet-buyer-fixture.test',nonce='c'.repeat(64);
function harness(f,{options={},initial=[]}={}){
  let now=Date.now();const data=new Map([...f.preparations,...initial]),urls=[];
  const storage={get:async key=>structuredClone(data.get(key)),put:async(key,value)=>data.set(key,structuredClone(value)),transaction:async fn=>fn(storage)};
  const built=makeBuyerGateway(f.config(origin),{allowMainnet:true,...(f.storageOptions?{trustedHiddenCommitmentSha256:f.storageOptions.hiddenCommitmentSha256}:{}),...options});
  const gate=new built.BuyerCheckGate({storage},{BUYER_HELIUS_API_KEY:'fixture-secret-42',RPC_UPSTREAM:'https://forbidden.test'},
    {clock:()=>now,pause:async ms=>{now+=ms;},fetchImpl:(url,init)=>{urls.push(String(url));return f.upstream(new Request(url,init));}});
  return{data,urls,built,advance:()=>{now+=1000;},dispatch:(input,route='check')=>gate.fetch(new Request(origin+'/api/buyer/'+route,
    {method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({version:1,nonce,...input})}))};
}

for(const quantity of [1,50])test(`Mainnet hidden ${quantity}-item native check binds full genesis, fixed upstream and v2 ledger`,async()=>{
  const f=hiddenBuyerGatewayFixture({cluster}),input=f.input('mainnet-'+quantity,quantity),h=harness(f);
  const response=await h.dispatch(input),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
  validateWalletCheck(body.report,input.order,input.request);
  assert.equal(body.report.mode,'closed-mainnet-beta-sign-only-check');assert.equal(body.report.cluster,cluster);assert.equal(body.report.genesisHash,network.genesisHash);
  assert.equal(body.report.budget.unitPriceLamports,'200000000');assert.equal(body.report.budget.protocolChargesLamports,'1500000');
  assert.equal(body.report.salesOpen,false);assert.equal(body.report.readyToSubmit,false);assert.equal(body.report.transactionsSent,0);
  assert.equal(f.calls.length,10);assert.ok(f.calls.every(c=>c.method!=='sendTransaction'));
  assert.ok(h.urls.every(url=>new URL(url).origin===new URL(network.rpcUpstream).origin));
  const ledger=h.data.get(`buyer-check-budget:v2:${cluster}:${network.genesisHash}`);
  assert.equal(ledger.version,2);assert.equal(ledger.cluster,cluster);assert.equal(ledger.genesisHash,network.genesisHash);assert.equal(h.data.has('buyer-check-budget:v1'),false);
  for(const change of [{genesisHash:undefined},{genesisHash:networkProfile('devnet').genesisHash},{cluster:'devnet'},{mode:'closed-devnet-sign-only-check'}])
    assert.throws(()=>validateWalletCheck({...body.report,...change},input.order,input.request),/PREFLIGHT_BLOCKED/);
  assert.throws(()=>validateAssetClaim({...input.order,cluster:'devnet'},input.claim),/ASSET_CLAIM_BINDING/);
});

test('Mainnet read/send grants, full genesis and external hidden commitment fail closed before upstream IO',async()=>{
  const f=hiddenBuyerGatewayFixture({cluster}),config=f.config(origin),hash=f.storageOptions.hiddenCommitmentSha256;
  for(const [value,options]of [
    [config,{}],[config,{allowSubmission:true}],
    [config,{allowMainnet:true}],
    [config,{allowMainnet:true,trustedHiddenCommitmentSha256:'b'.repeat(64)}],
    [config,{allowMainnet:true,allowSubmission:true,trustedHiddenCommitmentSha256:hash}],
    [config,{allowMainnet:true,allowSubmission:true,allowMainnetSubmission:true,trustedHiddenCommitmentSha256:hash}],
    [{...config,genesisHash:undefined},{allowMainnet:true,trustedHiddenCommitmentSha256:hash}],
    [{...config,genesisHash:networkProfile('devnet').genesisHash},{allowMainnet:true,trustedHiddenCommitmentSha256:hash}],
    [{...config,rpcUpstream:'https://forbidden.test'},{allowMainnet:true,trustedHiddenCommitmentSha256:hash}],
  ])assert.throws(()=>makeBuyerGateway(value,options));
  const devnet=hiddenBuyerGatewayFixture();assert.throws(()=>makeBuyerGateway(devnet.config(origin),{allowMainnet:true}),/MAINNET_SCOPE_REQUIRED/);
  assert.equal(f.calls.length,0);const input=f.input('send-disabled'),h=harness(f);
  assert.equal((await h.dispatch(input,'send')).status,403);assert.equal(f.calls.length,0);
  const bad=await h.dispatch({...input,cluster:'devnet',rpcUpstream:'https://forbidden.test'});assert.equal(bad.status,400);assert.equal(f.calls.length,0);
  f.setMode('wrong-genesis');const rejected=await h.dispatch(input),body=await rejected.json();assert.equal(body.report.code,'RPC_GENESIS');
  assert.deepEqual(f.calls.map(c=>c.method),['getGenesisHash']);assert.equal(body.report.readyToSign,false);
});

test('Mainnet ledger rejects persisted Devnet state and wrong full genesis before all upstream calls',async()=>{
  const budget={day:Math.floor(Date.now()/86400000),checks:0,rpc:0,simulations:0,nextAt:0,holdUntil:0,cooldownUntil:0};
  for(const value of [{version:1,...budget},{version:2,cluster:'devnet',genesisHash:networkProfile('devnet').genesisHash,...budget},
    {version:2,cluster,genesisHash:networkProfile('devnet').genesisHash,...budget}]){
    const f=hiddenBuyerGatewayFixture({cluster}),input=f.input('ledger'),h=harness(f,{initial:[[ `buyer-check-budget:v2:${cluster}:${network.genesisHash}`,value]]});
    const response=await h.dispatch(input);assert.equal(response.status,503);assert.equal(f.calls.length,0);
  }
  const f=hiddenBuyerGatewayFixture({cluster}),input=f.input('namespace'),h=harness(f,{initial:[['buyer-check-budget:v1',{legacy:'retained'}]]});
  assert.equal((await h.dispatch(input)).status,200);assert.deepEqual(h.data.get('buyer-check-budget:v1'),{legacy:'retained'});
  let name;const response=await h.built.worker.fetch(new Request(origin+'/api/buyer/check',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({version:1,nonce,...input})}),
    {BUYER_HELIUS_API_KEY:'fixture-secret-42',BUYER_CHECK_GATE:{idFromName:value=>{name=value;return{};},get:()=>({fetch:async()=>new Response('{}')})}});
  assert.equal(response.status,200);assert.equal(name,`buyer-check-global:v2:${cluster}:${network.genesisHash}`);
});

test('Mainnet browser constructors need their own grant and reject crossed persisted scopes before locks or key creation',async()=>{
  const f=hiddenBuyerGatewayFixture({cluster}),order=f.order('scope'),scope=Object.fromEntries(['id','cluster','buyer','machine','collection','guard'].map(key=>[key,order[key]]));let locks=0;
  const options={scope,storage:{},checkPrepared:async()=>assert.fail('unexpected checker')};
  assert.throws(()=>createBuyerWalletClient(options),/MAINNET_OPT_IN_REQUIRED/);
  assert.throws(()=>createBuyerStorage({cluster}),/MAINNET_OPT_IN_REQUIRED/);
  assert.throws(()=>createBuyerStorage({authorizeMainnet:true}),/MAINNET_SCOPE_REQUIRED/);
  const capabilities={indexedDB:{open:()=>assert.fail('unexpected database')},crypto:{subtle:{}},locks:{request:()=>{locks++;assert.fail('unexpected lock');}}};
  const mainnet=createBuyerStorage({cluster,authorizeMainnet:true,...capabilities});
  await assert.rejects(mainnet.read({...scope,cluster:'devnet'}),/ORDER_NETWORK_SCOPE_MISMATCH/);
  await assert.rejects(createBuyerStorage(capabilities).read(scope),/ORDER_NETWORK_SCOPE_MISMATCH/);assert.equal(locks,0);
});

test('Mainnet actual sign-only handoff uses solana:mainnet after a native check and separate cost consent',async()=>{
  const f=hiddenBuyerGatewayFixture({cluster,syntheticOwner:true}),input=f.input('wallet-chain');let current=structuredClone(input.order),saved=null,claims=0,walletCalls=0;
  const previous=policy.owner;policy.owner=f.policy.owner;
  try{
    const h=harness(f),scope=Object.fromEntries(['id','cluster','buyer','machine','collection','guard'].map(k=>[k,current[k]]));
    const storage={read:async()=>structuredClone(current),readAssetSigning:async()=>({status:'asset-partial-saved',claim:input.claim,request:input.request}),readBuyerResponse:async()=>saved,
      claimBuyerWallet:async(_scope,value)=>{claims++;current=f.model.transitionOrder(current,{type:'unknown',revision:1,index:0,attempt:1});
        return{status:'wallet-response-unknown',claim:{claimId:'fixture-claim',costApproval:value.costApproval}};},
      saveBuyerResponse:async(_scope,value)=>saved={status:'buyer-response-saved',claim:{claimId:value.claimId},response:{transactionBase64:value.transactionBase64}}};
    const account={address:current.buyer,publicKey:f.owner.publicKey.toBytes(),chains:[network.walletChain],features:['solana:signTransaction']};
    const wallet={chains:[network.walletChain],accounts:[account],features:{'standard:connect':{connect:async()=>({accounts:[account]})},'standard:events':{on:()=>()=>{}},
      'solana:signTransaction':{supportedTransactionVersions:[0],signTransaction:async value=>{walletCalls++;assert.equal(value.chain,'solana:mainnet');assert.equal(claims,1);
        const tx=VersionedTransaction.deserialize(value.transaction);tx.sign([f.owner]);return[{signedTransaction:tx.serialize()}];}}}};
    assert.equal(compatibleBuyerWallet(wallet),false);assert.equal(compatibleBuyerWallet(wallet,cluster),true);
    const client=createBuyerWalletClient({storage,scope,authorizeMainnet:true,storageManager:{persisted:async()=>true},checkPrepared:async value=>{
      h.advance();const response=await h.dispatch(value),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body.report;}});
    await client.load();await assert.rejects(client.connect({...wallet,chains:['solana:devnet']}),/WALLET_UNSUPPORTED/);assert.equal(walletCalls,0);
    await client.connect(wallet);const quote=await client.quoteCost();await assert.rejects(client.signOnly({quoteId:quote.quoteId,maxTotalLamports:quote.budget.totalLamports}),/COST_APPROVAL_REQUIRED/);
    assert.equal(walletCalls,0);assert.equal(claims,0);const result=await client.signOnly({authorizeCost:true,quoteId:quote.quoteId,maxTotalLamports:quote.budget.totalLamports});
    assert.equal(result.status,'buyer-response-saved');assert.equal(walletCalls,1);assert.equal(claims,1);assert.ok(f.calls.every(c=>c.method!=='sendTransaction'));
    await assert.rejects(client.signOnly({authorizeCost:true,quoteId:quote.quoteId,maxTotalLamports:quote.budget.totalLamports}),/NOT_READY/);client.dispose();
  }finally{policy.owner=previous;}
});

test('Mainnet sender consumes one local claim only with its matching opt-in and exact report genesis',async()=>{
  const f=await buyerGatewayFixture({cluster,syntheticOwner:true}),previous=policy.owner;policy.owner=f.policy.owner;
  try{
    const input=f.signedInput('sender'),approval=f.costApproval(input);let consumed=false,reads=0,claims=0,sends=0,persistence=0;
    validateBuyerSubmission(input);const report={...submissionBinding(input),status:'accepted',cluster,genesisHash:network.genesisHash,chainVerified:false,readyToSubmit:false,salesOpen:false};
    for(const genesisHash of [undefined,networkProfile('devnet').genesisHash])assert.throws(()=>validateBuyerResult({...report,genesisHash},input),/SUBMISSION_RESPONSE/);
    const storage={readBuyerSubmission:async()=>{reads++;return{status:consumed?'send-claimed':'ready',input,costApproval:approval};},
      claimBuyerSubmission:async()=>{claims++;consumed=true;return{status:'send-claimed',input,costApproval:approval};}};
    const transport={send:async()=>{sends++;assert.equal(consumed,true);return report;},recover:async()=>assert.fail('unexpected recovery')};
    assert.throws(()=>createBuyerSender({storage,scope:input.order,transport}),/MAINNET_OPT_IN_REQUIRED/);
    const sender=createBuyerSender({storage,scope:input.order,transport,authorizeMainnet:true,storageManager:{persisted:async()=>{persistence++;return true;}}});
    for(const flags of [{},{authorizeDevnetSend:true},{authorizeDevnetSend:true,authorizeMainnetSend:true},{authorizeMainnetSend:'true'}])
      await assert.rejects(sender.sendOnce(flags),/EXPLICIT_SEND_REQUIRED/);
    assert.deepEqual([reads,claims,sends,persistence],[0,0,0,0]);assert.equal((await sender.sendOnce({authorizeMainnetSend:true})).status,'accepted');
    await assert.rejects(sender.sendOnce({authorizeMainnetSend:true}),/SEND_NOT_READY/);assert.equal(claims,1);assert.equal(sends,1);
    const wrong=createBuyerSender({storage:{...storage,readBuyerSubmission:async()=>({status:'ready',input:{...input,order:{...input.order,cluster:'devnet'}}})},scope:input.order,transport,
      authorizeMainnet:true,storageManager:{persisted:async()=>true}});
    await assert.rejects(wrong.sendOnce({authorizeMainnetSend:true}),/SEND_CLUSTER_MISMATCH/);assert.equal(claims,1);assert.equal(sends,1);
  }finally{policy.owner=previous;}
});

test('Mainnet offline gateway package and read-only CLI require explicit network selection without endpoint disclosure',async()=>{
  const parent=await mkdtemp(join(tmpdir(),'mainnet-buyer-'));
  try{
    const f=hiddenBuyerGatewayFixture({cluster}),file=join(parent,'order.json'),profile=join(parent,'storage.json'),directory=join(parent,'candidate');
    await writeFile(file,JSON.stringify(f.order('offline')));await writeFile(profile,JSON.stringify(f.storageOptions));
    await assert.rejects(prepareBuyerGateway(file,origin,{directory,storageOptions:f.storageOptions}),/NETWORK_AUTHORIZATION/);
    const prepared=await prepareBuyerGateway(file,origin,{directory,storageOptions:f.storageOptions,authorizeMainnet:true});assert.equal(prepared.deployed,false);assert.equal(prepared.transactionsSent,0);
    const config=JSON.parse(await readFile(join(directory,'config.json'),'utf8')),entry=await readFile(join(directory,'entry.mjs'),'utf8');
    validateBuyerGatewayConfig(config);assert.equal(config.genesisHash,network.genesisHash);
    assert.ok(entry.includes('allowMainnet:true'));assert.ok(entry.includes('trustedHiddenCommitmentSha256:'+JSON.stringify(f.storageOptions.hiddenCommitmentSha256)));
    assert.ok(!entry.includes('allowSubmission'));assert.ok(!entry.includes('allowMainnetSubmission'));assert.equal(f.calls.length,0);
    await assert.rejects(prepareBuyerGateway(file,origin,{directory,storageOptions:f.storageOptions,authorizeMainnet:true}),/EEXIST/);
    const run=async args=>{let output='';const code=await runOrderCheck(args,{env:{COOLBEARS_BUYER_RPC_URL:network.rpcUpstream+'?api-key=fixture-secret-42'},
      fetchImpl:(url,init)=>f.upstream(new Request(url,init)),output:{write:value=>{output+=value;}}});return{code,report:JSON.parse(output)};};
    const blocked=await run(['preflight','--storage-profile',profile,file]);assert.equal(blocked.code,1);assert.equal(f.calls.length,0);
    const checked=await run(['preflight','--mainnet','--storage-profile',profile,file]);assert.equal(checked.code,0,JSON.stringify(checked.report));assert.equal(checked.report.cluster,cluster);
    assert.equal(checked.report.genesisHash,network.genesisHash);assert.equal(checked.report.transactionsSent,0);assert.equal(checked.report.signaturesCreated,0);
    assert.ok(!JSON.stringify(checked.report).includes('fixture-secret-42'));assert.ok(!Object.hasOwn(checked.report,'candidate'));
  }finally{await rm(parent,{recursive:true,force:true});}
});
