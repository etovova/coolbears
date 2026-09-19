import { MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';
import { getCreateCandyGuardInstructionDataSerializer } from '@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/instructions/createCandyGuard.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNoopSigner, publicKey, signerIdentity, generateSigner, some, sol } from '@metaplex-foundation/umi';
import { MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID, MPL_CORE_CANDY_GUARD_PROGRAM_ID, getCandyGuardDataSerializer, getInitializeCandyMachineInstructionDataSerializer, getAddConfigLinesInstructionDataSerializer } from '@metaplex-foundation/mpl-core-candy-machine';
import { devnetUmi, configLineSettings, SITE } from '../solana/builders.mjs';
import { LAUNCH_OWNER, launchPlan, launchMachineBuilder, launchItemsBuilder, paidGuards, inspectReservedLaunch, orderPrice } from '../solana/launch-plan.mjs';
function fixture() {
 const umi=devnetUmi().use(signerIdentity(createNoopSigner(publicKey(LAUNCH_OWNER)))); umi.rpc.getRent=async()=>sol(1);
 const plan=launchPlan({treasury:LAUNCH_OWNER,royaltyRecipient:LAUNCH_OWNER});
 const collectionKey=generateSigner(umi).publicKey, machineKey=generateSigner(umi).publicKey, guardKey=generateSigner(umi).publicKey;
 const collection={header:{owner:MPL_CORE_PROGRAM_ID},publicKey:collectionKey,updateAuthority:LAUNCH_OWNER,name:'CoolBears',uri:`${SITE}/metadata/collection.json`,royalties:{basisPoints:700,creators:[{address:LAUNCH_OWNER,percentage:100}]},currentSize:1,numMinted:1};
 const machine={header:{owner:MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID},publicKey:machineKey,authority:LAUNCH_OWNER,collectionMint:collectionKey,mintAuthority:guardKey,data:{itemsAvailable:10000n,isMutable:true,configLineSettings:some(configLineSettings)},itemsLoaded:10000,itemsRedeemed:1n,items:Array.from({length:10000},(_,i)=>({index:i,minted:i===0,name:`CoolBears #${String(i).padStart(4,'0')} — Hidden Bear`,uri:`${SITE}/metadata/hidden/${String(i).padStart(4,'0')}.json`}))};
 const guard={header:{owner:MPL_CORE_CANDY_GUARD_PROGRAM_ID},publicKey:guardKey,authority:LAUNCH_OWNER,groups:[],guards:{addressGate:some({address:publicKey(LAUNCH_OWNER)}),redeemedAmount:some({maximum:1n})}};
 const asset={header:{owner:MPL_CORE_PROGRAM_ID},owner:LAUNCH_OWNER,name:'CoolBears #0000 — Hidden Bear',uri:`${SITE}/metadata/hidden/0000.json`,updateAuthority:{type:'Collection',address:collectionKey}};
 return {umi,plan,collection,machine,guard,asset};
}
test('Launch machine serializes 10000 items, sequential numbering and owner-only first mint',async()=>{
 const f=fixture(), b=await launchMachineBuilder(f.umi,f.plan,generateSigner(f.umi),f.collection.publicKey);
 const ix=b.getInstructions(); const [data]=getInitializeCandyMachineInstructionDataSerializer().deserialize(ix[1].data);
 assert.equal(data.itemsAvailable,10000n);assert.equal(data.configLineSettings.value.isSequential,true);
 const [raw]=getCreateCandyGuardInstructionDataSerializer().deserialize(ix[2].data);
 const [decoded]=getCandyGuardDataSerializer(f.umi,f.umi.programs.get('mplCoreCandyGuard')).deserialize(raw.data);
 assert.equal(decoded.guards.addressGate.value.address,LAUNCH_OWNER);assert.equal(decoded.guards.redeemedAmount.value.maximum,1n);assert.equal(decoded.groups.length,0);
 assert.equal(decoded.guards.solPayment.__option,'None');assert.ok(b.fitsInOneTransaction(f.umi));
});
test('Public paid guards serialize exact 500000000 lamports and destination with no wallet mint limit',()=>{
 const f=fixture(), codec=getCandyGuardDataSerializer(f.umi,f.umi.programs.get('mplCoreCandyGuard'));
 const [data]=codec.deserialize(codec.serialize({guards:paidGuards(f.plan),groups:[]}));
 assert.equal(data.guards.solPayment.value.lamports.basisPoints,500000000n);assert.equal(data.guards.solPayment.value.destination,LAUNCH_OWNER);
 assert.equal(data.guards.addressGate.__option,'None');assert.equal(data.guards.mintLimit.__option,'None');assert.equal(data.guards.redeemedAmount.__option,'None');
 assert.equal(orderPrice(50),25000000000n);for(const n of [0,51,1.1])assert.throws(()=>orderPrice(n));
 assert.throws(()=>launchPlan({treasury:LAUNCH_OWNER}));
});
test('Public opening refuses missing owner reserve, unfilled/wrong items, extra guards and wrong royalties',()=>{
 const f=fixture();assert.equal(inspectReservedLaunch(f.plan,f),true);
 for(const redeemed of [0n,2n])assert.throws(()=>inspectReservedLaunch(f.plan,{...f,machine:{...f.machine,itemsRedeemed:redeemed}}));
 assert.throws(()=>inspectReservedLaunch(f.plan,{...f,asset:{...f.asset,owner:f.collection.publicKey}}));
 assert.throws(()=>inspectReservedLaunch(f.plan,{...f,guard:{...f.guard,groups:[{}]}}));
 assert.throws(()=>inspectReservedLaunch(f.plan,{...f,collection:{...f.collection,royalties:{basisPoints:0}}}));
 f.machine.items[9999].uri='https://example.com/wrong';assert.throws(()=>inspectReservedLaunch(f.plan,f));
});
test('All 10000 hidden config lines fit transaction batches without skips or duplicate indices',()=>{
 const f=fixture();let total=0;
 for(let start=0;start<10000;start+=25){const count=Math.min(25,10000-start);const b=launchItemsBuilder(f.umi,f.plan,f.machine.publicKey,start,count);
 const [d]=getAddConfigLinesInstructionDataSerializer().deserialize(b.getInstructions()[0].data);assert.equal(d.index,total);
 for(const item of d.configLines){assert.equal(item.name,`${String(total).padStart(4,'0')} — Hidden Bear`);assert.equal(item.uri,`${String(total).padStart(4,'0')}.json`);total++;}
 assert.ok(b.fitsInOneTransaction(f.umi));}assert.equal(total,10000);
});
