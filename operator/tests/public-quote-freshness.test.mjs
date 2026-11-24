import test from 'node:test';
import assert from 'node:assert/strict';
import { DeploymentRpcError } from '../deployment/rpc.mjs';
import { unsignedFreshnessReader } from '../orders/public-preflight-model.mjs';

test('a temporary bank rejection re-reads the same slot and arguments without a second simulation',async()=>{
  const calls=[],params=['asset',{commitment:'confirmed',minContextSlot:123}];let first=true;
  const reader=unsignedFreshnessReader({call:async(m,p)=>{calls.push([m,p]);if(first){first=false;throw new DeploymentRpcError('RPC');}return 12;}},async()=>{});
  assert.equal(await reader.call('getBalance',params),12);assert.deepEqual(calls,[['getBalance',params],['getBalance',params]]);
});
test('the retry budget is shared by the entire final read; transport, simulation and submission are not retried',async()=>{
  let calls=0,waits=0;
  const r=unsignedFreshnessReader({call:async()=>{calls++;throw new DeploymentRpcError('RPC');}},async()=>{waits++;});
  await assert.rejects(r.call('isBlockhashValid',[]),{code:'RPC'});
  await assert.rejects(r.call('getBlockHeight',[]),{code:'RPC'});assert.equal(calls,4);assert.equal(waits,2);
  for(const [method,code] of [['getBalance','HTTP'],['getBalance','TIMEOUT'],['simulateTransaction','RPC'],['sendTransaction','RPC']]){
    let count=0;const z=unsignedFreshnessReader({call:async()=>{count++;throw new DeploymentRpcError(code);}},async()=>assert.fail('unexpected retry'));await assert.rejects(z.call(method,[]));assert.equal(count,1);
  }
});
