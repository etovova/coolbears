import test from 'node:test';
import assert from 'node:assert/strict';
import {buyerConsoleFixture,consoleConfig,consoleKey} from './fixtures/buyer-console.mjs';
import {createPrivateBuyerController} from '../orders/buyer-console/controller.mjs';
import {createPrivateBuyerConsole} from '../orders/buyer-console/factory.mjs';
import {createScopeIndex,validateConsoleConfig} from '../orders/buyer-console/config.mjs';
import {lamportsFromSol,solFromLamports} from '../orders/buyer-console/view.mjs';
import {createBuyerWalletClient} from '../orders/wallet-client.mjs';
const prepare=c=>c.prepare({authorizePreparation:true});
const sign=(c,q)=>c.sign({authorizeCost:true,quoteId:q.quoteId,maxTotalLamports:q.budget.totalLamports});
test('no creation, persistence, preparation, signing, sends or replacement effects without separate consent',async()=>{
  const f=buyerConsoleFixture(),c=f.controller;
  for(const call of [()=>c.requestPersistence(),()=>c.create({quantity:1}),()=>c.prepare(),()=>c.sign(),()=>c.send(),()=>c.recover(),()=>c.reviewExpiry(),()=>c.reviewReplacement(),()=>c.prepareReviewedReplacement()])await assert.rejects(call(),/EXPLICIT_/);
  assert.ok(Object.values(f.calls).every(v=>v===0));await f.ready();assert.equal(c.state().canPause,false);assert.equal(c.state().canPrepare,true);
  await prepare(c);const q=await c.quoteCost();await assert.rejects(c.sign({quoteId:q.quoteId,maxTotalLamports:q.budget.totalLamports}),/EXPLICIT_COST/);
  await sign(c,q);assert.equal(f.calls.wallet,1);assert.equal(f.calls.send,0);assert.equal(c.state().unknown,true);assert.equal(c.state().canPrepare,false);
  await assert.rejects(c.send({authorizeSend:true}),/SEND_DISABLED/);assert.equal(f.calls.send,0);
});
test('stale quote, changed account and mismatched cost cap cannot call the wallet',async()=>{
  for(const change of ['expired','account','cap','revision']){
    const f=buyerConsoleFixture(),c=f.controller;await f.ready();await prepare(c);const q=await c.quoteCost();
    if(change==='expired')f.advanceTime(300001);if(change==='account')f.accountChanged();if(change==='revision')f.snapshot.order.revision++;
    await assert.rejects(c.sign({authorizeCost:true,quoteId:q.quoteId,maxTotalLamports:change==='cap'?'1':q.budget.totalLamports}));assert.equal(f.calls.wallet,0);assert.equal(f.calls.send,0);
  }
});
test('quote arriving after account change cannot become a consentable quote',async()=>{
  const f=buyerConsoleFixture();await f.ready();await prepare(f.controller);let release;f.heldQuote=new Promise(r=>release=r);
  const pending=f.controller.quoteCost();while(f.calls.quote===0)await new Promise(r=>setTimeout(r,0));f.accountChanged();release();
  await assert.rejects(pending,/WALLET_CHANGED/);assert.equal(f.controller.state().quote,null);assert.equal(f.calls.wallet,0);
});
test('restored unknown and missing custody allow only explicit outcome review without signing or sending',async()=>{
  const f=buyerConsoleFixture();await f.ready();await prepare(f.controller);await sign(f.controller,await f.controller.quoteCost());
  const resumed=createPrivateBuyerController(f.options);await resumed.load(f.saved[0].id);assert.equal(resumed.state().unknown,true);assert.equal(resumed.state().canSign,false);
  await assert.rejects(resumed.prepare({authorizePreparation:true}));await resumed.recover({authorizeOutcomeCheck:true});assert.equal(f.calls.recover,1);
  f.snapshot.custody.status='unavailable';await resumed.refresh();assert.equal(resumed.state().canRecover,true);assert.equal(resumed.state().canReviewExpiry,false);
  await resumed.recover({authorizeOutcomeCheck:true});assert.equal(f.calls.readonly,1);assert.equal(f.calls.wallet,1);assert.equal(f.calls.send,0);
});
test('failed fee acknowledgment and replacement native signing remain distinct reviewed actions',async()=>{
  const f=buyerConsoleFixture(),c=f.controller;await f.ready();await prepare(c);await sign(c,await c.quoteCost());f.failAttempt();await c.refresh();
  await assert.rejects(c.reviewReplacement({authorizeReplacement:true}),/COST_ACKNOWLEDGMENT/);assert.equal(f.calls.replacement,0);
  await c.reviewReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'10000'});assert.equal(f.calls.replacement,1);assert.equal(f.calls.replacementSign,0);
  await assert.rejects(c.prepareReviewedReplacement(),/EXPLICIT_REPLACEMENT_SIGNING/);assert.equal(f.calls.replacementSign,0);
  await c.prepareReviewedReplacement({authorizeReplacementSigning:true});assert.equal(f.calls.replacementSign,1);assert.equal(c.state().quote,null);assert.equal(c.state().canSign,false);
  assert.equal(f.calls.wallet,1);assert.equal(f.calls.send,0);
});
test('pause, stale replacement and completed-prefix continuation demand a fresh review for each item',async()=>{
  const f=buyerConsoleFixture(),c=f.controller;await f.ready();await prepare(c);const q=await c.quoteCost();await c.setPaused(true,{authorizeChange:true});
  await assert.rejects(sign(c,q));await c.setPaused(false,{authorizeChange:true});assert.equal(c.state().quote,null);
  await sign(c,await c.quoteCost());f.failAttempt();await c.refresh();await c.reviewReplacement({authorizeReplacement:true,acknowledgedFeeLamports:'10000'});
  f.snapshot.order.revision++;await assert.rejects(c.prepareReviewedReplacement({authorizeReplacementSigning:true}));assert.equal(f.calls.replacementSign,0);
  f.verify();await c.refresh();assert.equal(c.state().canPrepare,true);await prepare(c);assert.equal(c.state().currentItemIndex,1);assert.equal(c.state().canSign,false);
});
test('lost create acknowledgment retains scope and reload recovers order instead of creating duplicate',async()=>{
  const f=buyerConsoleFixture();f.failCreate=true;await assert.rejects(f.ready(),/STORAGE_UNCERTAIN/);assert.equal(f.saved.length,1);assert.equal(f.calls.create,1);
  const resumed=createPrivateBuyerController(f.options);await resumed.load(f.saved[0].id);assert.equal(resumed.state().quantity,2);assert.equal(resumed.state().canCreate,false);assert.equal(f.calls.create,1);
});
test('production factory cannot enable send through config or options',async()=>{
  const previous={location:Object.getOwnPropertyDescriptor(globalThis,'location'),localStorage:Object.getOwnPropertyDescriptor(globalThis,'localStorage')};
  Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:consoleConfig.origin}});
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>null,setItem:()=>assert.fail('unexpected index write')}});
  try{assert.throws(()=>createPrivateBuyerConsole({...consoleConfig,sendingEnabled:true}));
    const client=createPrivateBuyerConsole(consoleConfig,{sendingEnabled:true});assert.equal(client.state().sendingEnabled,false);
    await assert.rejects(client.send({authorizeSend:true}),/SEND_DISABLED/);client.dispose();
  }finally{for(const [key,descriptor]of Object.entries(previous))if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
});
test('private config, resumable scope index and SOL amounts reject ambiguity and never retain key material',async()=>{
  for(const change of [{cluster:'mainnet-beta'},{origin:'http://console-fixture.test'},{secret:'not-allowed'},{machine:consoleKey(3)}])assert.throws(()=>validateConsoleConfig({...consoleConfig,...change}));
  const values=new Map(),store={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},index=createScopeIndex({config:consoleConfig,localStorage:store,locks:{request:async(_key,_options,fn)=>fn()}});
  await index.save({id:'order-one',buyer:consoleKey(5),privateKey:'never-store',assets:['never-store']});await index.save({id:'order-one',buyer:consoleKey(5)});
  assert.deepEqual(index.list(),[{id:'order-one',buyer:consoleKey(5)}]);assert.ok(![...values.values()].join('').includes('never-store'));
  const reordered=Object.fromEntries(Object.entries(consoleConfig).reverse());assert.deepEqual(createScopeIndex({config:reordered,localStorage:store}).list(),index.list());
  await assert.rejects(index.save({id:'order-one',buyer:consoleKey(6)}));
  assert.equal(lamportsFromSol('0.203509999'),'203509999');assert.equal(solFromLamports('203509999'),'0.203509999');
  for(const amount of ['1e9','-1','0.0000000001',' 1','1,2'])assert.throws(()=>lamportsFromSol(amount));
});
test('concurrent scope-index writers retain both resumable IDs and create waits for index durability',async()=>{
  const values=new Map(),store={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};let tail=Promise.resolve(),locksUsed=0;
  const locks={request(key,options,fn){assert.equal(options.mode,'exclusive');assert.match(key,/:mutation$/);locksUsed++;
    const result=tail.then(fn);tail=result.catch(()=>{});return result;}};
  const a=createScopeIndex({config:consoleConfig,localStorage:store,locks}),b=createScopeIndex({config:consoleConfig,localStorage:store,locks});
  await Promise.all([a.save({id:'tab-a',buyer:consoleKey(5)}),b.save({id:'tab-b',buyer:consoleKey(6)})]);assert.equal(locksUsed,2);assert.deepEqual(a.list().map(v=>v.id),['tab-a','tab-b']);
  const f=buyerConsoleFixture();let release,started=false;f.options.index.save=async row=>{started=true;await new Promise(r=>release=r);f.saved.push(row);};
  const c=createPrivateBuyerController(f.options);await c.connectWallet(f.wallet);await c.selectAccount(f.account.address);await c.requestPersistence({authorizePersistence:true});
  const pending=c.create({quantity:1,authorizeCreate:true});while(!started)await new Promise(r=>setTimeout(r,0));assert.equal(f.calls.create,0);release();await pending;assert.equal(f.calls.create,1);
});
test('ordinary account events emitted during explicit connect are accepted but later changes invalidate consent',async()=>{
  const f=buyerConsoleFixture();const listeners=new Set();f.wallet.features['standard:events'].on=(_name,fn)=>{listeners.add(fn);return()=>listeners.delete(fn);};
  f.wallet.features['standard:connect'].connect=async()=>{for(const fn of listeners)fn({accounts:f.wallet.accounts});return{accounts:f.wallet.accounts};};
  const ports=f.options.makePorts;f.options.makePorts=scope=>{const value=ports(scope),connect=value.wallet.connect;value.wallet.connect=async selected=>{await selected.features['standard:connect'].connect();await connect(selected);};return value;};
  const c=createPrivateBuyerController(f.options);await c.connectWallet(f.wallet);await c.selectAccount(f.account.address);await c.requestPersistence({authorizePersistence:true});await c.create({quantity:1,authorizeCreate:true});
  assert.equal(c.state().selectedAccount,f.account.address);await prepare(c);await c.quoteCost();for(const fn of [...listeners])fn({accounts:[]});assert.equal(c.state().quote,null);assert.equal(c.state().selectedAccount,null);assert.equal(f.calls.wallet,0);
});
test('fixture-only send requires its own explicit consent after signing and cannot repeat a consumed attempt',async()=>{
  const f=buyerConsoleFixture({sendingEnabled:true}),c=f.controller;await f.ready();await prepare(c);await sign(c,await c.quoteCost());
  await assert.rejects(c.send(),/EXPLICIT_SEND/);assert.equal(f.calls.send,0);await c.send({authorizeSend:true});assert.equal(f.calls.send,1);
  await assert.rejects(c.send({authorizeSend:true}));assert.equal(f.calls.send,1);
});
test('retained wallet bytes can be saved explicitly without another wallet call and cannot be discarded by rebinding',async()=>{
  const f=buyerConsoleFixture({sendingEnabled:true}),make=f.options.makePorts;let retained=false,saves=0,savedSubmission;
  f.options.makePorts=scope=>{const ports=make(scope),state=ports.wallet.state,sign=ports.wallet.signOnly;
    ports.wallet.state=()=>({...state(),canRecover:retained});ports.wallet.signOnly=async options=>{await sign(options);retained=true;savedSubmission=structuredClone(f.snapshot.submission);
      f.snapshot.submission=null;f.snapshot.responseRecovery={status:'wallet-response-unknown'};throw Error('STORAGE_UNCERTAIN');};
    ports.wallet.recover=async()=>{assert.equal(retained,true);saves++;retained=false;f.snapshot.responseRecovery=null;f.snapshot.submission={status:'ready'};return{status:'buyer-response-saved'};};return ports;};
  const c=createPrivateBuyerController(f.options);await c.connectWallet(f.wallet);await c.selectAccount(f.account.address);await c.requestPersistence({authorizePersistence:true});await c.create({quantity:1,authorizeCreate:true});await prepare(c);
  await assert.rejects(sign(c,await c.quoteCost()),/STORAGE_UNCERTAIN/);assert.equal(c.state().canRecoverWalletResponse,true);
  assert.equal(c.state().canReviewExpiry,false);assert.equal(c.state().canRecover,false);assert.equal(c.state().canReplace,false);
  await assert.rejects(c.reviewExpiry({authorizeExpiryReview:true}));assert.equal(f.snapshot.order.items[0].attempts[0].state,'unknown');
  await assert.rejects(c.recover({authorizeOutcomeCheck:true}));assert.equal(f.calls.recover,0);
  f.snapshot.submission=savedSubmission;await c.refresh();assert.equal(c.state().canSend,false);await assert.rejects(c.send({authorizeSend:true}));assert.equal(f.calls.send,0);f.snapshot.submission=null;
  f.snapshot.custody.status='unavailable';await c.refresh();assert.equal(c.state().canRecover,true);await c.recover({authorizeOutcomeCheck:true});assert.equal(f.calls.readonly,1);
  f.snapshot.custody.status='available';await c.refresh();
  await assert.rejects(c.connectWallet(f.wallet),/RETAINED_RESPONSE_PENDING/);await assert.rejects(c.load(f.saved[0].id),/RETAINED_RESPONSE_PENDING/);
  await assert.rejects(c.recoverWalletResponse(),/EXPLICIT_RESPONSE_RECOVERY/);assert.equal(saves,0);
  await c.recoverWalletResponse({authorizeResponseRecovery:true});assert.equal(saves,1);assert.equal(f.calls.wallet,1);assert.equal(f.calls.recover,0);assert.equal(f.calls.send,0);
  assert.equal(c.state().canRecoverWalletResponse,false);
});

