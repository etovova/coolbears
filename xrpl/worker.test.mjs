import test from 'node:test';
import assert from 'node:assert/strict';
import {handle,REVEAL_AT,OWNER,HIDDEN_ROOT,mintMetadata,eligibleMetadata} from './worker.mjs';
const host='https://preview.invalid';
const request=(path,env={},when=REVEAL_AT-1,method='GET')=>handle(new Request(host+path,{method}),env,when);
test('the canonical domain publishes its Mainnet issuer as a CORS-readable TOML file',async()=>{
 const path='/.well-known/xrp-ledger.toml',url='https://coolbears-nfts.com'+path;
 const file=await handle(new Request(url),{}),head=await handle(new Request(url,{method:'HEAD'}),{});
 assert.equal(file.status,200);
 assert.equal(file.headers.get('Access-Control-Allow-Origin'),'*');
 assert.match(file.headers.get('Content-Type'),/^application\/toml/);
 assert.equal(await file.text(),'[[ACCOUNTS]]\naddress = "'+OWNER+'"\nnetwork = "main"\ndesc = "CoolBears NFTs issuer"\n');
 assert.equal(head.status,200);assert.equal(head.body,null);
 assert.equal((await handle(new Request(url,{method:'POST'}),{})).status,405);
 assert.equal((await request(path)).status,404);
});
test('all slots stay closed before the exact UTC boundary',async()=>{
  assert.equal(new Date(REVEAL_AT).toISOString(),'2027-02-01T00:00:00.000Z');
  let reads=0;const env={ASSETS:{fetch(){reads++;throw Error();}}};
  for(let i=0;i<10000;i++){
    const slot=String(i).padStart(4,'0');
    const r=await request('/xrpl/metadata/'+slot+'.json?now=9999999999',env);
    assert.equal(r.headers.get('cache-control'),'no-store');
    assert.equal((await r.json()).image,host+'/xrpl/cover.gif');
    assert.equal((await request('/xrpl/art/'+slot+'.png',env)).status,404);
  }
  assert.equal(reads,0);
});
test('only public routes work and storage failures are retryable',async()=>{
  for(const path of ['/internal/p000.bin','/internal/m00.json','/xrpl/metadata/10000.json','/xrpl/metadata/0000.png','/xrpl/art/0000.json'])
    assert.equal((await request(path)).status,404);
  assert.equal((await request('/xrpl/metadata/0000.json',{},REVEAL_AT)).status,503);
  assert.equal((await request('/xrpl/metadata/0000.json',{},REVEAL_AT-1,'HEAD')).body,null);
  assert.equal((await request('/xrpl/metadata/0000.json',{},REVEAL_AT-1,'POST')).status,405);
});
test('the public sale remains closed on the main domain',async()=>{
 const r=await handle(new Request('https://coolbears-nfts.com/xrpl/api/status'),{NETWORK:'testnet',SALES_OPEN:'yes',TEST_ISSUER:'fixture'});
 const s=await r.json();assert.equal(s.issuer,OWNER);assert.equal(s.open,false);assert.equal(s.network,'Mainnet');assert.equal(s.price,'10000000');
});

test('public hosts have no mint signer endpoint or single-slot pilot mode',async()=>{
  const env={NETWORK:'testnet',SALES_OPEN:'yes',TEST_ISSUER:'test-issuer'};
  for(const host of ['coolbears-nfts.com','www.coolbears-nfts.com','testnet.coolbears-nfts.com']){
    const base='https://'+host+'/xrpl/api/';
    const status=await (await handle(new Request(base+'status'),env)).json();
    assert.equal(status.mintMode,undefined);
    assert.equal((await handle(new Request(base+'mint',{method:'POST'}),env)).status,405);
    assert.equal((await handle(new Request(base+'mint'),env)).status,404);
  }
});

