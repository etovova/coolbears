// Real TVM execution in memory, with a synthetic treasury at the required owner
// address. This is NOT a live testnet result and requires no wallet private key.
import fs from 'node:fs';import assert from 'node:assert/strict';
import {Address,Cell,beginCell,loadStateInit,external,internal} from '@ton/core';
import {Blockchain,TreasuryContract,createShardAccount} from '@ton/sandbox';
import {auditPayments,decodeTransaction,validateAccounts,verifyLinks,OWNER} from './audit-final-testnet.mjs';
const p=JSON.parse(fs.readFileSync('launch/candidate.json')),owner=Address.parse(OWNER),collection=Address.parse(p.collectionAddressRaw),init=loadStateInit(Cell.fromBase64(p.stateInitBocBase64).beginParse());
const bc=await Blockchain.create();bc.now=1798761600-86400;
const sender=new TreasuryContract(0,123n);
await bc.setShardAccount(owner,createShardAccount({address:owner,...sender.init,balance:100000000000n}));
const transactions=[];
const body=(op,count)=>{let b=beginCell().storeUint(op,32).storeUint(1234,64);if(count)b=b.storeUint(count,8);return b.endCell();};
for(const [value,b,si] of [[300000000n,beginCell().endCell(),init],[7100000000n,body(0x52535630)],[50000000n,body(0x554e5053)],[7100000000n,body(0x4d494e54,1)]]){
 const transfer=sender.createTransfer({sendMode:1,messages:[internal({to:collection,value,bounce:!si,body:b,init:si})]});
 transactions.push(...(await bc.sendMessage(external({to:owner,body:transfer}))).transactions);bc.now++;
}
const ct=transactions.filter(t=>t.address===BigInt('0x'+collection.hash.toString('hex'))),wt=transactions.filter(t=>t.address===BigInt('0x'+owner.hash.toString('hex')));
const nfts=[];for(let i=0;i<2;i++){const a=(await bc.runGetMethod(collection,'get_nft_address_by_index',[{type:'int',value:BigInt(i)}])).stackReader.readAddress();nfts.push(a);}
const nt=nfts.map(a=>transactions.filter(t=>t.address===BigInt('0x'+a.hash.toString('hex'))));
let passed=0;const test=(n,f)=>{f();passed++;console.log('PASS',n);};
test('TVM sequence fully linked to wallet sends, NFT deployments, price and refunds',()=>{const r=auditPayments(p,ct,nt,wt);assert.equal(r.length,4);assert.equal(r[1].priceNano,'7000000000');assert.ok(BigInt(r[3].refundNano)>0n);});
test('Transaction BOC and API hash/lt agree',()=>{const t=ct[0];const j={data:t.raw.toBoc().toString('base64'),transaction_id:{lt:t.lt.toString(),hash:t.hash().toString('base64')}};assert.equal(decodeTransaction(j,p.collectionAddressRaw).lt,t.lt);assert.throws(()=>decodeTransaction({...j,transaction_id:{...j.transaction_id,hash:Buffer.alloc(32).toString('base64')}},p.collectionAddressRaw));});
test('Wrong account in BOC rejected',()=>{const t=ct[0];assert.throws(()=>decodeTransaction({data:t.raw.toBoc().toString('base64'),transaction_id:{lt:t.lt.toString(),hash:t.hash().toString('base64')}},OWNER));});
test('Missing collection transaction rejected',()=>assert.throws(()=>verifyLinks([ct[0],ct[2],ct[3]])));
test('Truncated history rejected',()=>assert.throws(()=>auditPayments(p,ct.slice(1),nt,wt)));
test('NFT receipt missing rejected',()=>assert.throws(()=>auditPayments(p,ct,[[],nt[1]],wt)));
test('Wallet delivery receipts missing rejected',()=>assert.throws(()=>auditPayments(p,ct,nt,wt.filter(t=>t.inMessage?.info.type!=='internal'))));
test('No wallet send evidence rejected',()=>assert.throws(()=>auditPayments(p,ct,nt,wt.filter(t=>t.inMessage?.info.type==='internal'))));
test('Failed price/refund credits rejected',()=>assert.throws(()=>auditPayments(p,ct,nt,wt.map(t=>t.inMessage?.info.type==='internal'?{...t,description:{...t.description,aborted:true}}:t))));
test('Failed NFT transaction rejected',()=>assert.throws(()=>auditPayments(p,ct,nt.map(rows=>rows.map(t=>({...t,description:{...t.description,aborted:true}}))),wt)));
test('Failed collection action rejected',()=>assert.throws(()=>auditPayments(p,ct.map((t,i)=>i===1?{...t,description:{...t.description,actionPhase:{...t.description.actionPhase,success:false}}}:t),nt,wt)));
test('Duplicate collection operation rejected',()=>assert.throws(()=>auditPayments(p,[...ct,ct[1]],nt,wt)));
async function account(a){const s=(await bc.getContract(a)).account.account.storage;assert.equal(s.state.type,'active');return{state:'active',code:s.state.state.code.toBoc().toString('base64'),data:s.state.state.data.toBoc().toString('base64')};}
const accounts={collection:await account(collection),items:[await account(nfts[0]),await account(nfts[1])]};
test('Exact candidate and NFT recipients pass snapshot validation',()=>validateAccounts(p,accounts));
test('Uninitialized NFT fails snapshot validation',()=>assert.throws(()=>validateAccounts(p,{...accounts,items:[{state:'uninitialized'},accounts.items[1]]})));
fs.mkdirSync('build/final-testnet-audit',{recursive:true});fs.writeFileSync('build/final-testnet-audit/offline-tests.json',JSON.stringify({status:'PASS',checks:passed,fixture:'in-memory TVM only',networkRequests:0,realTransactions:0},null,2));
console.log('FINAL_TESTNET_AUDIT_OFFLINE_TESTS',passed);
