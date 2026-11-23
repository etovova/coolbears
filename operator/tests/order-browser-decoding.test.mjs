import test from 'node:test';
import assert from 'node:assert/strict';
import {readJson} from '../orders/gateway/http.mjs';
const headers=encoding=>({'content-type':'application/json','content-encoding':encoding});
test('Fetch-decoded responses accept negotiated compression; body limits and input validation remain strict',async()=>{
 for(const code of ['gzip','br','zstd','deflate']){
  assert.deepEqual(await readJson(new Response('{"ok":true}',{headers:headers(code)}),{decodedResponse:true}),{ok:true});
  await assert.rejects(readJson(new Response('{"long":"abcdefghijkl"}',{headers:headers(code)}),{limit:12,decodedResponse:true}),/BODY_SIZE/);
  await assert.rejects(readJson(new Request('https://site.test/',{method:'POST',body:'{}',headers:headers(code)})),/CONTENT_TYPE/);
 }
 await assert.rejects(readJson(new Response('{}',{headers:headers('weird')}),{decodedResponse:true}),/CONTENT_TYPE/);
 await assert.rejects(readJson(new Response('{',{headers:headers('gzip')}),{decodedResponse:true}),/BODY/);
});
