import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {createPrivateBuyerController} from '../operator/orders/buyer-console/controller.mjs';
import {consoleStorageOptions} from '../operator/orders/buyer-console/config.mjs';
import {validatePublicBuyerConfig,buyerScopeConfig} from '../public-mainnet/config.mjs';
import config from '../public-mainnet/deployment.mjs';

const root=new URL('../',import.meta.url),source=await readFile(new URL('public-mainnet/factory.mjs',root),'utf8');
const timers=new Map();let sequence=0,walletCalls=0,subscriptions=0,releaseFirst;
const context=vm.createContext({structuredClone,location:{origin:config.origin},
  setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)});
const values={
  '../operator/orders/browser-storage.mjs':{createBuyerStorage:()=>({readRecoverySnapshot:async()=>null,readBuyerSubmission:async()=>null})},
  '../operator/orders/buyer-console/controller.mjs':{createPrivateBuyerController},
  '../operator/orders/buyer-console/config.mjs':{consoleStorageOptions,createScopeIndex:()=>({list:()=>[],save:async()=>{}})},
  './config.mjs':{validatePublicBuyerConfig,buyerScopeConfig},
  './readiness-client.mjs':{createPublicReadinessClient:()=>({state:()=>({status:'closed',salesOpen:false}),dispose(){},refresh:async()=>{},requireOpen:async()=>{throw Error('PUBLIC_SALES_CLOSED');}})},
};
for(const[path,name]of[
  ['wallet-client','createBuyerWalletClient'],['sender','createBuyerSender'],['response-recovery-client','createBuyerResponseRecovery'],
  ['prewallet-recovery-client','createBuyerPrewalletRecovery'],['custody-recovery-client','createBuyerCustodyRecovery'],
  ['gateway/preparation-client','createBuyerPreparationClient'],['gateway/client','createBuyerCheckClient'],['gateway/submission-client','createBuyerSubmissionTransport'],
])values[`../operator/orders/${path}.mjs`]={[name]:()=>{throw Error('UNEXPECTED_PURCHASE_PORT');}};
// The factory constructs these two ports before an order exists; neither may do IO.
values['../operator/orders/gateway/preparation-client.mjs'].createBuyerPreparationClient=()=>async()=>{throw Error('UNEXPECTED_PREPARATION');};
values['../operator/orders/gateway/submission-client.mjs'].createBuyerSubmissionTransport=()=>({});
values['../operator/orders/cost-approval.mjs']={validateCostApproval:()=>{throw Error('UNEXPECTED_COST_APPROVAL');}};
const module=new vm.SourceTextModule(source,{context});
await module.link(path=>{assert.ok(values[path],path);const exports=values[path];return new vm.SyntheticModule(Object.keys(exports),function(){
  for(const[key,value]of Object.entries(exports))this.setExport(key,value);
},{context});});await module.evaluate();
const key=new PublicKey(new Uint8Array(32).fill(7)),account=Object.freeze({address:key.toBase58(),publicKey:key.toBytes(),chains:['solana:mainnet'],features:['solana:signTransaction']});
const connectFeature=Object.freeze({async connect(){assert.equal(this,connectFeature);walletCalls++;
  if(walletCalls===1)return new Promise(resolve=>{releaseFirst=resolve;});return{accounts:[account]};}});
let accounts=[];
const wallet=Object.freeze({name:'Synthetic frozen wallet',version:'1.0.0',chains:['solana:mainnet'],get accounts(){return accounts;},features:Object.freeze({
  'standard:connect':connectFeature,'standard:events':Object.freeze({on(){subscriptions++;return()=>{subscriptions--;};}}),
  'solana:signTransaction':Object.freeze({supportedTransactionVersions:[0],signTransaction(){throw Error('UNEXPECTED_SIGNATURE');}}),
})});
const client=module.namespace.createPublicBuyerConsole(config),cases=[];
try{
  const first=client.connectWallet(wallet);first.catch(()=>{});
  for(let i=0;i<10&&walletCalls===0;i++)await Promise.resolve();
  assert.equal(walletCalls,1);assert.equal(client.state().busy,true);assert.equal(timers.size,1);
  const timer=[...timers.values()][0];assert.equal(timer.ms,15000);timer.fn();
  await assert.rejects(first,/WALLET_CONNECT_TIMEOUT/);assert.equal(client.state().busy,false);assert.equal(timers.size,0);assert.equal(subscriptions,0);
  cases.push({name:'stalled-connect-times-out-inside-native-operation-and-releases-busy',passed:true});

  accounts=[account];await client.connectWallet(wallet);await client.selectAccount(account.address);
  assert.equal(walletCalls,2);assert.equal(client.state().busy,false);assert.equal(client.state().selectedAccount,account.address);assert.equal(subscriptions,1);
  cases.push({name:'same-frozen-wallet-can-reconnect-with-live-account-getter',passed:true});

  const selected=JSON.stringify(client.state());releaseFirst({accounts:[]});
  for(let i=0;i<10;i++)await Promise.resolve();
  assert.equal(JSON.stringify(client.state()),selected);assert.equal(walletCalls,2);assert.equal(subscriptions,1);assert.equal(timers.size,0);
  cases.push({name:'late-first-connect-response-cannot-overwrite-retry-or-register-stale-listener',passed:true});

  const proof={version:1,passed:true,checksPassed:cases.length,checksFailed:0,cases,walletConnectCalls:walletCalls,realWalletCalls:0,realRpcRequests:0,realTransactionsSent:0,
    factory:{sha256:createHash('sha256').update(source).digest('hex')},
    limitations:['Production public factory and unchanged native controller executed with a synthetic Wallet Standard wallet, controlled deadline timers and synthetic storage/readiness ports. No physical browser, extension, custody, signature, RPC or successful purchase is attested.']};
  await mkdir(new URL('build/public-mainnet/',root),{recursive:true});
  await writeFile(new URL('build/public-mainnet/public-wallet-connect-validation.SAFE.json',root),JSON.stringify(proof,null,2)+'\n');
  console.log(JSON.stringify({passed:true,checks:cases.length,walletConnectCalls:walletCalls,realTransactionsSent:0}));
}finally{client.dispose();timers.clear();}
