// Isolated Testnet storefront. The expiring-slot pilot allows two designated test buyers.
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {handle} from './worker.mjs';

const run=promisify(execFile);
const origin='http://127.0.0.1:18840';
const issuer='rEoKftiFRwknRDkbV2zURNc6KmhJoBxtaC';
const buyer='rf2EoyM9uS2HqjS3ouFTzQrNg88LDLrN8a';
const reservations=process.env.CB_PILOT_RESERVATIONS==='yes';
const collection=process.env.CB_PILOT_COLLECTION==='yes';
const challengeKey=randomBytes(32);
const openBuyers=collection && process.env.CB_PILOT_OPEN_BUYERS==='yes';
const buyers=new Set(reservations||collection?[buyer,'rDT2EnyrhJ6hPQfAGnMLfbnqTxeENhB4zr']:[buyer]);
const files={'home.html':'web/index.html','app.js':'web/app.js','site.css':'web/site.css',
  'rarity.mjs':'web/rarity.mjs','translations.mjs':'web/translations.mjs','xaman.mjs':'web/xaman.mjs','wallet.js':'vendor/gemwallet.js',
  'crossmark.js':'vendor/crossmark.js','terms.html':'web/terms.html','privacy.html':'web/privacy.html',
  'logo.png':'../assets/collection/logo.png','cover.gif':'../assets/collection/gif.gif',
  'hero.png':'../assets/brand/hero-20261003.png','brand-logo.png':'../assets/brand/logo-20261003.png',
  'gallery.png':'../assets/brand/gallery-20261003.png'};
const env={NETWORK:'testnet',SALES_OPEN:'yes',TEST_ISSUER:issuer,METADATA_ORIGIN:'https://coolbears-nfts.com',
  ASSETS:{async fetch(req){
    const name=new URL(req.url).pathname.slice('/internal/'.length);
    return Object.hasOwn(files,name)?new Response(await readFile(new URL(files[name],import.meta.url))):new Response(null,{status:404});
  }}};
const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
const inFlight=new Map();
const orderId=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function messageFor(who,id,expires,nonce){
  return ['CoolBears Testnet reservation','Site '+origin,'Wallet '+who,'Order '+id,
    'Maximum NFT price 10 test XRP','Valid until '+expires,'Nonce '+nonce].join('\n');
}
function mac(message){return createHmac('sha256',challengeKey).update(message).digest()}
async function fullRequest(input,challenge){
  const {buyer:who,request:id}=input;
  if(!orderId.test(id))return json({error:'Invalid order identifier'},400);
  const now=Math.floor(Date.now()/1000);
  if(challenge){
    const expires=now+240,nonce=randomBytes(16).toString('hex'),message=messageFor(who,id,expires,nonce);
    return json({message,expires,nonce,tag:mac(message).toString('hex')});
  }
  const {expires,nonce,tag,publicKey,signature}=input;
  if(!Number.isSafeInteger(expires)||expires<=now||expires>now+240||!/^[0-9a-f]{32}$/.test(nonce)||
    !/^[0-9a-f]{64}$/.test(tag)||typeof publicKey!=='string'||typeof signature!=='string')
    return json({error:'A fresh wallet challenge is required.'},403);
  const message=messageFor(who,id,expires,nonce);
  if(!timingSafeEqual(mac(message),Buffer.from(tag,'hex')))return json({error:'Invalid challenge.'},403);
  const proof={buyer:who,request:id,publicKey,signature,message};
  const fingerprint=JSON.stringify([id,publicKey,signature,message]);
  const pending=inFlight.get(who);
  if(pending && pending.fingerprint!==fingerprint)return json({error:'A request from this wallet is being checked.'},409);
  if(!pending && inFlight.size>=16)return json({error:'Issuer queue is busy. Retry this order.'},429);
  if(!pending){
    const task=collectionCall([],proof).finally(()=>inFlight.delete(who));
    inFlight.set(who,{fingerprint,task});
  }
  const result=await inFlight.get(who).task;
  return json(result,result.status||200);
}
async function collectionCall(args,input){
  const script=fileURLToPath(new URL('./testnet_collection.py',import.meta.url));
  const {CB_PILOT_SEED:unusedSeed,...childEnv}=process.env;
  const child=run(process.env.CB_PILOT_PYTHON||'python3',[script,...args],{timeout:240000,env:childEnv});
  child.child.stdin.end(JSON.stringify(input));
  return JSON.parse((await child).stdout);
}
async function reserve(req,challenge=false){
  if(req.method!=='POST')return json({error:'POST required'},405);
  if(req.headers.origin!==origin || req.headers['content-type']!=='application/json')return json({error:'Local origin required'},403);
  let body='';
  for await(const chunk of req){
    if(body.length+chunk.length>(collection?1400:128))return json({error:'Request too large'},413);
    body+=chunk.toString();
  }
  let input;
  try{input=JSON.parse(body)}catch{return json({error:'Invalid JSON'},400)}
  if(!(buyers.has(input?.buyer)||(openBuyers && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(input?.buyer) && input.buyer!==issuer)))return json({error:'Reserved Testnet buyer only'},403);
  if(collection)return fullRequest(input,challenge);
  if(Object.keys(input).length!==1)return json({error:'Invalid request'},400);
  const who=input.buyer;
  if(!inFlight.has(who)){
    const script=fileURLToPath(new URL(reservations?'./testnet_reservations.py':'./testnet_mint.py',import.meta.url));
    inFlight.set(who,run(process.env.CB_PILOT_PYTHON || 'python3',[script,who],{timeout:180000})
      .then(({stdout})=>JSON.parse(stdout)).finally(()=>inFlight.delete(who)));
  }
  const result=await inFlight.get(who);
  return json(result,result.status||200);
}
async function route(req){
  if(req.headers.host!==new URL(origin).host || !req.url.startsWith('/') || req.url.startsWith('//'))return json({error:'Unknown host'},403);
  const url=new URL(req.url,origin);
  if(url.origin!==origin)return json({error:'Unknown origin'},403);
  if(collection && url.pathname==='/xrpl/api/challenge')return reserve(req,true);
  if(url.pathname==='/xrpl/api/mint')return reserve(req);
  const result=await handle(new Request(url,{method:req.method}),env);
  if(collection && req.method==='GET' && ['/xrpl/api/receipt','/xrpl/api/reconcile'].includes(url.pathname) && result.ok){
    const receipt=await result.clone().json();
    if(receipt.state==='complete')await collectionCall(['record-receipt'],{hash:receipt.hash,token:receipt.token,
      buyer:url.searchParams.get('buyer'),offer:url.searchParams.get('offer')});
  }
  if(url.pathname==='/xrpl/api/status' && req.method==='GET'){
    return json({...await result.json(),mintMode:collection?'collection':'single-slot'});
  }
  return result;
}
createServer(async(req,res)=>{
  try{
    const out=await route(req);
    res.writeHead(out.status,Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  }catch(err){
    const detail=err.stderr?.trim().split('\n').at(-1)||err.name;
    console.error('Testnet request failed:',String(detail).slice(0,200));
    res.writeHead(503,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify({error:'Testnet unavailable. Retry to resume the same mint.'}));
  }
}).listen(18840,'127.0.0.1',()=>console.log('Testnet pilot listening at '+origin));
