import crypto from 'node:crypto';import assert from 'node:assert/strict';
import {verifyEncryptedPart,digest,validateGateway,readBounded,client} from './pinata-backup-io.mjs';
let n=0;async function test(name,fn){await fn();n++;console.log('PASS',name);}
const key=crypto.randomBytes(32),iv=crypto.randomBytes(12),aad=Buffer.from('synthetic test only'),clear=crypto.randomBytes(2048),c=crypto.createCipheriv('aes-256-gcm',key,iv);c.setAAD(aad);const b=Buffer.concat([c.update(clear),c.final()]);
const p={index:0,fileId:'test-file',cid:'bafyaaaaa',bytes:b.length,iv:iv.toString('base64'),aad:aad.toString('base64'),tag:c.getAuthTag().toString('base64'),ciphertextSha256:digest(b),plaintextSha256:digest(clear)};
await test('Authenticated decryption and both hashes match',()=>assert.ok(verifyEncryptedPart(b,p,key.toString('base64')).equals(clear)));
await test('Truncated bytes rejected',()=>assert.throws(()=>verifyEncryptedPart(b.subarray(1),p,key.toString('base64'))));
await test('Wrong ciphertext hash rejected',()=>assert.throws(()=>verifyEncryptedPart(b,{...p,ciphertextSha256:'0'.repeat(64)},key.toString('base64'))));
await test('Wrong plaintext hash rejected',()=>assert.throws(()=>verifyEncryptedPart(b,{...p,plaintextSha256:'0'.repeat(64)},key.toString('base64'))));
await test('Wrong GCM key rejected',()=>assert.throws(()=>verifyEncryptedPart(b,p,crypto.randomBytes(32).toString('base64'))));
await test('Wrong GCM authentication tag rejected',()=>assert.throws(()=>verifyEncryptedPart(b,{...p,tag:Buffer.alloc(16).toString('base64')},key.toString('base64'))));
await test('Only a Pinata HTTPS account gateway accepted',()=>{assert.equal(validateGateway('unit-test.mypinata.cloud'),'https://unit-test.mypinata.cloud');for(const x of ['http://unit-test.mypinata.cloud','https://evil.test','https://user:pass@unit-test.mypinata.cloud','unit-test.mypinata.cloud.evil.test'])assert.throws(()=>validateGateway(x));});
await test('Oversized streamed download rejected',async()=>await assert.rejects(readBounded(new Response(b),100)));
const jwt='TEST_ONLY_FAKE_CREDENTIAL_'+'a'.repeat(64);let calls=0;
const mock=async(url,options)=>{
 calls++;
 if(url==='https://api.pinata.cloud/v3/ipfs/gateways')return Response.json({data:{rows:[{domain:'unit-test.mypinata.cloud'}]}});
 if(url==='https://api.pinata.cloud/v3/files/private/test-file')return Response.json({data:{id:p.fileId,cid:p.cid,size:b.length+8010}});
 if(url==='https://api.pinata.cloud/v3/files/sign'){assert.equal(JSON.parse(options.body).url,'https://unit-test.mypinata.cloud/files/'+p.cid);assert.equal(options.headers.Authorization,'Bearer '+jwt);return Response.json({data:'https://unit-test.mypinata.cloud/files/'+p.cid+'?signature=not-a-real-signature'});}
 assert.ok(url.startsWith('https://unit-test.mypinata.cloud/'));assert.equal(options.headers,undefined);assert.equal(options.redirect,'error');return new Response(b);
};
await test('Metadata accounting size does not substitute for verified bytes',async()=>{const a=client(jwt,mock),g=await a.gateway(),r=await a.readPart(p,key.toString('base64'),g);assert.equal(r.metadataSize,b.length+8010);assert.ok(r.clear.equals(clear));assert.equal(calls,4);});
await test('Wrong metadata ID fails before signing',async()=>{const a=client(jwt,async()=>Response.json({data:{id:'wrong',cid:p.cid}}));await assert.rejects(a.readPart(p,key.toString('base64'),'unit-test.mypinata.cloud'));});
await test('Signed link cannot redirect credentials/content to another host',async()=>{const a=client(jwt,async url=>Response.json(url.includes('/sign')?{data:'https://evil.test/files/'+p.cid}:{data:{id:p.fileId,cid:p.cid}}));await assert.rejects(a.readPart(p,key.toString('base64'),'unit-test.mypinata.cloud'));});
console.log(JSON.stringify({suite:'private-pinata-readback',passed:n,networkRequests:0,uploads:0}));
