// Canonical public guard transition. Offline SDK serialization only.
import {createUmi} from '@metaplex-foundation/umi-bundle-defaults';
import {createNoopSigner,publicKey,signerIdentity,some,lamports} from '@metaplex-foundation/umi';
import {base58} from '@metaplex-foundation/umi/serializers';
import {mplCandyMachine,findCandyGuardPda,getCandyGuardDataSerializer,updateCandyGuard} from '@metaplex-foundation/mpl-core-candy-machine';
import {getCandyGuardAccountDataSerializer} from '../node_modules/@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/accounts/candyGuard.js';
import {setComputeUnitLimit} from '@metaplex-foundation/mpl-toolbox';
import {VersionedTransaction} from '@solana/web3.js';
import {createHash} from 'node:crypto';
import {validatePublicReleaseProfile,publicReleaseProfileSha256} from './profile.mjs';
const need=v=>{if(!v)throw Object.assign(Error('Public guard transition is invalid.'),{code:'PUBLIC_GUARD_TRANSITION'});};
const forbidden=()=>{throw Error('PUBLIC_GUARD_OFFLINE_ONLY');};
function context(profile){
  const owner=Object.freeze({...createNoopSigner(publicKey(profile.owner)),signMessage:forbidden,signTransaction:forbidden,signAllTransactions:forbidden});
  const umi=createUmi('http://127.0.0.1:1',{fetch:forbidden}).use(mplCandyMachine()).use(signerIdentity(owner));
  const programs=umi.programs;
  umi.programs={...programs,get:id=>programs.get(id,'*'),getPublicKey:(id,fallback)=>programs.getPublicKey(id,fallback,'*'),has:id=>programs.has(id,'*'),all:()=>programs.all('*')};
  umi.rpc=new Proxy({},{get:()=>forbidden});umi.http=new Proxy({},{get:()=>forbidden});
  umi.eddsa=new Proxy(umi.eddsa,{get(target,key){return ['generateKeypair','createKeypairFromSecretKey','createKeypairFromSeed','sign'].includes(key)?forbidden:Reflect.get(target,key);}});
  return {umi,owner};
}
export function publicGuardAccountBytes(value,{closed=false}={}){
  const profile=validatePublicReleaseProfile(value);need(typeof closed==='boolean');
  const {umi}=context(profile),[guard,bump]=findCandyGuardPda(umi,{base:publicKey(profile.machine)});
  need(guard===profile.guard);
  const header=getCandyGuardAccountDataSerializer().serialize({base:publicKey(profile.machine),bump,authority:publicKey(profile.owner)});
  const guards={solPayment:some({lamports:lamports(BigInt(profile.unitPriceLamports)),destination:publicKey(profile.owner)}),...(closed?{addressGate:some({address:publicKey(profile.owner)})}:{})};
  const data=getCandyGuardDataSerializer(umi,umi.programs.get('mplCoreCandyGuard')).serialize({guards,groups:[]});
  return new Uint8Array(Buffer.concat([header,data]));
}
export function buildGuardOpenTemplate(value,{blockhash,lastValidBlockHeight}={}){
  const profile=validatePublicReleaseProfile(value);let valid=false;
  try{valid=typeof blockhash==='string'&&base58.serialize(blockhash).length===32;}catch{}
  need(valid&&Number.isSafeInteger(lastValidBlockHeight)&&lastValidBlockHeight>0);
  const {umi,owner}=context(profile);
  // Explicit compute limit, no priority fee or unrelated instruction.
  const builder=setComputeUnitLimit(umi,{units:200000}).add(updateCandyGuard(umi,{candyGuard:publicKey(profile.guard),authority:owner,payer:owner,
    guards:{solPayment:some({lamports:lamports(BigInt(profile.unitPriceLamports)),destination:publicKey(profile.owner)})},groups:[]}))
    .useV0().setFeePayer(owner).setBlockhash({blockhash,lastValidBlockHeight});
  const transaction=builder.build(umi),bytes=umi.transactions.serialize(transaction),tx=VersionedTransaction.deserialize(bytes);
  need(bytes.length<=1232&&tx.version===0&&tx.signatures.length===1&&tx.signatures[0].every(x=>x===0)
    &&tx.message.staticAccountKeys[0].toBase58()===profile.owner&&tx.message.addressTableLookups.length===0);
  const signers=[...new Set(builder.getSigners(umi).map(s=>s.publicKey))];need(signers.length===1&&signers[0]===profile.owner);
  return Object.freeze({version:1,stepId:'guard-open',profileSha256:publicReleaseProfileSha256(profile),
    transactionBase64:Buffer.from(bytes).toString('base64'),messageSha256:createHash('sha256').update(tx.message.serialize()).digest('hex'),
    requiredSigners:Object.freeze([profile.owner]),blockhash,lastValidBlockHeight,
    beforeGuardBytes:publicGuardAccountBytes(profile,{closed:true}).length,afterGuardBytes:publicGuardAccountBytes(profile).length});
}
export function guardOpenCostEstimate({feeLamports,currentGuardLamports,targetRentLamports}={}){
  const amount=v=>typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v)&&BigInt(v)<=BigInt(Number.MAX_SAFE_INTEGER);
  need([feeLamports,currentGuardLamports,targetRentLamports].every(amount)&&BigInt(feeLamports)>0n&&BigInt(targetRentLamports)>0n);
  // This exact transition shrinks157 to125 bytes. The program's shrink branch
  // refunds excess lamports and fails if current funding is below rent125;
  // it does not execute a funding transfer for an underfunded shrinking guard.
  need(BigInt(currentGuardLamports)>=BigInt(targetRentLamports));
  const allocation=BigInt(targetRentLamports)>BigInt(currentGuardLamports)?BigInt(targetRentLamports)-BigInt(currentGuardLamports):0n;
  need(BigInt(feeLamports)+allocation<=BigInt(Number.MAX_SAFE_INTEGER));
  return Object.freeze({feeLamports,positiveAllocationLamports:String(allocation),estimatedLamports:String(BigInt(feeLamports)+allocation),
    refundCreditedLamports:'0',completeActualDebit:false,chainEnforcedDebitCap:false});
}
