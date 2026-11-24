import assert from 'node:assert/strict';
import cfg from '../../public-mainnet/deployment.mjs';
import {makePublicBuyerGateway} from '../orders/gateway/public-worker.mjs';
import {createPublicReleaseProfile} from '../public-sale/profile.mjs';
const {profileSha256,...profile}=cfg,Gateway=makePublicBuyerGateway(profile,{releaseProfile:createPublicReleaseProfile(cfg)}).BuyerCheckGate;
const now=1795510000000;let calls=0;
const state={version:2,cluster:cfg.cluster,genesisHash:cfg.genesisHash,day:Math.floor(now/86400000),checks:0,rpc:0,simulations:0,nextAt:0,holdUntil:0,cooldownUntil:now+41000};
const mem=new Map([['buyer-public-budget:v1:'+profileSha256,state]]);
const storage={get:async k=>structuredClone(mem.get(k)),put:async(k,v)=>{mem.set(k,structuredClone(v))},transaction:fn=>fn(storage)};
const g=new Gateway({storage},{MAINNET_RPC:{fetch:()=>{calls++;throw Error()}}},{clock:()=>now,pause:async()=>{}});
const req=new Request(cfg.origin+'/api/buyer/readiness');
for(const [kind,val] of [['COOLDOWN','41'],['BUSY','1'],['DAILY_LIMIT','86400']]){
 if(kind==='BUSY')g.busy=true;if(kind==='DAILY_LIMIT'){g.busy=false;Object.assign(state,{rpc:2000,cooldownUntil:0});mem.set('buyer-public-budget:v1:'+profileSha256,state);}
 const res=await g.fetch(req);assert.equal(res.status,200);assert.equal(res.headers.get('x-coolbears-readiness-reason'),kind);assert.equal(res.headers.get('retry-after'),val);assert.equal(res.headers.get('x-coolbears-network-verified'),'0');assert.equal((await res.json()).salesOpen,false);
}assert.equal(calls,0);console.log('PASS actual gateway cooldown, busy and daily-cap evidence, all fail closed and zero upstream calls');
