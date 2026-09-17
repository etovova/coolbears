// Execute real candidate bytecode with the exact release StateInit, offline only.
import fs from 'node:fs';import crypto from 'node:crypto';import assert from 'node:assert/strict';
import * as core from '@ton/core';import {Blockchain,internal} from '@ton/sandbox';
import {verifyPackage,verifyLive,verifyItem,testnetRequest,itemAddress,PACKAGE_SHA256,EXPECTED_OWNER,REVEAL_AT} from '../launch/package-tools.mjs';
const bytes=fs.readFileSync('launch/candidate.json'),p=JSON.parse(bytes);let passed=0;const pass=n=>{passed++;console.log('PASS',n);};
assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),PACKAGE_SHA256);pass('Exact release package checksum');
const v=verifyPackage(core,p);pass('Full StateInit, code, price, owner, reserve, royalty and commitment');
for(const [k,val] of Object.entries({version:'wrong',network:'testnet',ownerAddressRaw:'0:wrong',collectionAddressRaw:'0:wrong',collectionCodeHash:'0'.repeat(64),finalContentCommitment:'0'.repeat(64),supply:10001,royaltyBps:1000})){assert.throws(()=>verifyPackage(core,{...p,[k]:val}));pass('Reject modified '+k);}
const wallet={account:{chain:'-3',address:EXPECTED_OWNER}},uninit={status:'uninitialized'};
for(const action of ['deploy','claim','open','mint']){assert.throws(()=>testnetRequest(core,p,action,{account:{chain:'-239',address:EXPECTED_OWNER}},uninit));}pass('All test actions reject mainnet wallet');
assert.throws(()=>testnetRequest(core,p,'deploy',{account:{chain:'-3',address:'0:'+'0'.repeat(64)}},uninit));pass('Unapproved testnet wallet blocked');
const bc=await Blockchain.create();bc.now=REVEAL_AT-86400;
async function submit(action,state){const q=testnetRequest(core,p,action,wallet,state,7n,bc.now);assert.equal(q.network,'-3');assert.equal(q.from,EXPECTED_OWNER);assert.equal(q.messages.length,1);const m=q.messages[0],dest=core.Address.parseFriendly(m.address);assert.equal(dest.isTestOnly,true);
 const init=m.stateInit?core.loadStateInit(core.Cell.fromBase64(m.stateInit).beginParse()):undefined;
 const r=await bc.sendMessage(internal({from:v.data.owner,to:dest.address,bounce:dest.isBounceable,value:BigInt(m.amount),stateInit:init,body:core.Cell.fromBase64(m.payload)}));
 const tx=r.transactions.find(x=>x.inMessage?.info.dest?.equals(v.address));assert.ok(tx);assert.equal(tx.description.computePhase.exitCode,0);assert.equal(tx.description.aborted,false);if(tx.description.actionPhase)assert.equal(tx.description.actionPhase.success,true);return r;}
async function account(addr){const s=await bc.getContract(addr);assert.equal(s.accountState.type,'active');return {state:'active',code:s.accountState.state.code.toBoc().toString('base64'),data:s.accountState.state.data.toBoc().toString('base64')};}
await submit('deploy',uninit);let a=await account(v.address),d=verifyLive(core,p,a);assert.equal(d.paused,true);assert.equal(d.next,0n);pass('Exact final StateInit deploys paused via TESTNET request');
assert.throws(()=>testnetRequest(core,p,'open',wallet,{status:'active',next:0,paused:true,creatorVerified:false}));pass('Cannot open before creator reserve');
await submit('claim',{status:'active',next:0,paused:true});
const n0=itemAddress(core,p,0);verifyItem(core,p,await account(n0),0,EXPECTED_OWNER);pass('Creator #0000 initialized at calculated address and owner');
assert.throws(()=>verifyItem(core,p,{...a,state:'uninitialized'},0,EXPECTED_OWNER));pass('Counter cannot substitute for initialized NFT');
await submit('open',{status:'active',next:1,paused:true,creatorVerified:true});d=verifyLive(core,p,await account(v.address));assert.equal(d.paused,false);pass('Explicit opening changes only test state');
const result=await submit('mint',{status:'active',next:1,paused:false,creatorVerified:true});
const n1=itemAddress(core,p,1);verifyItem(core,p,await account(n1),1,EXPECTED_OWNER);verifyItem(core,p,await account(n0),0,EXPECTED_OWNER);pass('Normal #0001 minted, both NFT owners verified');
assert.throws(()=>testnetRequest(core,p,'mint',wallet,{status:'active',next:2,paused:false,creatorVerified:true}));pass('Test page blocks accidental repeated public test purchase');
const individual=core.beginCell().storeStringTail('0001.json').endCell();const s=(await bc.runGetMethod(v.address,'get_nft_content',[{type:'int',value:1n},{type:'cell',cell:individual}])).stackReader.readCell().beginParse();assert.equal(s.loadUint(8),1);assert.equal(s.loadStringTail(),p.preRevealMetadataRootIpfs+'0001.json');pass('Actual hidden metadata URI is used');
const outgoing=result.transactions.find(t=>t.inMessage?.info.type==='internal'&&t.inMessage.info.src.equals(v.address)&&t.inMessage.info.dest.equals(v.data.treasury)&&t.inMessage.info.value.coins===7000000000n);assert.ok(outgoing);pass('Exactly 7 TON price returned to approved treasury in sandbox');
assert.throws(()=>verifyLive(core,p,{...a,code:v.data.item.toBoc().toString('base64')}));pass('Wrong live bytecode rejected');
fs.mkdirSync('build/final-testnet',{recursive:true});const report={schema:1,status:'OFFLINE_TESTS_PASSED_NOT_TESTNET_DEPLOYED',packageSha256:PACKAGE_SHA256,collectionAddressRaw:p.collectionAddressRaw,codeHash:p.collectionCodeHash,passed,realNetworkRequests:0,realTransactions:0};fs.writeFileSync('build/final-testnet/report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
