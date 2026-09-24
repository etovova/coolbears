// Bounded trusted-RPC absence review when the buyer signature is genuinely unknown.
import {createHash} from 'node:crypto';
import {PublicKey,VersionedTransaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {base58} from '@metaplex-foundation/umi/serializers';
import {createDeploymentRpc,DeploymentRpcError,GENESIS_HASHES} from '../deployment/rpc.mjs';
import {validRecoverySignature} from '../deployment/request-policy.mjs';
import {validateBlockhashAnchor} from './blockhash-anchor.mjs';
import {validatePrewalletInput} from './prewallet-recovery.mjs';
import {prewalletExpiryReport} from './prewallet-expiry.mjs';
const need=(v,code)=>{if(!v)throw Object.assign(Error(code),{checkCode:code});};
const uint=n=>Number.isSafeInteger(n)&&n>=0,positive=n=>uint(n)&&n>0;
const address=v=>{try{return typeof v==='string'&&new PublicKey(v).toBase58()===v;}catch{return false;}};
const blockOptions={commitment:'finalized',transactionDetails:'none',rewards:false,maxSupportedTransactionVersion:0};
function header(v,slot){need(v&&positive(v.blockHeight)&&uint(v.parentSlot)&&v.parentSlot<slot&&address(v.blockhash),'EXPIRY_BLOCK_UNAVAILABLE');return v;}
function inspectHistoryTransaction(value,row,buyer,asset){
  need(value&&value.slot===row.slot&&[0,'legacy'].includes(value.version)&&value.meta
    &&JSON.stringify(value.meta.err)===JSON.stringify(row.err)&&Array.isArray(value.transaction)&&value.transaction.length===2
    &&value.transaction[1]==='base64'&&typeof value.transaction[0]==='string'&&value.transaction[0].length<=1644,'EXPIRY_HISTORY_TRANSACTION');
  const bytes=Buffer.from(value.transaction[0],'base64');need(bytes.length>0&&bytes.length<=1232&&bytes.toString('base64')===value.transaction[0],'EXPIRY_HISTORY_TRANSACTION');
  const tx=VersionedTransaction.deserialize(bytes),message=tx.message.serialize();
  need(Buffer.from(tx.serialize()).equals(bytes)&&tx.version===value.version
    &&tx.signatures.length===tx.message.header.numRequiredSignatures&&tx.signatures.length>0
    &&base58.deserialize(tx.signatures[0])[0]===row.signature,'EXPIRY_HISTORY_TRANSACTION');
  for(const [i,signature]of tx.signatures.entries())need(ed25519.verify(signature,message,tx.message.staticAccountKeys[i].toBytes()),'EXPIRY_HISTORY_SIGNATURE');
  const keys=tx.message.staticAccountKeys.map(k=>k.toBase58()),lookups=tx.message.addressTableLookups??[];
  const loaded=value.meta.loadedAddresses??{writable:[],readonly:[]};
  need(Array.isArray(loaded.writable)&&Array.isArray(loaded.readonly)
    &&loaded.writable.length===lookups.reduce((n,l)=>n+l.writableIndexes.length,0)
    &&loaded.readonly.length===lookups.reduce((n,l)=>n+l.readonlyIndexes.length,0)
    &&[...loaded.writable,...loaded.readonly].every(address),'EXPIRY_HISTORY_ACCOUNTS');
  keys.push(...loaded.writable,...loaded.readonly);
  need(keys.includes(buyer),'EXPIRY_HISTORY_ACCOUNTS');
  // Any use of this asset, even by another message or a failed transaction, is ambiguous.
  need(!keys.includes(asset),'EXPIRY_TRANSACTION_OBSERVED');
  return createHash('sha256').update(bytes).digest('hex');
}
export async function reviewPrewalletExpiry({input,blockhashAnchor,endpoint,fetchImpl,timeoutMs=12000}){
  const value=structuredClone(input);validatePrewalletInput(value);let rpc;
  try{
    const anchor=validateBlockhashAnchor(structuredClone(blockhashAnchor),value.claim);need(positive(anchor.sourceSlot),'EXPIRY_ANCHOR_REQUIRED');
    rpc=createDeploymentRpc({endpoint,fetchImpl,timeoutMs,totalTimeoutMs:30000,allowExpiryReads:true,maxResponseBytes:65536});
    const started=performance.now();
    const call=async(method,params=[])=>{need(performance.now()-started<25000&&rpc.requests<34,'EXPIRY_REVIEW_LIMIT');
      const result=await rpc.call(method,params);need(performance.now()-started<25000,'EXPIRY_REVIEW_LIMIT');return result;};
    need(await call('getGenesisHash')===GENESIS_HASHES.devnet,'EXPIRY_WRONG_CLUSTER');
    const first=header(await call('getBlock',[anchor.sourceSlot,blockOptions]),anchor.sourceSlot);
    need(first.blockhash===anchor.blockhash&&first.blockHeight<=anchor.lastValidBlockHeight,'EXPIRY_ANCHOR_MISMATCH');
    const valid=await call('isBlockhashValid',[anchor.blockhash,{commitment:'finalized',minContextSlot:anchor.sourceSlot}]);
    need(uint(valid?.context?.slot)&&valid.context.slot>=anchor.sourceSlot&&valid.value===false,'EXPIRY_NOT_FINALIZED');
    const slot=valid.context.slot,last=header(await call('getBlock',[slot,blockOptions]),slot);
    need(last.blockHeight>anchor.lastValidBlockHeight,'EXPIRY_NOT_FINALIZED');
    const archive=async()=>{const available=await call('getFirstAvailableBlock');need(uint(available)&&available<=anchor.sourceSlot,'EXPIRY_HISTORY_UNAVAILABLE');};
    const absent=async floor=>{
      const a=await call('getMultipleAccounts',[[value.claim.asset],{commitment:'finalized',encoding:'base64',minContextSlot:floor}]);
      need(uint(a?.context?.slot)&&a.context.slot>=floor&&Array.isArray(a.value)&&a.value.length===1&&a.value[0]===null,'EXPIRY_ASSET_OBSERVED');
      const h=await call('getSignaturesForAddress',[value.claim.asset,{commitment:'finalized',minContextSlot:a.context.slot,limit:1}]);
      need(Array.isArray(h)&&h.length===0,'EXPIRY_ASSET_HISTORY');return a.context.slot;
    };
    await archive();const floor=await absent(slot);
    let pages=0,transactions=0,before,previous=Infinity,boundary=false;
    const seen=new Set(),digest=createHash('sha256');
    while(pages<2&&!boundary){
      const rows=await call('getSignaturesForAddress',[value.order.buyer,{commitment:'finalized',minContextSlot:floor,limit:10,...(before?{before}:{})}]);pages++;
      need(Array.isArray(rows)&&rows.length>0&&rows.length<=10,'EXPIRY_HISTORY_INCOMPLETE');
      for(const row of rows){
        need(row&&validRecoverySignature(row.signature)&&!seen.has(row.signature)&&positive(row.slot)&&row.slot<=previous
          &&row.confirmationStatus==='finalized'&&Object.hasOwn(row,'err'),'EXPIRY_HISTORY_INVALID');
        const transaction=await call('getTransaction',[row.signature,{commitment:'finalized',encoding:'base64',maxSupportedTransactionVersion:0}]);
        const hash=inspectHistoryTransaction(transaction,row,value.order.buyer,value.claim.asset);transactions++;
        seen.add(row.signature);previous=row.slot;digest.update(`${row.signature}:${row.slot}:${hash}\n`);
        if(row.slot<anchor.sourceSlot)boundary=true;
      }
      before=rows.at(-1).signature;need(boundary||rows.length===10,'EXPIRY_HISTORY_INCOMPLETE');
    }
    need(boundary,'EXPIRY_HISTORY_LIMIT');await archive();const accountSlot=await absent(floor);
    const evidence={blockhash:anchor.blockhash,anchorSlot:anchor.sourceSlot,slot,blockHeight:last.blockHeight,
      lastValidBlockHeight:anchor.lastValidBlockHeight,historyPages:pages,historyTransactions:transactions,historySha256:digest.digest('hex')};
    // statusSlot names the final account/history context, not a lookup of an invented signature.
    const proof={kind:'expired',cluster:'devnet',machine:value.order.machine,collection:value.order.collection,buyer:value.order.buyer,
      asset:value.claim.asset,blockhash:value.claim.blockhash,messageSha256:value.claim.messageSha256,commitment:'finalized',slot,
      signature:null,blockhashValid:false,blockHeight:last.blockHeight,signatureAbsent:true,statusSlot:accountSlot,
      accountAbsent:true,accountSlot,addressHistoryEmpty:true};
    return prewalletExpiryReport(value,{proof,evidence,networkRequests:rpc.requests});
  }catch(error){return prewalletExpiryReport(value,{networkRequests:rpc?.requests??0,
    code:error instanceof DeploymentRpcError?'RPC_'+error.code:error?.checkCode??'PREWALLET_EXPIRY_NOT_VERIFIED'});}
}
