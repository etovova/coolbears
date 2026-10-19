// Disposable browser fixture. The trusted checks below are synthetic, never RPC.
import {createBuyerStorage} from '../../orders/browser-storage.mjs';
import {createOrderModel} from '../../orders/journal-model.mjs';
import {createOrderPlanner} from '../../orders/transaction-model.mjs';
import {createBuyerWalletClient} from '../../orders/wallet-client.mjs';
import {createBuyerSender} from '../../orders/sender.mjs';
import {buyerRequestId} from '../../orders/signing.mjs';
import {createCostQuote} from '../../orders/cost-approval.mjs';
import {submissionBinding,signedBytesId} from '../../orders/submission.mjs';
import {replacementFor,replacementReport} from '../../orders/replacement.mjs';
import {currentItemIndex} from '../../orders/sequential.mjs';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import policy from '../../../metadata/policy.json' with {type:'json'};
const model=createOrderModel(policy),planner=createOrderPlanner(model),native=globalThis.crypto;
const need=(value,message)=>{if(!value)throw Error(message);};
const hash=value=>bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))));
const scopeKey=s=>JSON.stringify(Object.fromEntries(['id','cluster','buyer','machine','collection','guard'].map(k=>[k,s[k]])));
async function raw(names,mode,action){
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('coolbears-buyer-custody-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try{return await new Promise((resolve,reject)=>{const tx=db.transaction(names,mode);let result;tx.oncomplete=()=>resolve(result?.result);tx.onabort=tx.onerror=()=>reject(tx.error);result=action(tx);});}finally{db.close();}
}
window.sequenceAudit={native:[],wallet:[],send:[],checks:[],recovery:[]};
const subtle=new Proxy(native.subtle,{get(target,property){
  if(property!=='sign')return typeof target[property]==='function'?target[property].bind(target):target[property];
  return async(...args)=>{
    if(new Uint8Array(args[2])[0]!==128)return target.sign(...args);
    const key=scopeKey(window.auditScope),order=await raw(['orders'],'readonly',tx=>tx.objectStore('orders').get(key));
    const rows=await raw(['signing'],'readonly',tx=>tx.objectStore('signing').getAll(IDBKeyRange.bound([key],[key,[]])));
    const last=rows.at(-1),claim=last?.record,index=claim?.itemIndex;
    need(last?.phase==='claimed'&&order.revision===claim.orderRevision&&order.items[index]?.attempts.at(-1)?.state==='wallet-pending'
      &&order.items.slice(0,index).every(item=>item.attempts.at(-1)?.state==='verified'),'SIGN_BEFORE_ITEM_CLAIM');
    const persisted=await raw(['keys'],'readonly',tx=>tx.objectStore('keys').get([key,index]));
    need(persisted?.asset===claim.asset&&persisted.privateKey.extractable===false,'WRONG_PERSISTED_ITEM_KEY');
    const signature=await target.sign(...args);
    need(await native.subtle.verify('Ed25519',persisted.publicKey,signature,args[2]),'WRONG_NATIVE_ITEM_SIGNATURE');
    sequenceAudit.native.push({id:order.id,itemIndex:index,attempt:claim.attempt,asset:claim.asset,revision:order.revision});return signature;
  };
}});
const store=createBuyerStorage({crypto:{subtle,getRandomValues:native.getRandomValues.bind(native)}});
function candidate(order,block,index=currentItemIndex(order)){
  return{orderRevision:order.revision,itemIndex:index,...block,
    transactionBase64:Buffer.from(planner.buildOrderItemTemplate(order,index,block).unsignedBytes).toString('base64')};
}
async function openSequenceClient(scope){
  window.auditScope=scope;
  const buyer=Keypair.fromSeed(new Uint8Array(32).fill(1));
  const account={address:buyer.publicKey.toBase58(),publicKey:buyer.publicKey.toBytes(),chains:['solana:devnet'],features:['solana:signTransaction']};
  const wallet={name:'Disposable sequential fixture',accounts:[account],chains:['solana:devnet'],features:{
    'standard:connect':{connect:async()=>({accounts:[account]})},'standard:events':{on:()=>()=>{}},
    'solana:signAndSendTransaction':{signAndSendTransaction:()=>{throw Error('SEND_FORBIDDEN');}},
    'solana:signTransaction':{supportedTransactionVersions:[0],signTransaction:async input=>{
      need(input.account===account&&input.chain==='solana:devnet','WRONG_WALLET_INPUT');
      const key=scopeKey(scope),order=await raw(['orders'],'readonly',tx=>tx.objectStore('orders').get(key));
      const rows=await raw(['signing'],'readonly',tx=>tx.objectStore('signing').getAll(IDBKeyRange.bound([key],[key,[]])));
      const claim=rows.findLast(row=>row.phase==='claimed')?.record,request=rows.at(-2)?.record,walletClaim=rows.at(-1)?.record,index=claim.itemIndex;
      need(rows.at(-1)?.phase==='wallet-claimed'&&rows.at(-2)?.phase==='ready'&&walletClaim.costApproval?.quote.requestId===buyerRequestId(request)
        &&walletClaim.costApproval.quote.version===(index>0?2:1)&&order.items[index].attempts.at(-1).state==='unknown'
        &&order.revision===walletClaim.orderRevision&&Buffer.from(input.transaction).toString('base64')===request.transactionBase64
        &&order.items.slice(0,index).every(item=>item.attempts.at(-1)?.state==='verified'),'WALLET_BEFORE_ITEM_COST_CLAIM');
      sequenceAudit.wallet.push({id:order.id,itemIndex:index,attempt:claim.attempt,quoteId:walletClaim.costApproval.quote.quoteId,claimId:walletClaim.claimId});
      const tx=VersionedTransaction.deserialize(input.transaction);tx.sign([buyer]);return[{signedTransaction:tx.serialize()}];
    }},
  }};
  const checkPrepared=async({order,claim,request})=>{
    const now=Date.now(),index=claim.itemIndex,total=203509999n;
    sequenceAudit.checks.push({id:order.id,itemIndex:index,requestId:buyerRequestId(request)});
    const report={status:'wallet-check-passed',mode:'closed-devnet-sign-only-check',cluster:'devnet',orderId:order.id,orderRevision:order.revision,
      orderSha256:hash(order),requestId:buyerRequestId(request),candidate:{...request},quantity:order.quantity,itemIndex:index,
      networkVerified:true,guardPriceVerified:true,blockhashVerified:true,blockhashProvenanceVerified:true,
      budget:{complete:true,scope:'next-item-current-template',projectionOnly:true,fullOrderTotalLamports:null,
        unitPriceLamports:order.unitPriceLamports,orderItemPriceLamports:order.totalPriceLamports,nextItemFeeLamports:'10000',nextItemBaseRentLamports:'1999999',
        protocolChargesLamports:'1500000',priorityFeeLamports:'0',nextItemKnownMinimumLamports:String(total),projectedOrderTotalLamports:String(total*BigInt(order.quantity)),
        balanceLamports:'20000000000',...(index>0?{completedQuantity:index,remainingQuantity:order.quantity-index,projectedRemainingTotalLamports:String(total*BigInt(order.quantity-index))}:{})},
      simulationVerified:true,simulationMode:'unsigned',checkedSlot:600+index,checkedAt:now,expiresAt:now+20000,readyToSign:true,readyToSubmit:false,salesOpen:false};
    report.costQuote=createCostQuote({order,claim,request},report);return report;
  };
  window.client=createBuyerWalletClient({storage:store,scope,checkPrepared,walletTimeoutMs:120000,storageManager:{persisted:async()=>true,persist:async()=>true}});
  await client.load();await client.connect(wallet);return client.state();
}
function result(input,status){
  return{...submissionBinding(input),cluster:'devnet',status,chainVerified:status==='verified',readyToSubmit:false,salesOpen:false,transactionsSent:0};
}
function proof(input,kind='verified'){
  const {order,claim}=input,index=claim.itemIndex,attempt=order.items[index].attempts.at(-1),slot=1000+index;
  return{kind,cluster:order.cluster,machine:order.machine,collection:order.collection,buyer:order.buyer,asset:claim.asset,blockhash:claim.blockhash,
    messageSha256:claim.messageSha256,commitment:'finalized',slot,signature:attempt.signature,accountSlot:slot,
    ...(kind==='verified'?{account:{program:'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',owner:order.buyer,collection:order.collection,
      name:policy.hiddenName.replace('{index:04d}',String(index+1).padStart(4,'0')),uri:policy.website+'/metadata/hidden/'+String(index+1).padStart(4,'0')+'.json'}}:
      {blockhashValid:false,blockHeight:claim.lastValidBlockHeight+1,signatureAbsent:true,statusSlot:slot,accountAbsent:true,addressHistoryEmpty:true})};
}
function openSequenceSender(scope){
  window.sender=createBuyerSender({scope,storage:store,storageManager:{persisted:async()=>true},transport:{
    send:async(input,costApproval)=>{
      const key=scopeKey(scope),order=await raw(['orders'],'readonly',tx=>tx.objectStore('orders').get(key));
      const rows=await raw(['signing'],'readonly',tx=>tx.objectStore('signing').getAll(IDBKeyRange.bound([key],[key,[]])));
      need(rows.at(-1)?.phase==='send-claimed'&&rows.at(-1).record.transactionSha256===signedBytesId(input.response.transactionBase64)
        &&JSON.stringify(order)===JSON.stringify(input.order)&&JSON.stringify(rows.findLast(row=>row.phase==='wallet-claimed')?.record.costApproval)===JSON.stringify(costApproval),'FIXTURE_SEND_BEFORE_CLAIM');
      sequenceAudit.send.push({id:input.order.id,itemIndex:input.claim.itemIndex,attempt:input.claim.attempt,signature:submissionBinding(input).signature});return result(input,'accepted');
    },
    recover:async input=>{sequenceAudit.recovery.push({id:input.order.id,itemIndex:input.claim.itemIndex});return window.sequenceUnknown?result(input,'unknown'):{...result(input,'verified'),proof:proof(input)};},
    reviewExpiry:async input=>({...result(input,'expired'),chainVerified:true,retryAuthorized:false,proof:proof(input,'expired'),
      evidence:{blockhash:input.claim.blockhash,anchorSlot:500,slot:1000+input.claim.itemIndex,blockHeight:input.claim.lastValidBlockHeight+1,
        lastValidBlockHeight:input.claim.lastValidBlockHeight,historyPages:1,historySha256:'a'.repeat(64)}}),
    replace:async input=>{const state=await store.readBuyerSubmission(scope);return replacementReport(input,replacementFor(input,state.expiryRecord,
      {blockhash:Keypair.fromSeed(new Uint8Array(32).fill(6)).publicKey.toBase58(),lastValidBlockHeight:3000},1200));},
  }});
}
Object.assign(window,{store,raw,scopeKey,candidate,model,openSequenceClient,openSequenceSender,
  code:async promise=>{try{await promise;return'UNEXPECTED_SUCCESS';}catch(e){return e.message;}},
  approveSequenceCost:async()=>{const quote=await client.quoteCost();window.sequenceConsent={authorizeCost:true,quoteId:quote.quoteId,maxTotalLamports:quote.budget.totalLamports};return quote;},
});
