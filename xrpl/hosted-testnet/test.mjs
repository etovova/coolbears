import test from 'node:test';
import a from 'node:assert/strict';
import {generateSeed,deriveAddress,deriveKeypair,sign} from 'ripple-keypairs';
import {challenge,proof,validIdentity} from './proof.mjs';
import {hex,utf8,ISSUER,ORIGIN,PRICE} from './common.mjs';
import {newOffer} from './ledger.mjs';
import {DatabaseSync} from 'node:sqlite';
import {deflateSync} from 'node:zlib';
import {initialize,Journal} from './journal.mjs';
import signer, {MintJournal, ResetMintJournal} from './issuer.mjs';
import {signingFields, signOrder} from './delegate.mjs';
import {encode,decode} from 'ripple-binary-codec';

test('reservation binds buyer, request, public site, nonce and lifetime',async()=>{
  const k=deriveKeypair(generateSeed()), buyer=deriveAddress(k.publicKey);
  const input={buyer,request:crypto.randomUUID()};
  a.ok(validIdentity(input));a.equal(validIdentity({...input,buyer:ISSUER}),false);
  const c=await challenge(input,'unit-secret',1000);
  a.ok(c.message.includes(ORIGIN));
  const signed={...input,...c,publicKey:k.publicKey,signature:sign(hex(utf8(c.message)),k.privateKey)};
  a.ok(await proof(signed,'unit-secret',1010));
  for (const change of [{request:crypto.randomUUID()},{nonce:'0'.repeat(32)},{buyer:ISSUER},{signature:'A'.repeat(128)}])
    a.equal(await proof({...signed,...change},'unit-secret',1010),false);
  a.equal(await proof(signed,'unit-secret',1240),false);
  a.equal((await signer.fetch(new Request(ORIGIN+'/mint',{method:'POST'}),{})).status,404);
});

test('mint requires a single personal 10 XRP sell offer',()=>{
  const draft={Destination:'buyer',Expiration:100};
  const f={Owner:ISSUER,Flags:1,Destination:'buyer',Amount:PRICE,Expiration:100,NFTokenID:'2'.repeat(64)};
  const node={LedgerEntryType:'NFTokenOffer',LedgerIndex:'3'.repeat(64),NewFields:f};
  const meta={AffectedNodes:[{CreatedNode:node}]};
  a.equal(newOffer(meta,draft).token,f.NFTokenID);
  for (const change of [{Destination:null},{Amount:'1'},{Owner:'other'}]) {
    node.NewFields={...f,...change};a.throws(()=>newOffer(meta,draft));
  }
});

function newStorage() {
  const db=new DatabaseSync(':memory:');
  return {sql:{exec(sql,...args){const stmt=db.prepare(sql);const rows=stmt.all(...args);return {toArray:()=>rows};}},
    transactionSync(fn){db.exec('BEGIN');try{const val=fn();db.exec('COMMIT');return val;}catch(e){db.exec('ROLLBACK');throw e;}}};
}

test('restores completed orders once and reuses released inventory',async()=>{
  const storage=newStorage();
  const hash=i=>i.toString(16).padStart(64,'0').toUpperCase();
  const slot=Array.from({length:7},(_,n)=>({n,state:n<3?'previous':'sold',token:n<3?null:hash(n),mint:n<3?null:hash(n+10)}));
  const orders=slot.slice(3).map(({n})=>({id:'old'+n,buyer:'buyer'+n,n,phase:'sold',expires:0,offer:hash(n+20),ledger:12,payment:hash(n+30)}));
  const signed=orders.map(o=>({hash:hash(o.n+10),request:o.id,blob:'old',draft:'{}',first_ledger:11,result:'tesSUCCESS',ledger:12}));
  await initialize(storage,deflateSync(JSON.stringify({slot,orders,signed,setup:[{previous:3}]})).toString('base64'));
  const j=new Journal(storage);a.equal(j.order('old6').phase,'sold');
  const r=j.claim('new','first',30);a.equal(r.n,7);
  a.throws(()=>j.claim('new','again',30));
  await initialize(storage,null);
  j.close(r,null);
  a.equal(j.claim('another','next',500).n,7);

  const freshStorage=newStorage();
  const ctx={storage:freshStorage,blockConcurrencyWhile(fn){this.ready=fn();}};
  const fresh=new ResetMintJournal(ctx,{}).journal;
  await ctx.ready;
  a.equal(fresh.order('old6'),undefined);
  a.equal(fresh.claim('another','new-test-order',600).n,0);
  const restarted=new ResetMintJournal(ctx,{}).journal;
  await ctx.ready;
  a.equal(restarted.order('new-test-order').n,0);
  a.equal(j.order('old6').payment,hash(36));
  a.equal(j.order('next').phase,'held');
  a.equal(j.order('new-test-order'),undefined);
});


