import assert from 'node:assert/strict';import {validateReceipt} from './finish-pinata-private-recovery.mjs';import {client} from './pinata-backup-io.mjs';
const size=153849791,part=41943040;let n=0;const test=(s,f)=>{f();n++;console.log('PASS',s);};
const base={schema:1,archiveSha256:'00c983a1af436b60008505ad3cd706615bd5a3e01cf1186a7127cbdde69f3252',archiveBytes:size,encryption:'AES-256-GCM',key:Buffer.alloc(32,1).toString('base64'),parts:[{index:0,offset:0,bytes:part,network:'private'}]};
test('Recorded first part may resume at correct offset',()=>assert.equal(validateReceipt(base),part));
test('Full four-part receipt covers exactly approved archive',()=>assert.equal(validateReceipt({...base,parts:Array.from({length:4},(_,index)=>({index,offset:index*part,bytes:Math.min(part,size-index*part),network:'private'}))}),size));
for(const [label,patch] of [['wrong archive',{archiveSha256:'0'.repeat(64)}],['empty receipt',{parts:[]}],['bad key',{key:''}],['duplicate part',{parts:[base.parts[0],base.parts[0]]}],['public part',{parts:[{...base.parts[0],network:'public'}]}],['gap',{parts:[{...base.parts[0],offset:1}]}],['wrong byte length',{parts:[{...base.parts[0],bytes:part-1}]}]])test(label+' rejected',()=>assert.throws(()=>validateReceipt({...base,...patch})));
const c=client('FAKE_TEST_CREDENTIAL_'+'x'.repeat(40),async()=>Response.json({data:{rows:[{domain:'synthetic-gateway'}]}}));assert.equal(await c.gateway(),'https://synthetic-gateway.mypinata.cloud');n++;
console.log(JSON.stringify({suite:'private-backup-resume',passed:n,realNetworkRequests:0,uploads:0}));
