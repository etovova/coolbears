// One local browser, one disposable Testnet issuer, one designated buyer and one NFT.
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
const files={'home.html':'web/index.html','app.js':'web/app.js','site.css':'web/site.css',
  'translations.mjs':'web/translations.mjs','xaman.mjs':'web/xaman.mjs','wallet.js':'vendor/gemwallet.js',
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
let inFlight;
async function reserve(req){
  if(req.method!=='POST')return json({error:'POST required'},405);
  if(req.headers.origin!==origin || req.headers['content-type']!=='application/json')return json({error:'Local origin required'},403);
  let body='';
  for await(const chunk of req){
    if(body.length+chunk.length>128)return json({error:'Request too large'},413);
    body+=chunk.toString();
  }
  let input;
  try{input=JSON.parse(body)}catch{return json({error:'Invalid JSON'},400)}
  if(input?.buyer!==buyer || Object.keys(input).length!==1)return json({error:'Reserved Testnet buyer only'},403);
  if(!inFlight){
    const script=fileURLToPath(new URL('./testnet_mint.py',import.meta.url));
    inFlight=run(process.env.CB_PILOT_PYTHON || 'python3',[script,buyer],{timeout:180000})
      .then(({stdout})=>JSON.parse(stdout)).finally(()=>{inFlight=undefined});
  }
  return json(await inFlight);
}
async function route(req){
  if(req.headers.host!==new URL(origin).host || !req.url.startsWith('/') || req.url.startsWith('//'))return json({error:'Unknown host'},403);
  const url=new URL(req.url,origin);
  if(url.origin!==origin)return json({error:'Unknown origin'},403);
  if(url.pathname==='/xrpl/api/mint')return reserve(req);
  const result=await handle(new Request(url,{method:req.method}),env);
  if(url.pathname==='/xrpl/api/status' && req.method==='GET'){
    return json({...await result.json(),mintMode:'single-slot'});
  }
  return result;
}
createServer(async(req,res)=>{
  try{
    const out=await route(req);
    res.writeHead(out.status,Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  }catch{
    res.writeHead(503,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify({error:'Testnet unavailable. Retry to resume the same mint.'}));
  }
}).listen(18840,'127.0.0.1',()=>console.log('Testnet pilot listening at '+origin));