test('the six collection cards use the original pre-reveal cover', async () => {
  const {readFile} = await import('node:fs/promises');
  const page = await readFile(new URL('./web/index.html', import.meta.url), 'utf8');
  const collection = page.match(/<section id="collection"[\s\S]*?<\/section>/)[0];
  assert.equal((collection.match(/<figure>/g) || []).length, 6);
  assert.equal((collection.match(/src="\/assets\/brand\/gallery-20261003.png"/g) || []).length, 6);
  assert.equal((collection.match(/<figcaption>#\?\?\?\?<\/figcaption>/g) || []).length, 6);
  assert.doesNotMatch(collection, /promo-|\/gallery\//);
});

test('Xaman is available only with an application ID and the site selects the network',async()=>{
  const client='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  for(const [value,expected] of [[undefined,null],['bad',null],[client,client]]){
    const r=await handle(new Request('https://coolbears-nfts.com/xrpl/api/status'),{XAMAN_CLIENT_ID:value});
    const s=await r.json();
    assert.equal(s.xamanClientId,expected);
    assert.equal(s.network,'Mainnet');
    assert.equal(s.open,false);
  }
  const r=await request('/xrpl/api/status',{NETWORK:'testnet',TEST_ISSUER:'test-issuer',XAMAN_CLIENT_ID:client});
  assert.equal((await r.json()).network,'Testnet');
});

test('the first issuer draft matches the storefront and creates no sell offer',async()=>{
  const {readFile}=await import('node:fs/promises');
  const {TAXON}=await import('./worker.mjs');
  const draft=JSON.parse(await readFile(new URL('./launch/first-mint.json',import.meta.url),'utf8'));
  assert.deepEqual(Object.keys(draft).sort(),['Account','Flags','NFTokenTaxon','TransactionType','TransferFee','URI']);
  assert.equal(draft.TransactionType,'NFTokenMint');
  assert.equal(draft.Account,OWNER);
  assert.equal(draft.NFTokenTaxon,TAXON);
  assert.equal(draft.TransferFee,7000);
  assert.equal(draft.Flags,24);
  assert.equal(Buffer.from(draft.URI,'hex').toString(),'ipfs://'+HIDDEN_ROOT+'/0000.json');
});

test('the original rarity report appears at the reveal boundary',async()=>{
  const {randomBytes,createCipheriv}=await import('node:crypto');
  const key=randomBytes(32), iv=randomBytes(12);
  const row={name:'CoolBears #fixture',description:'Original description',attributes:[],
    rarity:{rank:42,score:'58.13',trait_frequencies:{Body:{count:123}}}};
  const cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from('m00.json'));
  const bytes=Buffer.concat([iv,cipher.update(JSON.stringify([row])),cipher.final(),cipher.getAuthTag()]);
  const env={ASSET_KEY:key.toString('base64'),ASSETS:{fetch:async()=>new Response(bytes)}};
  const path='/xrpl/metadata/0000.json';
  const closed=await (await request(path,env,REVEAL_AT-1)).json();
  assert.equal(closed.properties,undefined);
  assert.equal(closed.attributes,undefined);
  const opened=await (await request(path,env,REVEAL_AT)).json();
  assert.deepEqual(opened.properties.rarity,row.rarity);
  assert.equal(opened.properties.top_percent,0.42);
  assert.equal(opened.properties.collection_size,10000);
  assert.equal(opened.external_url,host+'/xrpl/?slot=0000#rarity');
  assert.equal(opened.description,row.description);
  assert.equal(opened.properties.files[0].uri,opened.image);
});

test('the public ranking and private encrypted file stay closed before reveal',async()=>{
  let reads=0;
  const env={ASSETS:{fetch(){reads++;throw Error('unexpected read');}}};
  const r=await request('/xrpl/api/top50?now=9999999999999',env);
  assert.equal(r.headers.get('cache-control'),'no-store');
  assert.deepEqual(await r.json(),{revealed:false});
  assert.equal((await request('/internal/leaders.bin',env,REVEAL_AT)).status,404);
  assert.equal(reads,0);
});

test('only the authenticated Mainnet issuer can prepare the fixed platform sign request',async()=>{
  const base='https://coolbears-nfts.com', path='/xrpl/owner/sign';
  const client='617d091e-46b6-4918-b5c6-da929d661070', jwt='Bearer mock.token.value';
  const {readFile}=await import('node:fs/promises');
  const template=JSON.parse(await readFile(new URL('./launch/mainnet-signer/authorize.json',import.meta.url)));
  const env={XAMAN_CLIENT_ID:client,XAMAN_DELEGATION_API_KEY:'server-only-fixture',XAMAN_API_SECRET:'for-local-test-only',ASSETS:{fetch:async()=>Response.json(template)}};
  const send=(extra={},bindings=env)=>handle(new Request(base+path,{method:'POST',headers:{Origin:base,Authorization:jwt},...extra}),bindings);
  const original=globalThis.fetch;
  let submits=0,profileNetwork='MAINNET',account=OWNER,granted=[],audience=client,upstreamError=false;
  const hash='A'.repeat(64), id='15c06d2d-7568-4984-8a92-3835463fe195';
  globalThis.fetch=async(url,options)=>{
    if(url==='https://xumm.app/api/v1/platform/payload'){
      submits++;
      assert.equal(options.headers['X-API-Secret'],env.XAMAN_API_SECRET);
      assert.equal(options.headers['X-API-Key'],env.XAMAN_DELEGATION_API_KEY);
      assert.equal(options.headers.Authorization,undefined);
      assert.equal(options.redirect,'manual');
      assert.deepEqual(JSON.parse(options.body),{
        txjson:{...template,Fee:'12',LastLedgerSequence:90070},
        options:{submit:true,expire:3,force_network:'MAINNET',signers:[OWNER],
          return_url:{web:base+'/xrpl/owner/',app:base+'/xrpl/owner/'}}
      });
      if(upstreamError)return Response.json({error:{code:999,message:'private diagnostics'}},{status:403});
      return Response.json({uuid:id,next:{always:'https://xumm.app/sign/'+id}});
    }
    assert.equal(options.headers['X-API-Secret'],undefined);
    if(url==='https://xumm.app/api/v1/jwt/ping')return Response.json({client_id:audience,exp:Date.now()/1000+300});
    if(url==='https://oauth2.xumm.app/userinfo')return Response.json({account,networkType:profileNetwork});
    assert.equal(url,'https://s1.ripple.com:51234/');
    const {method}=JSON.parse(options.body);
    if(method==='server_info')return Response.json({result:{info:{network_id:0,validated_ledger:{age:1,hash,seq:90000}}}});
    assert.equal(method,'account_objects');
    return Response.json({result:{validated:true,ledger_hash:hash,account_objects:granted}});
  };
  try {
    assert.equal((await handle(new Request(base+path),env)).status,405);
    assert.equal((await send({headers:{Origin:base}})).status,401);
    assert.equal((await send({headers:{Origin:'null',Authorization:jwt}})).status,403);
    assert.equal((await send({body:'{}'})).status,400);
    assert.equal((await send({},{...env,XAMAN_API_SECRET:undefined})).status,503);
    assert.equal((await send({body:''},{...env,XAMAN_API_SECRET:undefined})).status,503);
    assert.equal((await send({},{...env,XAMAN_DELEGATION_API_KEY:client})).status,503);
    profileNetwork='TESTNET';assert.equal((await send()).status,401);profileNetwork='MAINNET';
    account=template.Authorize;assert.equal((await send()).status,401);account=OWNER;
    audience=id;assert.equal((await send()).status,401);audience=client;
    granted=[{Account:OWNER,Authorize:template.Authorize,Permissions:template.Permissions}];
    assert.equal((await (await send()).json()).state,'active');
    granted[0].Permissions=[];assert.equal((await (await send()).json()).state,'different');
    assert.equal(submits,0);
    granted[0].Permissions=template.Permissions.slice(0,2);
    const upgrade=await (await handle(new Request(base+'/xrpl/owner/status'),env)).json();
    assert.equal(upgrade.state,'upgrade');
    assert.deepEqual(upgrade.tx.Permissions.map(p=>p.Permission.PermissionValue),['NFTokenMint','NFTokenCreateOffer','NFTokenModify']);
    assert.equal((await send()).status,200);
    granted=[];
    assert.deepEqual(await (await send()).json(),{id,url:'https://xumm.app/sign/'+id});
    upstreamError=true;const rejected=await send();assert.equal(rejected.status,502);
    assert.match((await rejected.json()).error,/HTTP 403 · код 999$/);assert.equal(submits,3);
  } finally {globalThis.fetch=original;}
});

test('an unvalidated payment is recovered or expires only with complete validated history',async t=>{
  const buyer='raxeFiH8CN5vLAMqyKypqLByF4YzWsS8Hh', offer='A'.repeat(64);
  const missing='B'.repeat(64), accepted='C'.repeat(64), token='D'.repeat(64);
  const env={NETWORK:'mainnet'};
  let closed=199, history='150-201', searched=true, rows=[], marker;
  const record={hash:accepted,validated:true,ledger_index:198,tx_json:{
    TransactionType:'NFTokenAcceptOffer',Account:buyer,NFTokenSellOffer:offer},
    meta:{TransactionResult:'tesSUCCESS',AffectedNodes:[{DeletedNode:{LedgerEntryType:'NFTokenOffer',
      LedgerIndex:offer,FinalFields:{Owner:OWNER,Amount:'10000000',Flags:1,NFTokenID:token}}}]}};
  const lookup=t.mock.method(globalThis,'fetch',async(_url,{body})=>{
    const {method,params:[p]}=JSON.parse(body);
    if(method==='server_info')return Response.json({result:{info:{network_id:0,complete_ledgers:history,
      validated_ledger:{hash:token,age:1,seq:closed}}}});
    if(method==='tx'){
      if(p.transaction===accepted)return Response.json({result:record});
      if(p.min_ledger!==undefined){assert.equal(p.min_ledger,185);assert.equal(p.max_ledger,200);}
      return Response.json({result:{status:'error',error:'txnNotFound',searched_all:p.min_ledger!==undefined && searched}});
    }
    assert.equal(method,'account_tx');
    return Response.json({result:{validated:true,ledger_index_min:185,ledger_index_max:Math.min(200,closed),
      transactions:rows,marker}});
  });
  const query='?buyer='+buyer+'&offer='+offer;
  const check=async(path)=> (await request('/xrpl/api/'+path,env)).json();
  const known='receipt'+query+'&hash='+missing+'&last=200';
  assert.equal((await check(known)).state,'pending');
  closed=200;searched=false;
  assert.equal((await check(known)).state,'pending');
  searched=true;history='150-189,191-201';
  assert.equal((await check(known)).state,'pending');
  history='150-201';marker='repeated';
  assert.equal((await check(known)).state,'pending');
  marker=undefined;
  assert.equal((await check(known)).state,'expired');
  assert.equal((await check('receipt'+query+'&hash='+missing)).state,'pending');
  assert.equal((await check('reconcile'+query+'&last=200')).state,'expired');
  rows=[{...record,hash:missing,meta:{TransactionResult:'tecFAILED_PROCESSING'}},record];
  assert.equal((await check(known)).hash,accepted);
  assert.equal((await check('receipt'+query+'&hash='+accepted)).state,'complete');
  assert.ok(lookup.mock.callCount()>0);
});

test('all 10000 mint URIs pass the sale verifier only with the correct flag, root and phase',()=>{
  const origin='https://coolbears-nfts.com', final='bafybei'+'a'.repeat(52);
  for (let slot=0;slot<10000;slot++) {
    const number=String(slot).padStart(4,'0');
    const hidden=mintMetadata(slot,REVEAL_AT-1,final);
    assert.deepEqual(hidden,{flags:24,uri:'ipfs://'+HIDDEN_ROOT+'/'+number+'.json'});
    assert.ok(eligibleMetadata(hidden.flags,hidden.uri,origin,REVEAL_AT-1,final));
    assert.equal(eligibleMetadata(8,hidden.uri,origin,REVEAL_AT-1,final),false);
    const revealed=mintMetadata(slot,REVEAL_AT,final);
    assert.equal(revealed.flags,8);
    assert.ok(eligibleMetadata(8,revealed.uri,origin,REVEAL_AT,final));
    assert.equal(eligibleMetadata(8,revealed.uri,origin,REVEAL_AT-1,final),false);
  }
  assert.throws(()=>mintMetadata(0,REVEAL_AT,HIDDEN_ROOT));
  assert.throws(()=>mintMetadata(0,REVEAL_AT));
  assert.throws(()=>mintMetadata(10000,REVEAL_AT-1));
  assert.ok(eligibleMetadata(8,origin+'/xrpl/metadata/0000.json',origin,REVEAL_AT-1));
  assert.equal(eligibleMetadata(24,'ipfs://'+HIDDEN_ROOT+'/../0000.json',origin,REVEAL_AT-1),false);
});
