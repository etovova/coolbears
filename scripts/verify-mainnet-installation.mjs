// Read-only operational gate for the exact closed deployment. No wallet or send.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import config from '../public-mainnet/deployment.mjs';
const origin='https://coolbears-nfts.com',sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(config.origin,origin);
const expected=JSON.parse(await readFile('hosting/mainnet/expected-installation.json','utf8'));
assert.equal(Object.keys(expected).sort().join(' '),'buildSha256 kind originalAssetsVerified preservedAssets profileSha256 sourcePolicySha256 version');assert.equal(expected.version,1);assert.equal(expected.kind,'coolbears-public-site-deployment');assert.equal(expected.originalAssetsVerified,true);
assert.equal(expected.profileSha256,config.profileSha256);
const policyBytes=await readFile('metadata/policy.json');assert.equal(sha(policyBytes),expected.sourcePolicySha256);
const checks=[];
async function get(path){
 const response=await fetch(origin+path,{redirect:'manual',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(20000)});
 assert.equal(response.status,200,'HTTP '+path);const length=response.headers.get('content-length');
 assert.ok(length===null||(/^\d+$/.test(length)&&Number(length)<=5000000),'size '+path);
 const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length<=5000000,'size '+path);return{response,bytes};
}
const deployment=await get('/api/buyer/deployment'),actual=JSON.parse(deployment.bytes.toString('utf8'));assert.deepEqual(actual,expected);
checks.push({kind:'deployment',path:'/api/buyer/deployment',verified:true});
// The deployment proof already performs two fresh reads through the shared
// gateway. Respect its 200 ms admission interval before this separate check.
await new Promise(resolve=>setTimeout(resolve,250));
const readiness=await get('/api/buyer/readiness'),state=JSON.parse(readiness.bytes.toString('utf8'));
assert.equal(readiness.response.headers.get('x-coolbears-network-verified'),'1');
assert.equal(Object.keys(state).sort().join(' '),'checkedAt cluster collection expiresAt genesisHash guard hiddenCommitmentSha256 machine maximumPerOrder profileSha256 salesOpen status storageMode unitPriceLamports version');assert.equal(state.version,1);assert.equal(state.profileSha256,config.profileSha256);
for(const k of ['cluster','genesisHash','machine','collection','guard','storageMode','hiddenCommitmentSha256'])assert.equal(state[k],config[k]);
assert.equal(state.unitPriceLamports,'200000000');assert.equal(state.maximumPerOrder,50);assert.equal(state.salesOpen,false);
assert.ok(['closed','unavailable'].includes(state.status));const now=Date.now();
assert.ok(Number.isSafeInteger(state.checkedAt)&&Number.isSafeInteger(state.expiresAt)&&state.checkedAt<=now&&now<state.expiresAt&&state.expiresAt-state.checkedAt===8000);
checks.push({kind:'mainnet-network-and-closed-readiness',verified:true,status:state.status});
const files=JSON.parse(await readFile('scripts/public-files.json','utf8'));
const overlay=[...files.filter(x=>x.startsWith('public-mainnet/')).map(file=>({file,path:'/'+file})),
 {file:'app.js',path:'/app.js?v=public-mainnet-20261018-1'},{file:'index.html',path:'/'},{file:'index.html',path:'/index.html'}];
const original=files.filter(x=>x.startsWith('assets/collection/')||x.startsWith('assets/brand/')).map(file=>({file,path:'/'+file}));
const targets=[...overlay,...original];
// Fixed small concurrency only for independent immutable public content reads.
let next=0;await Promise.all(Array.from({length:6},async()=>{while(next<targets.length){const item=targets[next++],expectedBytes=await readFile(item.file),observed=await get(item.path);assert.equal(observed.bytes.length,expectedBytes.length,item.path);assert.equal(sha(observed.bytes),sha(expectedBytes),item.path);checks.push({kind:'public-content',path:item.path,bytes:observed.bytes.length,sha256:sha(observed.bytes),verified:true});}}));
assert.equal(overlay.length,217);assert.equal(original.length,6);
// Existing Devnet laboratory gets a genesis read only; its records and supply are never changed.
async function readLegacyDevnetGenesis({fetchImpl=fetch,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 for(let readAttempts=1;readAttempts<=3;readAttempts++){
  const response=await fetchImpl('https://coolbears-devnet-rpc.yauheni84.workers.dev/rpc',{method:'POST',redirect:'manual',credentials:'omit',headers:{origin,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getGenesisHash',params:[]}),signal:AbortSignal.timeout(20000)});
  const body=await response.json();
  if(response.status===200){
   assert.deepEqual(body,{jsonrpc:'2.0',id:1,result:'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'},'legacy Devnet genesis response');
   return{readAttempts};
  }
  assert.equal(response.status,429,'legacy Devnet genesis read');
  assert.deepEqual(body,{jsonrpc:'2.0',id:1,error:{code:-32098,message:'CoolBears Devnet RPC request unavailable.',data:{category:'RATE_LIMIT'}}},'legacy Devnet admission response');
  const retryAfter=response.headers.get('retry-after');
  assert.ok(typeof retryAfter==='string'&&/^[1-5]$/.test(retryAfter),'legacy Devnet bounded Retry-After');
  assert.ok(readAttempts<3,'legacy Devnet genesis read limit');
  await pause(Number(retryAfter)*1000);
 }
}
const legacy=await readLegacyDevnetGenesis();
checks.push({kind:'preserved-legacy-devnet-genesis',verified:true,readAttempts:legacy.readAttempts,transactionsSent:0});
const artifact={version:1,stage:'actual-closed-mainnet-site-operational-check',status:'passed',observedAt:new Date().toISOString(),origin,actualInstallationProof:actual,backendNetworkVerified:true,readinessStatus:state.status,salesOpen:false,overlayFilesVerified:overlay.length,originalMediaVerified:original.length,legacyDevnetReadAttempts:legacy.readAttempts,checks,financialTransactionsSent:0,walletInvocations:0,limitations:['Live site bytes and named Mainnet read path were checked; no owner wallet signature or buyer transaction was sent. Provider plan, billing capacity and production traffic availability are not established by these reads.']};
await mkdir('build',{recursive:true});await writeFile('build/mainnet-installation-observation.SAFE.json',JSON.stringify(artifact,null,2)+'\n');
console.log(JSON.stringify({status:'passed',actualInstallationProof:actual,backendNetworkVerified:true,readinessStatus:state.status,salesOpen:false,overlayFilesVerified:overlay.length,originalMediaVerified:original.length,financialTransactionsSent:0}));