for(const hidden of [false,true])test(`resuming ${hidden?'v2 hidden':'v1'} progress and reconnecting uses the actual unloaded wallet client without a stuck busy state`,async()=>{
  const f=buyerConsoleFixture();await f.ready(1);const id=f.saved[0].id,before=JSON.stringify(f.snapshot),states=[];let checks=0;
  const storage={...f.storage,read:async()=>structuredClone(f.snapshot.order),readAssetSigning:async()=>null,readBuyerResponse:async()=>null};
  const controller=createPrivateBuyerController({...f.options,storage,
    config:hidden?{...f.options.config,version:2,storageMode:'hidden-settings',hiddenCommitmentSha256:'a'.repeat(64)}:f.options.config,
    onChange:state=>states.push(state.busy),makePorts:scope=>({wallet:createBuyerWalletClient({storage,scope,
      checkPrepared:async()=>{checks++;throw Error('forbidden');},storageManager:{persisted:async()=>true}})})});
  await controller.load(id);assert.equal(controller.state().busy,false);
  await controller.connectWallet(f.wallet);assert.equal(controller.state().busy,false);await controller.selectAccount(f.account.address);
  assert.equal(controller.state().selectedAccount,f.account.address);assert.equal(controller.state().busy,false);assert.equal(controller.state().canQuote,false);
  controller.disconnectWallet();await controller.connectWallet(f.wallet);await controller.selectAccount(f.account.address);
  assert.equal(controller.state().busy,false);assert.equal(controller.state().selectedAccount,f.account.address);assert.equal(controller.state().error,null);
  assert.equal(states.at(-1),false);assert.equal(JSON.stringify(f.snapshot),before);assert.equal(checks,0);assert.equal(f.calls.wallet,0);assert.equal(f.calls.send,0);
});
