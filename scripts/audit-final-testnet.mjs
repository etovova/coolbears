// Read-only audit of this candidate's TESTNET transactions. Never signs or sends.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Address,Cell,beginCell,loadStateInit,contractAddress,loadTransaction,storeMessage} from '@ton/core';
export const PACKAGE_HASH='f4fb17938415afa7541e69463337565a0e3a0e7c73a1eb71d3b87582c8becd05';
export const CODE_HASH='4a5dcc56c96ab4bfb1815242b3e696ee1a1663c9f1254c893455d47bb746dc2b';
export const OWNER='0:6ea2cc995c7d4f236441c6c520b236c3e919ec54e331b4269528428c651a5717';
const OPCODE={claim:0x52535630,open:0x554e5053,mint:0x4d494e54};
const check=(ok,msg)=>{if(!ok)throw Error(msg);};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
export function successful(t){const d=t.description;return d.type==='generic'&&!d.aborted&&d.computePhase.type==='vm'&&d.computePhase.success&&[0,1].includes(d.computePhase.exitCode)&&(!d.actionPhase||d.actionPhase.success&&d.actionPhase.resultCode===0);}
export const messageHash=m=>beginCell().store(storeMessage(m)).endCell().hash().toString('hex');
const raw=a=>a?.toRawString();
const empty=c=>c.bits.length===0&&c.refs.length===0;
export function decodeTransaction(j,address){
 check(typeof j.data==='string','RPC did not return transaction BOC');
 const cells=Cell.fromBoc(Buffer.from(j.data,'base64'));check(cells.length===1,'More than one transaction root');
 const t=loadTransaction(cells[0].beginParse());
 check(t.address===BigInt('0x'+Address.parse(address).hash.toString('hex')),'Transaction belongs to another account');
 check(t.lt.toString()===j.transaction_id?.lt,'RPC/BOC logical time mismatch');
 check(cells[0].hash().equals(Buffer.from(j.transaction_id.hash,'base64')),'RPC/BOC transaction hash mismatch');
 return t;
}
export function verifyLinks(rows){
 const s=[...rows].sort((a,b)=>a.lt>b.lt?-1:1);
 for(let i=1;i<s.length;i++){
  check(s[i-1].prevTransactionLt===s[i].lt,'Missing transaction in account history');
  check(s[i-1].prevTransactionHash===BigInt('0x'+s[i].hash().toString('hex')),'Broken transaction hash chain');
 }
 return s;
}
export function auditPayments(p,collectionTxs,itemTxs,walletTxs){
 const ordered=verifyLinks(collectionTxs).reverse(),coll=p.collectionAddressRaw;
 check(ordered.length>0&&ordered[0].prevTransactionLt===0n,'Collection history must reach its first transaction');
 const owner=Address.parse(OWNER),init=loadStateInit(Cell.fromBase64(p.stateInitBocBase64).beginParse());
 const data=init.data.beginParse();data.loadAddress();data.loadUintBig(64);data.loadRef();const itemCode=data.loadRef();
 const address=i=>contractAddress(0,{code:itemCode,data:beginCell().storeUint(i,64).storeAddress(Address.parse(coll)).endCell()});
 const receipt=(m,list)=>list.filter(t=>t.inMessage&&messageHash(t.inMessage)===messageHash(m)&&successful(t));
 const senderReceipt=m=>walletTxs.filter(t=>successful(t)&&Array.from(t.outMessages.values()).some(out=>messageHash(out)===messageHash(m)));
 const operations=[];
 for(const t of ordered){
  const m=t.inMessage;if(m?.info.type!=='internal'||m.info.bounced||raw(m.info.src)!==OWNER)continue;
  let kind='';
  if(empty(m.body)&&t.oldStatus!=='active'&&t.endStatus==='active')kind='deploy';
  else if(m.body.bits.length>=96){const op=m.body.beginParse().loadUint(32);kind=Object.keys(OPCODE).find(k=>OPCODE[k]===op)||'';}
  if(!kind)continue;
  check(successful(t),`Relevant ${kind} transaction aborted or actions failed`);
  const incoming=m.info.value.coins,expected=kind==='deploy'?300000000n:kind==='open'?50000000n:7100000000n;
  check(incoming===expected,`Unexpected ${kind} payment`);
  check(senderReceipt(m).length===1,`Missing successful wallet send receipt for ${kind}`);
  if(kind==='deploy'){
   check(m.init?.code?.hash().equals(init.code.hash())&&m.init?.data?.hash().equals(init.data.hash()),'Deployment StateInit differs from approved package');
  }else{
   const s=m.body.beginParse();check(s.loadUint(32)===OPCODE[kind],'Wrong opcode');s.loadUintBig(64);
   if(kind==='mint')check(s.loadUint(8)===1,'Test mint did not request one NFT');
   check(s.remainingBits===0&&s.remainingRefs===0,'Trailing transaction command data');
  }
  const report={kind,transactionHash:t.hash().toString('hex'),lt:t.lt.toString(),timeUtc:new Date(t.now*1000).toISOString(),incomingNano:incoming.toString(),computeExitCode:t.description.computePhase.exitCode,actionResultCode:t.description.actionPhase?.resultCode??null};
  if(['claim','mint'].includes(kind)){
   const index=kind==='claim'?0:1;
   const out=Array.from(t.outMessages.values());check(out.length===3,'Expected NFT, price and remainder messages');
   check(out.every(x=>x.info.type==='internal'&&raw(x.info.src)===coll&&!x.info.bounced),'Unexpected outgoing message');
   const toItem=out.filter(x=>x.info.dest.equals(address(index)));check(toItem.length===1,'Missing NFT deployment message');
   const n=toItem[0];check(n.info.value.coins===50000000n,'Wrong NFT creation funding');
   const nd=n.body.beginParse();check(nd.loadAddress().equals(owner),'NFT minted to wrong recipient');
   check(nd.loadRef().beginParse().loadStringTail()===String(index).padStart(4,'0')+'.json'&&nd.remainingBits===0&&nd.remainingRefs===0,'Wrong individual metadata');
   const delivered=receipt(n,itemTxs[index]);check(delivered.length===1,'NFT deployment was not successfully delivered');
   const toOwner=out.filter(x=>x.info.dest.equals(owner));
   const price=toOwner.filter(x=>x.info.value.coins===7000000000n),refund=toOwner.filter(x=>x.info.value.coins>0n&&x.info.value.coins<50000000n);
   check(price.length===1&&refund.length===1,'Missing exact price or remainder refund');
   for(const pay of [...price,...refund])check(empty(pay.body)&&receipt(pay,walletTxs).length===1,'Outgoing amount was not successfully credited to wallet');
   report.tokenIndex=index;report.nftAddress=address(index).toString({testOnly:true});report.nftDeploymentHash=delivered[0].hash().toString('hex');
   report.priceNano='7000000000';report.nftCreationNano='50000000';report.refundNano=refund[0].info.value.coins.toString();
   report.executionAndForwardingNano=(incoming-7000000000n-50000000n-refund[0].info.value.coins).toString();
   report.priceReceiptHash=receipt(price[0],walletTxs)[0].hash().toString('hex');report.refundReceiptHash=receipt(refund[0],walletTxs)[0].hash().toString('hex');
  }
  operations.push(report);
 }
 check(JSON.stringify(operations.map(x=>x.kind))===JSON.stringify(['deploy','claim','open','mint']),'Expected exactly one ordered deploy/claim/open/mint sequence');
 return operations;
}
export function validateAccounts(p,accounts){
 const expected=loadStateInit(Cell.fromBase64(p.stateInitBocBase64).beginParse());
 check(expected.code.hash().toString('hex')===CODE_HASH&&contractAddress(0,expected).toRawString()===p.collectionAddressRaw,'Candidate StateInit mismatch');
 const read=c=>{const s=c.beginParse();const d={owner:s.loadAddress(),next:s.loadUintBig(64),content:s.loadRef(),item:s.loadRef(),royalty:s.loadRef(),treasury:s.loadAddress(),paused:s.loadBit(),revealed:s.loadBit(),commitment:s.loadUintBig(256)};check(!s.remainingBits&&!s.remainingRefs,'Extra state fields');return d;};
 const start=read(expected.data),live=accounts.collection;check(live.state==='active'&&Cell.fromBase64(live.code).hash().equals(expected.code.hash()),'Live collection code/state mismatch');
 const d=read(Cell.fromBase64(live.data));check(d.owner.toRawString()===OWNER&&d.treasury.toRawString()===OWNER&&d.next===2n&&!d.paused&&!d.revealed&&d.commitment===start.commitment,'Unexpected live mint state');
 for(const k of ['content','item','royalty'])check(d[k].hash().equals(start[k].hash()),`Live ${k} mismatch`);
 for(let i=0;i<2;i++){const n=accounts.items[i];check(n.state==='active'&&Cell.fromBase64(n.code).hash().equals(start.item.hash()),'NFT code mismatch');const s=Cell.fromBase64(n.data).beginParse();check(s.loadUintBig(64)===BigInt(i)&&s.loadAddress().toRawString()===p.collectionAddressRaw&&s.loadAddress().toRawString()===OWNER,'NFT recipient mismatch');check(s.loadRef().beginParse().loadStringTail()===String(i).padStart(4,'0')+'.json'&&!s.remainingBits&&!s.remainingRefs,'NFT content mismatch');}
 return start;
}
export async function main(){
 check(process.argv.includes('--read-testnet'),'Live read must be explicitly requested');
 const dir='build/final-testnet-audit';fs.mkdirSync(dir,{recursive:true});
 const rawPackage=fs.readFileSync('launch/candidate.json');check(hash(rawPackage)===PACKAGE_HASH,'Wrong candidate bytes');const p=JSON.parse(rawPackage);
 const counts={requests:0};let last=0;
 async function rpc(method,params){
  check(['getAddressInformation','getTransactions'].includes(method),'Only read-only methods permitted');
  for(let attempt=0;attempt<4;attempt++){
   await wait(Math.max(0,1500-(Date.now()-last)));last=Date.now();counts.requests++;
   const url=new URL('https://testnet.toncenter.com/api/v2/'+method);for(const [k,v] of Object.entries(params))url.searchParams.set(k,String(v));
   const r=await fetch(url,{signal:AbortSignal.timeout(25000)});
   if([429,500,502,503,504].includes(r.status)&&attempt<3){await wait(2200*(attempt+1));continue;}
   const j=await r.json();check(r.ok&&j.ok===true&&j.result!==undefined,`TESTNET ${method} HTTP ${r.status}`);return j.result;
  }throw Error('Read retries exhausted');
 }
 const info=a=>rpc('getAddressInformation',{address:a});
 const initial=loadStateInit(Cell.fromBase64(p.stateInitBocBase64).beginParse());const s=initial.data.beginParse();s.loadAddress();s.loadUintBig(64);s.loadRef();const item=s.loadRef();
 const nft=i=>contractAddress(0,{code:item,data:beginCell().storeUint(i,64).storeAddress(Address.parse(p.collectionAddressRaw)).endCell()}).toRawString();
 const addresses=[p.collectionAddressRaw,nft(0),nft(1),OWNER],snapshot={};for(const a of addresses)snapshot[a]=await info(a);
 validateAccounts(p,{collection:snapshot[addresses[0]],items:[snapshot[addresses[1]],snapshot[addresses[2]]]});
 async function history(address,notBefore=0){
  let cursor=snapshot[address].last_transaction_id;const found=new Map();
  for(let page=0;page<20;page++){
   const params={address,limit:100,archival:true,...(cursor?.lt&&cursor?.hash?{lt:cursor.lt,hash:cursor.hash}:{})};
   const j=await rpc('getTransactions',params);check(Array.isArray(j)&&j.length>0,'Incomplete account history');
   const ts=j.map(x=>decodeTransaction(x,address));let added=0;for(const t of ts)if(!found.has(t.lt.toString())){found.set(t.lt.toString(),t);added++;}
   check(added>0,'History pagination stalled');
   const all=verifyLinks(Array.from(found.values())),oldest=all.at(-1);
   if(oldest.prevTransactionLt===0n||notBefore&&oldest.now<notBefore)return all;
   cursor={lt:oldest.prevTransactionLt.toString(),hash:Buffer.from(oldest.prevTransactionHash.toString(16).padStart(64,'0'),'hex').toString('base64')};
  }throw Error('History exceeds bounded audit window');
 }
 const collection=await history(addresses[0]);const first=collection.at(-1).now;
 const items=[await history(addresses[1]),await history(addresses[2])],wallet=await history(OWNER,first-60);
 const payments=auditPayments(p,collection,items,wallet);
 const out={schema:1,status:'TESTNET_TRANSACTION_AUDIT_PASSED',network:'testnet',checkedAt:new Date().toISOString(),packageSha256:PACKAGE_HASH,codeHash:CODE_HASH,collectionAddressRaw:p.collectionAddressRaw,finalContentCommitment:p.finalContentCommitment,transactionHashes:payments.map(x=>x.transactionHash),transactionHistoryVerified:true,receiptsMatchedByMessageHash:true,collectionHistoryComplete:true,operations:payments,rpcRequests:counts.requests,transactionsSent:0,source:'Toncenter TESTNET RPC; transaction BOCs decoded locally and chained; not a lite-client proof',mainnetReady:false,mediaAvailabilityVerified:false};
 fs.writeFileSync(dir+'/report.json',JSON.stringify(out,null,2)+'\n');
 console.log(JSON.stringify(out,null,2));
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(e=>{console.error('AUDIT_NOT_PASSED:',e.message);process.exitCode=1;});
