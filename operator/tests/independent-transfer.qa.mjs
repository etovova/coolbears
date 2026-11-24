// Public finalized data are downloaded read-only. Ephemeral keys and signatures are used only in memory.
import assert from 'node:assert/strict';
import {TransactionMessage} from '@solana/web3.js';
import {transferV1,mplCore} from '@metaplex-foundation/mpl-core';
import {createUmi} from '@metaplex-foundation/umi-bundle-defaults';
import {publicKey,createNoopSigner,signerIdentity} from '@metaplex-foundation/umi';
import {toWeb3JsInstruction} from '@metaplex-foundation/umi-web3js-adapters';
import {createHash} from 'node:crypto';
import {Keypair, PublicKey, VersionedTransaction} from '@solana/web3.js';
import {LiteSVM,Rent,Clock,FailedTransactionMetadata} from 'litesvm';
import {ed25519} from '@noble/curves/ed25519';
import {getAssetV1AccountDataSerializer} from '../node_modules/@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData.js';
import {getCandyMachineAccountDataSerializer} from '../node_modules/@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/types/candyMachineAccountData.js';
import cfg from '../../public-mainnet/deployment.mjs';
import {policy} from '../../scripts/hidden-metadata.mjs';
import {ISOLATED_PROGRAMS} from '../deployment/isolated-snapshot.mjs';
import {createOrderModel} from '../orders/journal-model.mjs';
import {createOrderPlanner} from '../orders/transaction-model.mjs';
import {resolveHiddenIndexedMetadata} from '../storage-mode.mjs';
import {createPublicReleaseProfile} from '../public-sale/profile.mjs';
import {createPublicSaleAccountVerifier} from '../public-sale/accounts.mjs';
const urls=['https://solana-rpc.publicnode.com','https://api.mainnet-beta.solana.com'], net=globalThis.fetch;
const opts={encoding:'base64',commitment:'finalized'};let requests=0;
async function read(method,params){
  assert.ok(['getGenesisHash','getMultipleAccounts','getAccountInfo'].includes(method));let why='';
  for(let i=0;i<4;i++){try{const res=await net(urls[i%urls.length],{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++requests,method,params}),signal:AbortSignal.timeout(15000)});assert.equal(res.status,200);const v=await res.json();assert.ok(!v.error,JSON.stringify(v.error));return v.result;}catch(e){why=e.message;await new Promise(r=>setTimeout(r,800));}}
  throw Error('Could not capture finalized '+method+': '+why);
}
assert.equal(await read('getGenesisHash',[]),cfg.genesisHash);
const sha=b=>createHash('sha256').update(b).digest('hex'),bytes=a=>Buffer.from(a.data[0],'base64');
const SYS='11111111111111111111111111111111',LOADER='BPFLoaderUpgradeab1e11111111111111111111111',RENT='SysvarRent111111111111111111111111111111111',CLOCK='SysvarC1ock11111111111111111111111111111111';
const headers=await read('getMultipleAccounts',[ISOLATED_PROGRAMS,opts]);const svm=new LiteSVM().withSigverify(true);
for(const [i,head] of headers.value.entries()){
  assert.equal(head.owner,LOADER);assert.equal(head.executable,true);const h=bytes(head);assert.equal(h.readUInt32LE(0),2);const key=new PublicKey(h.subarray(4)).toBase58();
  const record=await read('getAccountInfo',[key,{...opts,minContextSlot:headers.context.slot}]);assert.equal(record.value.owner,LOADER);assert.equal(record.value.executable,false);const d=bytes(record.value);assert.equal(d.readUInt32LE(0),3);const elf=d.subarray(45);assert.equal(elf.readUInt32BE(0),0x7f454c46);svm.addProgram(ISOLATED_PROGRAMS[i],elf);console.log('Finalized program',ISOLATED_PROGRAMS[i],sha(elf));
}
const buyer=Keypair.generate(),assets=Array.from({length:2},()=>Keypair.generate()),asset=assets[0];const address=k=>k.publicKey.toBase58();assert.notEqual(address(buyer),policy.owner);
const model=createOrderModel(policy,{storageMode:cfg.storageMode,hiddenCommitmentSha256:cfg.hiddenCommitmentSha256}), planner=createOrderPlanner(model);
const order=model.createOrder({id:'ordinary-buyer-replica',cluster:'mainnet-beta',buyer:address(buyer),machine:cfg.machine,collection:cfg.collection,guard:cfg.guard,quantity:assets.length,available:9999,assets:assets.map(address)});
const t=planner.buildOrderItemTemplate(order,0,{blockhash:svm.latestBlockhash(),lastValidBlockHeight:150});const tx=VersionedTransaction.deserialize(t.unsignedBytes);
const keys=tx.message.staticAccountKeys.map(k=>k.toBase58());assert.ok(keys.includes(policy.owner));assert.deepEqual(new Set(keys.slice(0,tx.signatures.length)),new Set([address(buyer),address(asset)]));
const list=[...new Set([...keys.filter(k=>!ISOLATED_PROGRAMS.includes(k)&&k!==SYS&&!k.startsWith('Sysvar')&&!k.startsWith('ComputeBudget')),...assets.map(address),RENT,CLOCK])];
const snapshot=await read('getMultipleAccounts',[list,{...opts,minContextSlot:headers.context.slot}]);const acc=Object.fromEntries(list.map((k,i)=>[k,snapshot.value[i]]));
globalThis.fetch=()=>{throw Error('No network after fixture capture');};assert.equal(acc[address(buyer)],null);assert.equal(acc[address(asset)],null);
const v=createPublicSaleAccountVerifier(policy,createPublicReleaseProfile(cfg));assert.equal(v.inspectPublicSaleAccounts([acc[cfg.machine],acc[cfg.guard],acc[cfg.collection]]).salesOpen,true);
const rent=bytes(acc[RENT]), clk=bytes(acc[CLOCK]);svm.setRent(new Rent(rent.readBigUInt64LE(0),rent.readDoubleLE(8),rent[16]));svm.setClock(new Clock(clk.readBigUInt64LE(0),clk.readBigInt64LE(8),clk.readBigUInt64LE(16),clk.readBigUInt64LE(24),clk.readBigInt64LE(32)));
for(const [key,a] of Object.entries(acc)){if(!a||[RENT,CLOCK].includes(key))continue;assert.equal(a.executable,false);assert.ok(Number.isSafeInteger(a.lamports));svm.setAccount({address:key,programAddress:a.owner,lamports:BigInt(a.lamports),data:bytes(a),executable:false});}
svm.setAccount({address:address(buyer),programAddress:SYS,lamports:20000000000n,data:new Uint8Array(),executable:false});
const machine=()=>getCandyMachineAccountDataSerializer().deserialize(svm.getAccount(cfg.machine).data)[0].itemsRedeemed;
const before=machine(), treasury=svm.getBalance(policy.owner),balance=svm.getBalance(address(buyer));let rentTotal=0n;
for(const [idx,asset] of assets.entries()){
  assert.equal(acc[address(asset)],null);const tpl=planner.buildOrderItemTemplate(order,idx,{blockhash:svm.latestBlockhash(),lastValidBlockHeight:150});
  const tx=VersionedTransaction.deserialize(tpl.unsignedBytes);tx.sign([asset,buyer]);
  const msg=tx.message.serialize(),signatures={};for(const [i,s] of tx.signatures.entries()){assert.ok(ed25519.verify(s,msg,tx.message.staticAccountKeys[i].toBytes()));signatures[tx.message.staticAccountKeys[i].toBase58()]=s;}
  assert.deepEqual(new Set(Object.keys(signatures)),new Set([address(buyer),address(asset)]));
  const result=svm.sendTransaction({messageBytes:msg,signatures});assert.ok(!(result instanceof FailedTransactionMetadata),result instanceof FailedTransactionMetadata?result.toString():'');
  const minted=svm.getAccount(address(asset));assert.equal(minted.exists,true);const [data]=getAssetV1AccountDataSerializer().deserialize(minted.data);
  assert.equal(data.owner,address(buyer));assert.equal(data.updateAuthority.fields[0],cfg.collection);assert.equal(data.uri,resolveHiddenIndexedMetadata(policy,Number(before)+idx+1).uri);rentTotal+=minted.lamports;
  const received=BigInt(idx+1);assert.equal(machine(),before+received);assert.equal(svm.getBalance(policy.owner)-treasury,200000000n*received);
  assert.equal(balance-svm.getBalance(address(buyer)),200000000n*received+rentTotal+10000n*received);
  if([1,2,50].includes(idx+1))console.log('PASS',JSON.stringify({count:idx+1,ownersAndUrisVerified:idx+1,treasuryLamports:String(200000000n*received),snapshotSlot:snapshot.context.slot,realTransactionsSent:0}));
}

