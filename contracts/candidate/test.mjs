// Offline tests against real TVM execution. No live RPC or wallet signing.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compileFunc} from '@ton-community/func-js';
import {Blockchain} from '@ton/sandbox';
import {Address,Cell,beginCell,contractAddress,loadStateInit,toNano,external} from '@ton/core';
const SELF=fileURLToPath(import.meta.url);
const OLD='contracts/src/coolbears-collection-mint.fc';
const SRC='contracts/candidate/collection.fc';
const AT=1798761600, OP={mint:0x4d494e54,claim:0x52535630,pause:0x50415553,open:0x554e5053,reveal:0x5245564c,sweep:0x53574550};
if(process.argv[2]==='compile'){
  const src=process.argv[3];
  const r=await compileFunc({targets:['collection.fc'],sources:{'stdlib.fc':fs.readFileSync('/tmp/token-contract/stdlib.fc','utf8'),'collection.fc':fs.readFileSync(src,'utf8')}});
  if(r.status!=='ok')throw Error(r.message);
  console.log(r.codeBoc);process.exit(0);
}
function compile(src){const r=spawnSync(process.execPath,[SELF,'compile',src],{encoding:'utf8',maxBuffer:1000000});if(r.status!==0)throw Error(r.stderr||r.stdout);return Cell.fromBase64(r.stdout.trim());}
const original=JSON.parse(fs.readFileSync('mainnet/owner/deployment.json','utf8'));
const oldInit=loadStateInit(Cell.fromBase64(original.stateInitBocBase64).beginParse());
assert.equal(compile(OLD).hash().toString('hex'),original.collectionCodeHash,'Existing source does not match existing deployment bytecode');
assert.equal(oldInit.code.hash().toString('hex'),original.collectionCodeHash);
assert.equal(contractAddress(0,oldInit).toRawString(),original.collectionAddressRaw);
const od=oldInit.data.beginParse();od.loadAddress();od.loadUintBig(64);od.loadRef();const itemCode=od.loadRef();
const code=compile(SRC);
const makeContent=root=>beginCell().storeRef(beginCell().storeUint(1,8).storeStringTail('ipfs://TEST_COLLECTION').endCell()).storeRef(beginCell().storeStringTail(root).endCell()).endCell();
const pre=makeContent('ipfs://TEST_PRE/'), final=makeContent('ipfs://TEST_FINAL/'), wrong=makeContent('ipfs://WRONG_FINAL/');
const commitment=BigInt('0x'+final.hash().toString('hex'));
const royalty=addr=>beginCell().storeUint(7,16).storeUint(100,16).storeAddress(addr).endCell();
function data(owner,treasury,next=0){return beginCell().storeAddress(owner).storeUint(next,64).storeRef(pre).storeRef(itemCode).storeRef(royalty(treasury)).storeAddress(treasury).storeBit(true).storeBit(false).storeUint(commitment,256).endCell();}
class Collection{
  constructor(owner,treasury,next=0){this.init={code,data:data(owner,treasury,next)};this.address=contractAddress(0,this.init);}
  async send(provider,via,body,value='0.1'){return provider.internal(via,{body,value:typeof value==='bigint'?value:toNano(value),sendMode:1});}
  async getMint(provider){let s=(await provider.get('get_mint_state',[])).stack;return{next:s.readBigNumber(),supply:s.readBigNumber(),price:s.readBigNumber(),paused:s.readBigNumber()};}
  async getReveal(provider){let s=(await provider.get('get_reveal_state',[])).stack;return{at:s.readBigNumber(),revealed:s.readBigNumber(),commitment:s.readBigNumber()};}
  async getRoyalty(provider){let s=(await provider.get('royalty_params',[])).stack;return [s.readBigNumber(),s.readBigNumber(),s.readAddress().toRawString()];}
  async getItem(provider,index){return(await provider.get('get_nft_address_by_index',[{type:'int',value:BigInt(index)}])).stack.readAddress();}
  async getContent(provider,index){const individual=beginCell().storeStringTail(String(index).padStart(4,'0')+'.json').endCell();let s=(await provider.get('get_nft_content',[{type:'int',value:BigInt(index)},{type:'cell',cell:individual}])).stack.readCell().beginParse();assert.equal(s.loadUint(8),1);const prefix=s.loadBuffer(s.remainingBits/8).toString();return prefix+s.loadRef().beginParse().loadStringTail();}
}
const command=(op,count,ref)=>{let b=beginCell().storeUint(op,32).storeUint(1,64);if(count!==undefined)b=b.storeUint(count,8);if(ref)b=b.storeRef(ref);return b.endCell();};
const revealBody=(ref=final)=>beginCell().storeUint(OP.reveal,32).storeRef(ref).endCell();
function parentTx(r,c){const t=r.transactions.find(t=>t.inMessage?.info.type==='internal'&&t.inMessage.info.dest.equals(c.address));assert.ok(t,'Missing collection transaction');return t;}
function success(r,c){const t=parentTx(r,c),d=t.description;assert.equal(d.type,'generic');assert.equal(d.computePhase.type,'vm');assert.equal(d.computePhase.exitCode,0);assert.equal(d.aborted,false);if(d.actionPhase)assert.equal(d.actionPhase.success,true);return t;}
function rejected(r,c,exit){const t=parentTx(r,c),d=t.description;assert.equal(d.type,'generic');assert.equal(d.computePhase.exitCode,exit);assert.equal(d.aborted,true);}
const checks=[];const pass=s=>{checks.push(s);console.log('PASS',s);};
const bc=await Blockchain.create();bc.now=AT-86400;
const owner=await bc.treasury('candidate-owner'),treasury=await bc.treasury('candidate-treasury'),buyer=await bc.treasury('candidate-buyer'),attacker=await bc.treasury('candidate-attacker');
const c=bc.openContract(new Collection(owner.address,treasury.address));
success(await c.send(owner.getSender(),beginCell().endCell(),'0.3'),c);
assert.deepEqual(await c.getMint(),{next:0n,supply:10000n,price:7000000000n,paused:1n});
assert.deepEqual(await c.getReveal(),{at:BigInt(AT),revealed:0n,commitment});pass('Deployment: paused, exact supply/price/date/commitment');
rejected(await c.send(attacker.getSender(),command(OP.claim), '7.10'),c,706);
rejected(await c.send(owner.getSender(),command(OP.claim), '7.10'),c,706);
rejected(await c.send(owner.getSender(),command(OP.open)),c,705);pass('Creator reservation and unpause gate enforced on chain');
rejected(await c.send(treasury.getSender(),command(OP.claim),'7.099999999'),c,703);
success(await c.send(treasury.getSender(),command(OP.claim),'7.10'),c);
rejected(await c.send(treasury.getSender(),command(OP.claim),'7.10'),c,707);
assert.equal((await c.getMint()).next,1n);pass('Exact creator claim, underpayment and repeated claim');
async function verifyItem(coll,index,expectedOwner){const a=await coll.getItem(index);const s=(await bc.runGetMethod(a,'get_nft_data',[])).stackReader;assert.equal(s.readBigNumber(),-1n);assert.equal(s.readBigNumber(),BigInt(index));assert.ok(s.readAddress().equals(coll.address));assert.ok(s.readAddress().equals(expectedOwner));assert.equal(s.readCell().beginParse().loadStringTail(),String(index).padStart(4,'0')+'.json');return a;}
const nft0=await verifyItem(c,0,treasury.address);assert.equal(await c.getContent(0),'ipfs://TEST_PRE/0000.json');pass('NFT0 is initialized with correct owner, address and hidden metadata');
rejected(await c.send(buyer.getSender(),command(OP.mint,1),'7.10'),c,700);
rejected(await c.send(attacker.getSender(),command(OP.open)),c,401);
success(await c.send(owner.getSender(),command(OP.open)),c);assert.equal((await c.getMint()).paused,0n);pass('Pause and owner permissions');
for(const count of [0,51])rejected(await c.send(buyer.getSender(),command(OP.mint,count),'400'),c,701);
rejected(await c.send(buyer.getSender(),command(OP.mint,1),'7.099999999'),c,703);
let invalid=beginCell().storeUint(OP.mint,32).storeUint(1,64).storeUint(1,8).storeBit(1).endCell();
assert.notEqual(parentTx(await c.send(buyer.getSender(),invalid,'7.10'),c).description.computePhase.exitCode,0);pass('Zero/51, one-nanoton underpayment and trailing payload rejected');
for(const count of [1,2,10,49,50]){
  const start=Number((await c.getMint()).next),before=(await bc.getContract(c.address)).balance;
  const r=await c.send(buyer.getSender(),command(OP.mint,count),BigInt(count)*7100000000n);success(r,c);
  assert.equal((await c.getMint()).next,BigInt(start+count));
  for(let i=start;i<start+count;i++)await verifyItem(c,i,buyer.address);
  const refunds=r.transactions.filter(t=>t.inMessage?.info.type==='internal'&&t.inMessage.info.src.equals(c.address)&&t.inMessage.info.dest.equals(buyer.address));
  assert.ok(refunds.some(t=>t.inMessage.info.value.coins>0n),'Missing remainder refund');
  const paid=r.transactions.filter(t=>t.inMessage?.info.type==='internal'&&t.inMessage.info.src.equals(c.address)&&t.inMessage.info.dest.equals(treasury.address));
  assert.ok(paid.some(t=>t.inMessage.info.value.coins===BigInt(count)*7000000000n),'Wrong treasury price');
  assert.equal((await bc.getContract(c.address)).balance,before,'Mint consumed or accumulated prior contract funds');
  pass(`Batch ${count}: all NFT recipients, exact price, refund, parent actions, balance`);
}
const edge=bc.openContract(new Collection(owner.address,treasury.address,9950));await edge.send(owner.getSender(),beginCell().endCell(),'0.3');success(await edge.send(owner.getSender(),command(OP.open)),edge);
success(await edge.send(buyer.getSender(),command(OP.mint,50),'355'),edge);
for(let i=9950;i<10000;i++)await verifyItem(edge,i,buyer.address);
rejected(await edge.send(buyer.getSender(),command(OP.mint,1),'7.10'),edge,702);pass('Last 50 NFTs all initialized, no token 10000');
const fixedRoyalty=await c.getRoyalty();assert.deepEqual(fixedRoyalty,[7n,100n,treasury.address.toRawString()]);
rejected(await c.send(owner.getSender(),command(4,undefined,wrong)),c,65535);pass('Legacy arbitrary metadata/royalty edit disabled');
async function rejectExternal(target,body){const before=(await bc.getContract(target.address)).balance;let refused=false;try{const r=await bc.sendMessage(external({to:target.address,body}));refused=!r.transactions.some(t=>t.description.type==='generic'&&!t.description.aborted);}catch{refused=true;}assert.ok(refused,'Invalid external message accepted');assert.equal((await bc.getContract(target.address)).balance,before,'Unaccepted external message spent contract funds');}
bc.now=AT-1;await rejectExternal(c,revealBody());assert.equal((await c.getReveal()).revealed,0n);pass('External reveal one second early rejected without spending balance');
bc.now=AT;await rejectExternal(c,revealBody(wrong));pass('Wrong reveal preimage rejected without spending balance');
await rejectExternal(c,beginCell().storeUint(OP.reveal,32).storeBit(1).storeRef(final).endCell());pass('Malformed external reveal rejected without spending balance');
const er=await bc.sendMessage(external({to:c.address,body:revealBody()}));assert.ok(er.transactions.some(t=>t.description.type==='generic'&&!t.description.aborted));
assert.equal((await c.getReveal()).revealed,1n);assert.equal(await c.getContent(0),'ipfs://TEST_FINAL/0000.json');assert.deepEqual(await c.getRoyalty(),fixedRoyalty);assert.ok((await c.getItem(0)).equals(nft0));await verifyItem(c,0,treasury.address);pass('Unsigned external reveal succeeds at deadline, same NFT and fixed royalty');
for(let i=0;i<3;i++)await rejectExternal(c,revealBody());pass('Repeated external reveal rejected with zero additional balance debit');
rejected(await c.send(owner.getSender(),command(OP.reveal,undefined,final)),c,708);pass('Owner cannot replace revealed content');
success(await edge.send(attacker.getSender(),command(OP.reveal,undefined,final)),edge);assert.equal(await edge.getContent(9999),'ipfs://TEST_FINAL/9999.json');pass('Permissionless paid reveal fallback uses same commitment');
rejected(await c.send(attacker.getSender(),command(OP.sweep)),c,706);
await c.send(buyer.getSender(),beginCell().endCell(),'1');success(await c.send(treasury.getSender(),command(OP.sweep)),c);assert.equal((await bc.getContract(c.address)).balance,toNano('0.2'));pass('Surplus withdrawal only to immutable treasury, operating reserve preserved');
const transferred=beginCell().storeUint(0x5fcc3d14,32).storeUint(0,64).storeAddress(buyer.address).storeAddress(treasury.address).storeBit(0).storeCoins(0).storeBit(0).endCell();
await treasury.send({to:nft0,value:toNano('0.1'),body:transferred,sendMode:1});await verifyItem(c,0,buyer.address);pass('Official NFT transfer remains functional after reveal');
fs.mkdirSync('build/candidate',{recursive:true});
fs.writeFileSync('build/candidate/collection.code.boc',code.toBoc());
const report={status:'OFFLINE_TESTED_NOT_DEPLOYED',checkedAt:new Date().toISOString(),baseCodeHash:original.collectionCodeHash,candidateCodeHash:code.hash().toString('hex'),itemCodeHash:itemCode.hash().toString('hex'),revealAt:AT,checks:checks.length,results:checks,liveTransactionsSent:0,productionPackageChanged:false};
fs.writeFileSync('build/candidate/test-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
