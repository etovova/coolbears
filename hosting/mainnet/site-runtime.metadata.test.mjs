import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {makePublicSiteRuntime} from './site-runtime.mjs';
const origin='https://coolbears-nfts.com',zero='1'.repeat(64),template=JSON.parse(await readFile(new URL('../../metadata/0000.json',import.meta.url)));let count=0;
const worker=makePublicSiteRuntime({origin,profileSha256:zero,sourcePolicySha256:zero,buildSha256:zero,overlay:{},originalAssets:{a:1,b:2,c:3},buyerWorker:{fetch:()=>{throw Error('unexpected payment route');}}});
const env={ASSETS:{fetch:async req=>{count++;const m=new URL(req.url).pathname.match(/^\/metadata\/hidden\/(\d{4})\.json$/);assert.ok(m);return Response.json({...template,name:template.name.replace('0000',m[1])});}}};
const get=(p,opt)=>worker.fetch(new Request(origin+p,opt),env,{});
for(let i=1;i<10000;i++){const v=await get('/metadata/hidden-indexed/'+i+'.json');assert.equal(v.status,200);assert.deepEqual(await v.json(),{...template,name:template.name.replace('0000',String(i).padStart(4,'0'))});assert.equal(v.headers.get('access-control-allow-origin'),'*');}
const old=count;for(const p of ['0','10000','0001','-1','x','1.json?x=1','1%2F2'])assert.equal((await get('/metadata/hidden-indexed/'+p+'.json')).status,404);
assert.equal(count,old);assert.equal((await get('/metadata/reveal-proof.json')).status,404);assert.equal((await get('/metadata/hidden-indexed/1.json',{method:'POST'})).status,405);const h=await get('/metadata/hidden-indexed/9.json',{method:'HEAD'});assert.equal(h.status,200);assert.equal(await h.text(),'');console.log('PASS all 9,999 public metadata URLs, strict numbering, template equality, no premature reveal, CORS and HEAD, no payment calls');