assert.equal(order.quantity,2);
const holder=Keypair.generate(),uiBuyer=createNoopSigner(publicKey(address(buyer)));
const umi=createUmi('http://127.0.0.1:1',{fetch:globalThis.fetch}).use(mplCore()).use(signerIdentity(uiBuyer));
const mkTransfer=()=>new VersionedTransaction(new TransactionMessage({payerKey:buyer.publicKey,recentBlockhash:svm.latestBlockhash(),
 instructions:transferV1(umi,{payer:uiBuyer,authority:uiBuyer,asset:publicKey(address(assets[0])),collection:publicKey(cfg.collection),newOwner:publicKey(address(holder))}).getInstructions().map(toWeb3JsInstruction)
}).compileToV0Message());
const move=mkTransfer();move.sign([buyer]);assert.equal(move.signatures.length,1);
const bm=move.message.serialize();assert.ok(ed25519.verify(move.signatures[0],bm,buyer.publicKey.toBytes()));
const localTx={messageBytes:bm,signatures:{[address(buyer)]:move.signatures[0]}};
const moved=svm.sendTransaction(localTx);assert.ok(!(moved instanceof FailedTransactionMetadata),moved.toString());
const readAsset=k=>getAssetV1AccountDataSerializer().deserialize(svm.getAccount(address(k)).data)[0];
assert.equal(readAsset(assets[0]).owner,address(holder));assert.equal(readAsset(assets[1]).owner,address(buyer));
assert.equal(readAsset(assets[0]).updateAuthority.fields[0],cfg.collection);
assert.equal(readAsset(assets[0]).uri,resolveHiddenIndexedMetadata(policy,Number(before)+1).uri);
assert.equal(machine(),before+2n);assert.equal(svm.getBalance(policy.owner)-treasury,400000000n);
const q=svm.getBalance(address(buyer));const repeat=svm.sendTransaction(localTx);assert.ok(repeat instanceof FailedTransactionMetadata);
assert.equal(svm.getBalance(address(buyer)),q);assert.equal(readAsset(assets[0]).owner,address(holder));
console.log('PASS: independent order for exactly two; post-mint holder transfer, collection and URI unchanged, replay rejected with no second debit. Finalized snapshot '+snapshot.context.slot+'; no public transactions.');
