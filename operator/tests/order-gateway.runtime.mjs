// Real SQLite/restart checks. All account data, keys and RPC are disposable fixtures.
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buyerGatewayFixture } from './fixtures/buyer-gateway.mjs';
import { buyerGatewayRuntime } from './fixtures/buyer-gateway-runtime.mjs';
const fixture=await buyerGatewayFixture({syntheticOwner:true}),origin='https://buyer-runtime.test';
const persist=await mkdtemp(path.join(tmpdir(),'coolbears-buyer-check-runtime-'));
const runtime=await buyerGatewayRuntime({fixture,origin,persist}),cases=[];
const input=fixture.input(),body=JSON.stringify({version:1,nonce:'a'.repeat(64),...input});
const dispatch=(headers={},value=body)=>runtime.dispatch(origin+'/api/buyer/check',{method:'POST',headers:{origin,'content-type':'application/json',...headers},body:value});
try{
  await runtime.start();
  assert.equal((await dispatch({origin:'https://foreign.test'})).status,403);
  assert.equal((await dispatch({},JSON.stringify({jsonrpc:'2.0',method:'sendTransaction',params:[]}))).status,400);
  assert.equal(fixture.calls.length,0);cases.push('foreign origin and arbitrary RPC reject before outbound');
  const good=await dispatch(),result=await good.json();assert.equal(good.status,200,JSON.stringify({result,errors:runtime.errors}));
  assert.equal(result.report.candidate.transactionBase64,input.request.transactionBase64);
  assert.equal(result.report.status,'wallet-check-passed');assert.equal(result.report.networkRequests,10);assert.equal(result.report.readyToSubmit,false);
  cases.push('full SDK account verification and unchanged partial pass in workerd');
  await runtime.stop();await runtime.start({DAILY_CHECK_CAP:'1',BUYER_HELIUS_API_KEY:'rotated-secret-42'});
  const before=fixture.calls.length;assert.equal((await dispatch()).status,429);assert.equal(fixture.calls.length,before);
  assert.equal((await runtime.ids()).length,1);cases.push('SQLite quota survives complete runtime restart and credential rotation');
  await runtime.stop();await runtime.start();
  // Ensure the last request spacing has elapsed; no long cooldown polling.
  await new Promise(r=>setTimeout(r,250));fixture.setMode('hold');let entered;
  const ready=new Promise(r=>entered=r);fixture.onRequest(()=>entered());
  const pending=dispatch();await Promise.race([ready,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('fixture upstream was not reached')),10000);ready.finally(()=>clearTimeout(timer));})]);const busy=await dispatch();assert.equal(busy.status,429);
  fixture.setMode('normal');fixture.onRequest(null);fixture.release();assert.equal((await pending).status,200);
  cases.push('SQLite/output gates and whole-check lock admit only one concurrent check');
  await new Promise(r=>setTimeout(r,250));fixture.setMode('429');
  const denied=await dispatch();assert.equal(denied.status,429);assert.ok(!(await denied.text()).includes('fixture-secret-42'));
  const charged=fixture.calls.length;await runtime.stop();await runtime.start();
  assert.equal((await dispatch()).status,429);assert.equal(fixture.calls.length,charged);
  cases.push('upstream failure is sanitized and charged cooldown survives runtime restart');
  assert.deepEqual(runtime.errors,[]);
  console.log(JSON.stringify({passed:true,cases,upstreamCalls:fixture.calls.length,transactionsSent:0,liveRpc:false,
    bundleBytes:Buffer.byteLength(runtime.contents),bundleSha256:createHash('sha256').update(runtime.contents).digest('hex')},null,2));
}finally{fixture.setMode('normal');fixture.release();await runtime.stop();await rm(persist,{recursive:true,force:true});}