test('delegate signs mint and reoffer for issuer and cancels expired offers as itself',async()=>{
  const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
  const publicKey='ED'+hex(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey)));
  const privateKey=hex(new Uint8Array(await crypto.subtle.exportKey('pkcs8',pair.privateKey)));
  const delegate=deriveAddress(publicKey);
  for (const type of ['NFTokenMint','NFTokenCreateOffer','NFTokenCancelOffer']) {
    const ids=signingFields(type,publicKey);
    a.equal(ids.Account,type==='NFTokenCancelOffer'?delegate:ISSUER);
    a.equal(ids.Delegate,type==='NFTokenCancelOffer'?undefined:delegate);
    const draft={TransactionType:type,...ids,Sequence:123,LastLedgerSequence:155,Fee:'10'};
    const signed=await signOrder(draft,privateKey);
    a.match(signed.TxnSignature,/^[0-9A-F]{128}$/);
    a.deepEqual(decode(encode(signed)),signed);
  }
  a.throws(()=>signingFields('Payment',publicKey));
  const other=deriveKeypair(generateSeed({algorithm:'ed25519'}));
  const wrong={TransactionType:'NFTokenMint',...signingFields('NFTokenMint',other.publicKey)};
  await a.rejects(()=>signOrder(wrong,privateKey),/key mismatch/);
});

test('a never-applied cancellation recovers using the cancelling account sequence',async t=>{
  const account='rERVPWnVB94yk6szLGFpSdxkjwg5oJJ8mb';
  const draft={Account:account,Sequence:23,LastLedgerSequence:50};
  const pending={hash:'A'.repeat(64),draft:JSON.stringify(draft),first_ledger:40};
  const ledger={seq:52,hash:'B'.repeat(64)};
  t.mock.method(globalThis,'fetch',async (_url,options)=>{
    const {method,params}=JSON.parse(options.body);
    if (method==='tx') {
      a.equal(params[0].min_ledger,40);
      a.equal(params[0].max_ledger,50);
      return Response.json({result:{error:'txnNotFound',searched_all:true}});
    }
    a.equal(method,'account_info');
    a.equal(params[0].account,account);
    return Response.json({result:{status:'success',validated:true,ledger_hash:ledger.hash,account_data:{Sequence:23}}});
  });
  const writes=[];
  const journal={exec(...args){writes.push(args)}};
  a.equal(await MintJournal.prototype.resume.call({journal},pending,ledger),true);
  a.equal(writes.length,1);
  a.match(writes[0][0],/notApplied/);
  a.equal(writes[0][1],pending.hash);
});

