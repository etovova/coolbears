// Offline browser-logic tests. No RPC request, wallet, signature or transaction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync('mainnet/owner/owner.js','utf8');
const packageData=JSON.parse(fs.readFileSync('mainnet/owner/deployment.json','utf8'));
const owner=packageData.ownerAddressRaw, collection=packageData.collectionAddressRaw;
const hashes={content:'11'.repeat(32),item:'22'.repeat(32),royalty:'33'.repeat(32)};
const address=raw=>({toRawString:()=>raw,equals:other=>raw===other.toRawString()});
function slice(values){
  const queue=[...values];
  const take=type=>{const field=queue.shift();assert.ok(field,'Unexpected read '+type);assert.equal(field[0],type);return field[1];};
  return {loadAddress:()=>address(take('address')),loadUintBig:()=>BigInt(take('uint')),loadRef:()=>take('ref'),loadBit:()=>take('bit'),loadStringTail:()=>take('string'),get remainingBits(){return queue.filter(x=>x[0]!=='ref').length;},get remainingRefs(){return queue.filter(x=>x[0]==='ref').length;}};
}
const cell=(hash,values=[])=>({hash:()=>Buffer.from(hash,'hex'),beginParse:()=>slice(values)});
let tests=0;
async function scenario(name,options,verify){
  const elements=new Map();const el=id=>{if(!elements.has(id))elements.set(id,{disabled:true,textContent:'',className:''});return elements.get(id);};
  const p={minted:1,paused:true,nftState:'active',nftOwner:owner,nftCollection:collection,nftIndex:0,nftContent:'0000.json',...options};
  let requests=0,transactions=0;
  const cells={
    COLLECTION_CODE:cell(packageData.collectionCodeHash),
    NFT_CODE:cell(p.badNftCode?'55'.repeat(32):hashes.item),
    COLLECTION_DATA:cell('',[
      ['address',p.collectionOwner||owner],['uint',p.minted],
      ['ref',cell(p.badContent?'66'.repeat(32):hashes.content)],['ref',cell(hashes.item)],['ref',cell(hashes.royalty)],
      ['address',owner],['bit',p.paused]
    ]),
    NFT_DATA:cell('',[['uint',p.nftIndex],['address',p.nftCollection],['address',p.nftOwner],['ref',cell('',[['string',p.nftContent]])]])
  };
  const context=vm.createContext({
    console,Buffer,AbortSignal,URL,Date,BigInt,Number,encodeURIComponent,
    setTimeout:callback=>{callback();return 0;},
    document:{getElementById:el},
    window:{confirm:()=>p.confirm!==false},
    Address:{parse:address},Cell:{fromBase64:key=>{assert.ok(cells[key],key);return cells[key];}},
    beginCell:()=>{const b={storeUint:()=>b,storeAddress:()=>b,endCell:()=>cell('')};return b;},
    contractAddress:()=>address('0:NFT0'),loadStateInit:()=>{throw Error('init is intentionally not executed in offline fixture test');},
    fetch:async url=>{
      requests++;
      if(p.httpError)return {ok:false,status:500,json:async()=>({ok:false})};
      if(p.throttleOnce&&requests===1)return {ok:false,status:429};
      const nft=decodeURIComponent(url).includes('0:NFT0');
      const result=nft?{state:p.nftState,code:'NFT_CODE',data:'NFT_DATA'}:{state:p.state??'active',code:'COLLECTION_CODE',data:'COLLECTION_DATA'};
      if(p.missingState)delete result.state;
      return {ok:true,status:200,json:async()=>({ok:true,result})};
    }
  });
  const offline=source.replace(/^import[^\n]+\n/,'').slice(0,source.replace(/^import[^\n]+\n/,'').lastIndexOf('\ninit().catch'));
  vm.runInContext(offline+`\nglobalThis.api={check,allowed,confirmed,send,setUp(p,h){d=p;releaseAllows=async()=>true;wallet={account:{chain:'-239',address:p.ownerAddressRaw}};expectedContentHash=h.content;expectedItemCodeHash=h.item;expectedRoyaltyHash=h.royalty;ui={sendTransaction:async()=>recordTransaction()};},setPending(v){pending=v;},get pending(){return pending;},get state(){return state;}};`,context);
  context.recordTransaction=()=>{transactions++;};
  const api=context.api;api.setUp(packageData,hashes);
  if(p.pending)api.setPending(p.pending);
  await api.check();
  await verify(api,{el,requests:()=>requests,transactions:()=>transactions});
  assert.equal(transactions,0,'Read/negative tests must not submit transactions');
  console.log('PASS',name);tests++;
}
await scenario('Missing state fails closed',{missingState:true},a=>{assert.equal(a.state,null);assert.equal(a.allowed('deploy'),false);});
await scenario('Unknown state fails closed',{state:'unknown'},a=>assert.equal(a.state,null));
await scenario('RPC failure blocks operations',{httpError:true},a=>assert.equal(a.state,null));
await scenario('Explicit uninitialized permits deploy only',{state:'uninitialized'},a=>{assert.equal(a.allowed('deploy'),true);assert.equal(a.allowed('claim'),false);});
await scenario('Frozen address blocks operations',{state:'frozen'},a=>assert.equal(a.state,null));
await scenario('Minted zero permits claim while paused',{minted:0},(a,t)=>{assert.equal(a.allowed('claim'),true);assert.equal(a.allowed('unpause'),false);assert.equal(t.requests(),1);});
await scenario('Counter alone does not confirm creator claim',{nftState:'uninitialized',pending:'claim'},a=>{assert.equal(a.allowed('unpause'),false);assert.equal(a.pending,'claim');assert.equal(a.confirmed('claim'),false);});
await scenario('Actual NFT0 ownership confirms creator claim',{pending:'claim'},a=>{assert.equal(a.state.creatorVerified,true);assert.equal(a.pending,null);assert.equal(a.allowed('unpause'),true);});
await scenario('Wrong NFT owner blocks launch',{nftOwner:'0:wrong'},a=>assert.equal(a.state,null));
await scenario('Wrong NFT collection blocks launch',{nftCollection:'0:wrong'},a=>assert.equal(a.state,null));
await scenario('Wrong NFT index blocks launch',{nftIndex:1},a=>assert.equal(a.state,null));
await scenario('Wrong NFT content blocks launch',{nftContent:'0001.json'},a=>assert.equal(a.state,null));
await scenario('Wrong NFT bytecode blocks launch',{badNftCode:true},a=>assert.equal(a.state,null));
await scenario('Changed collection content blocks launch',{badContent:true},a=>assert.equal(a.state,null));
await scenario('Invalid collection count blocks launch',{minted:10001},a=>assert.equal(a.state,null));
await scenario('Rate-limit retry is bounded',{throttleOnce:true},(a,t)=>{assert.equal(a.state.creatorVerified,true);assert.equal(t.requests(),3);});
await scenario('Canceled public-unpause confirmation submits nothing',{confirm:false},async(a,t)=>{await a.send('unpause');assert.equal(t.transactions(),0);});
await scenario('Open state still requires verified creator NFT',{paused:false,pending:'unpause'},a=>{assert.equal(a.pending,null);assert.equal(a.confirmed('unpause'),true);});
const cfgContext={window:{},document:{addEventListener(){}}};vm.createContext(cfgContext);
vm.runInContext(fs.readFileSync('config.js','utf8'),cfgContext);
await import('./validate-release-state.mjs');
assert.equal(cfgContext.window.COOLBEARS_CONFIG.priceTon,7);
assert.equal(cfgContext.window.COOLBEARS_CONFIG.revealDate,'2027-01-01');
console.log('OWNER_LAUNCH_OFFLINE_TESTS_OK',tests,'scenarios; sales gate unchanged');

const mintSource=fs.readFileSync('mint-live.js','utf8');
assert.ok(!mintSource.includes("t('confirmed')"),'Supply-counter changes must not be called confirmed mint');
assert.ok(!mintSource.includes('confirmIncrease'),'Counter is not a transaction receipt');
assert.ok(mintSource.includes('observeCollectionActivity'));
assert.ok(mintSource.includes('if(s.next<1)'));
vm.runInNewContext(mintSource,{window:{COOLBEARS_CONFIG:{demoMode:true}},document:new Proxy({},{get(){throw Error('Closed mint client should not access DOM');}})});
console.log('MINT_RECEIPT_LANGUAGE_AND_CLOSED_GATE_OK');