test('an external cancellation releases the old reservation even if our cancellation finds no offer',async t=>{
  const row={id:'first',n:11,buyer:'buyer',phase:'open',offer:'1'.repeat(64),
    token:'2'.repeat(64),ledger:80,expires:400};
  const pending={request:row.id,hash:'3'.repeat(64),first_ledger:81,
    draft:JSON.stringify({TransactionType:'NFTokenCancelOffer',Account:'operator',NFTokenOffers:[row.offer],LastLedgerSequence:90})};
  const ledger={seq:81,hash:'4'.repeat(64)};
  const removed={DeletedNode:{LedgerIndex:row.offer,LedgerEntryType:'NFTokenOffer',FinalFields:{
    NFTokenID:row.token, Owner:ISSUER, Flags:1, Amount:PRICE, Destination:row.buyer, Expiration:row.expires}}};
  t.mock.method(globalThis,'fetch',async (_url,options)=>{
    const {method}=JSON.parse(options.body);
    if (method==='tx') return Response.json({result:{status:'success',validated:true,ledger_index:81,hash:pending.hash,
      tx_json:JSON.parse(pending.draft),meta:{TransactionResult:'tecOBJECT_NOT_FOUND',AffectedNodes:[]}}});
    if (method==='ledger_entry') return Response.json({result:{error:'entryNotFound'}});
    a.equal(method,'account_tx');
    return Response.json({result:{status:'success',validated:true,ledger_index_min:81,ledger_index_max:81,
      transactions:[{hash:'5'.repeat(64),tx_json:{TransactionType:'NFTokenCancelOffer'},
        meta:{TransactionResult:'tesSUCCESS',AffectedNodes:[removed]}}]}});
  });
  const writes=[];
  const journal={order:()=>row,storage:{transactionSync:fn=>fn()},exec(...args){writes.push(args)}};
  a.equal(await MintJournal.prototype.resume.call({journal},pending,ledger),true);
  a.deepEqual(writes.map(args=>args.slice(1)),[
    ['expired',null,row.id],['free',row.n],['tecOBJECT_NOT_FOUND',81,pending.hash]]);
});

test('Xaman reservations require the verified CoolBears Testnet session and an order-specific ticket',async()=>{
  const {authenticatedBuyer}=await import('./xaman.mjs');
  const clientId=crypto.randomUUID(), buyer=deriveAddress(deriveKeypair(generateSeed()).publicKey);
  const auth='Bearer one.two.three', identity={buyer,request:crypto.randomUUID()}, secret='reservation-key';
  const ping={client_id:clientId,exp:Date.now()/1000+600};
  const profile={account:buyer,networkType:'TESTNET',blocked:false};
  const provider=(p,user)=>async(url,opts)=>{
    a.equal(opts.headers.Authorization,auth);a.equal(opts.redirect,'manual');
    if (url==='https://xumm.app/api/v1/jwt/ping') return Response.json(p);
    a.equal(url,'https://oauth2.xumm.app/userinfo');return Response.json(user);
  };
  a.equal(await authenticatedBuyer(auth,clientId,buyer,provider(ping,profile)),true);
  for(const [p,u] of [[{...ping,client_id:crypto.randomUUID()},profile],[{...ping,exp:10},profile],
    [ping,{...profile,networkType:'MAINNET'}],[ping,{...profile,account:ISSUER}],[ping,{...profile,blocked:true}]])
    a.equal(await authenticatedBuyer(auth,clientId,buyer,provider(p,u)),false);
  a.equal(await authenticatedBuyer(auth,clientId,buyer,async()=>new Response(null,{status:401})),false);
  await a.rejects(authenticatedBuyer(auth,clientId,buyer,async()=>Response.redirect('https://example.invalid/',302)),
    /Xaman authentication unavailable/);
  a.equal(await authenticatedBuyer(null,clientId,buyer,()=>a.fail()),false);
  const env={CHALLENGE_KEY:secret,JOURNAL:{idFromName:()=>1,get:()=>({fetch:async(u,i)=>{
    a.deepEqual(JSON.parse(i.body),identity);return Response.json({accepted:true});
  }})}};
  const call=(path,data)=>signer.fetch(new Request('https://orders.internal/'+path,{method:'POST',body:JSON.stringify(data)}),env);
  const regular=await (await call('challenge',{...identity,provider:'xaman'})).json();
  a.equal((await call('mint',{...regular,...identity,provider:'xaman'})).status,403);
  const ticket=await (await call('xaman-challenge',identity)).json();
  const input={...identity,...ticket,provider:'xaman'};
  a.deepEqual(await (await call('mint',input)).json(),{accepted:true});
  for(const change of [{request:crypto.randomUUID()},{buyer:deriveAddress(deriveKeypair(generateSeed()).publicKey)},
    {tag:'0'.repeat(64)},{provider:'gem'},{expires:1}])
    a.equal((await call('mint',{...input,...change})).status,403);
});

import {inspectTestnet} from './readiness.mjs';
test('Testnet purchases require a fresh validated ledger from the journal network and its exact delegation', async()=>{
  const hash='B'.repeat(64);
  const fresh={network_id:1,validated_ledger:{seq:22614600,hash,age:3}};
  const entry={validated:true,ledger_hash:hash,node:{LedgerEntryType:'Delegate',Account:ISSUER,
    Authorize:'rERVPWnVB94yk6szLGFpSdxkjwg5oJJ8mb',
    PreviousTxnID:'6B9024FCD521756DB7D0B351F9AD5DB3BB89BB89432DDDE00738D46BF862F24F',
    Permissions:['NFTokenMint','NFTokenCreateOffer'].map(PermissionValue=>({Permission:{PermissionValue}}))}};
  const observed=[];
  const state=(info,grant)=>inspectTestnet(async(method,params)=>{
    observed.push(method);if(method==='server_info')return {info};
    a.equal(method,'ledger_entry');a.equal(params.ledger_hash,hash);return grant;
  });
  a.equal(await state(fresh,entry),'ready');
  a.equal(await state(fresh,{...entry,node:{...entry.node,PreviousTxnID:'D'.repeat(64)}}),'collection-unavailable');
  for(const info of [{...fresh,network_id:0},{...fresh,validated_ledger:{...fresh.validated_ledger,age:60}},
    {...fresh,validated_ledger:{...fresh.validated_ledger,age:null}}]){
    observed.length=0;a.equal(await state(info,entry),'network-unavailable');a.deepEqual(observed,['server_info']);
  }
  a.equal(await state({...fresh,validated_ledger:{...fresh.validated_ledger,seq:600}},entry),'collection-unavailable');
  a.equal(await state(fresh,{error:'entryNotFound'}),'collection-unavailable');
  a.equal(await state(fresh,{...entry,validated:false}),'network-unavailable');
  a.equal(await state(fresh,{...entry,node:{...entry.node,Permissions:[]}}),'collection-unavailable');
  a.equal(await inspectTestnet(async()=>{throw Error('Offline')}),'network-unavailable');
});


test('reset signer requires the new validated grant before opening its namespace', async()=>{
  const fresh={network_id:1,validated_ledger:{seq:9500,age:2,hash:'C'.repeat(64)}};
  const hash='D'.repeat(64);
  const grant={validated:true,ledger_hash:fresh.validated_ledger.hash,node:{LedgerEntryType:'Delegate',
    Account:ISSUER,Authorize:'rERVPWnVB94yk6szLGFpSdxkjwg5oJJ8mb',PreviousTxnID:hash,
    Permissions:['NFTokenMint','NFTokenCreateOffer'].map(PermissionValue=>({Permission:{PermissionValue}}))}};
  const call=async method=>method==='server_info'?{info:fresh}:grant;
  a.equal(await inspectTestnet(call,hash),'ready');
  a.equal(await inspectTestnet(call),'collection-unavailable');
  a.equal(await inspectTestnet(call,'E'.repeat(64)),'collection-unavailable');
  a.equal(await inspectTestnet(call,''),'collection-unavailable');
  const env={RESET_JOURNAL:{idFromName(){a.fail('opened journal before grant')}}};
  const req=new Request('https://orders.internal/mint',{method:'POST',body:'{}'});
  a.equal((await signer.fetch(req,env)).status,503);
});

test('first mint allows an omitted zero NFT counter and rejects an inventory mismatch',async t=>{
  const ledger={seq:10000,hash:'5'.repeat(64)};
  const methods=[];
  t.mock.method(globalThis,'fetch',async (_url,options)=>{
    const {method}=JSON.parse(options.body);
    methods.push(method);
    const result=method==='account_info'?{status:'success',validated:true,ledger_hash:ledger.hash,
      account_data:{Account:ISSUER,Sequence:9360}}:{status:'success',drops:{open_ledger_fee:'200'}};
    return Response.json({result});
  });
  const stage=expected=>MintJournal.prototype.stage.call({journal:{first:()=>({n:expected})}},{},ledger);
  await a.rejects(stage(0),/fee is above/);
  await a.rejects(stage(1),/inventory changed/);
  a.deepEqual(methods,['account_info','fee','account_info']);
});
