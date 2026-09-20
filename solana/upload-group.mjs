import { isRateLimit } from './rpc-pacing.mjs';
import { publicKey } from '@metaplex-foundation/umi';
import { GENESIS, loadedItems, nextBatch, validatePending } from './upload.mjs';
import { LAUNCH_OWNER, SUPPLY } from './launch-plan.mjs';

// Same journal and lock as the single-batch uploader. Signed bytes stay in
// memory; after a reload, unknown signatures must settle/expire before retry.
export function createGroupUploader(transport, store, target) {
  target=Object.freeze({...target});
  if (!GENESIS[target.cluster]) throw Error('Choose explicit supported cluster.');
  publicKey(target.machine); publicKey(target.collection);
  return {step:({size=10,sign=true,stopped=()=>false,onPhase=()=>{}}={})=>store.withLock(`coolbears-upload-v1:${target.cluster}:${target.machine}`,async()=>{
    if (!Number.isInteger(size)||size<1||size>10) throw Error('Invalid group size.');
    const key=`coolbears-upload-v1:${target.cluster}:${target.machine}`;
    let journal=await store.read(key)??{version:1,cluster:target.cluster,machine:target.machine,collection:target.collection,owner:LAUNCH_OWNER,pending:null,history:[]};
    const binding={version:1,cluster:target.cluster,machine:target.machine,collection:target.collection,owner:LAUNCH_OWNER};
    if (Object.entries(binding).some(([k,v])=>journal[k]!==v)||!Array.isArray(journal.history)) throw Error('Upload journal belongs to another launch.');
    if (journal.pendingGroup!==undefined && (!Array.isArray(journal.pendingGroup)||journal.pendingGroup.length>10)) throw Error('Invalid pending group.');
    if (journal.pending && journal.pendingGroup?.length) throw Error('Conflicting pending journals.');
    const pending=journal.pending?[journal.pending]:journal.pendingGroup??[];
    const indices=new Set(),signatures=new Set();
    for(const p of pending){
      validatePending(p);
      if(signatures.has(p.signature))throw Error('Duplicate pending signature.');
      signatures.add(p.signature);
      for(let i=p.start;i<p.start+p.count;i++){
        if(indices.has(i))throw Error('Overlapping pending batches.');
        indices.add(i);
      }
    }
    if(pending.length)await transport.assertNetwork(target.cluster);
    onPhase({status:'checking'});
    const snapshot=await transport.snapshot(pending);
    if(pending.length&&(!Number.isSafeInteger(snapshot.slot)||snapshot.slot<0||!Number.isSafeInteger(snapshot.height)||snapshot.height<0)) throw Error('Invalid finalized snapshot.');
    const loaded=loadedItems(snapshot.machine,target);
    if(pending.length){
      if(!Array.isArray(snapshot.signatureStatus)||snapshot.signatureStatus.length!==pending.length)throw Error('Invalid signature statuses.');
      const remaining=[],history=[...journal.history];
      let failed=false;
      pending.forEach((p,i)=>{
        const present=Array.from({length:p.count},(_,j)=>loaded.has(p.start+j));
        if(present.some(Boolean)&&!present.every(Boolean))throw Error('Partial pending batch: operator review required.');
        const status=snapshot.signatureStatus[i];
        let outcome;
        if(present.every(Boolean))outcome='account-verified';
        else if(status===null && snapshot.height>p.lastValidBlockHeight)outcome='expired';
        else if(status?.confirmationStatus==='finalized' && status.err!=null)outcome='failed';
        if(outcome){history.push({...p,outcome,slot:snapshot.slot});if(outcome!=='account-verified')failed=true;}
        else remaining.push(p);
      });
      journal={...journal,pending:null,pendingGroup:remaining,history,groupFailed:!!journal.groupFailed||failed};
      await store.write(key,journal);
      if(remaining.length)return {status:'pending',loaded:loaded.size,remaining:remaining.length};
      const retry=journal.groupFailed;
      journal={...journal,groupFailed:false};await store.write(key,journal);
      return {status:retry?'retry-available':loaded.size===SUPPLY?'complete':'verified',loaded:loaded.size};
    }
    if(loaded.size===SUPPLY)return {status:'complete',loaded:SUPPLY};
    if(!sign||stopped())return {status:'ready',loaded:loaded.size};
    const planned=new Set(loaded),batches=[];
    while(batches.length<size){const b=nextBatch(planned);if(!b)break;batches.push(b);for(let i=b.start;i<b.start+b.count;i++)planned.add(i);}
    onPhase({status:'signing',count:batches.length,records:planned.size-loaded.size,loaded:loaded.size});
    // The public upload page deliberately sends one batch per click. Use the
    // original single-transaction Umi signing path here because it is the
    // compatible Phantom mobile path; this still signs only the planned batch.
    const prepared=batches.length===1 && typeof transport.prepare==='function'
      ? [await transport.prepare(batches[0],target.cluster)]
      : await transport.prepareGroup(batches,target.cluster);
    if(!Array.isArray(prepared)||prepared.length!==batches.length)throw Error('Incomplete signed group.');
    const entries=prepared.map((p,i)=>({...batches[i],signature:p.signature,lastValidBlockHeight:p.lastValidBlockHeight}));
    entries.forEach(validatePending);
    if(new Set(entries.map(p=>p.signature)).size!==entries.length)throw Error('Duplicate signed transaction.');
    if(stopped())return {status:'stopped',loaded:loaded.size};
    // All signatures must be durable before even the first send.
    await store.write(key,{...journal,pending:null,pendingGroup:entries,groupFailed:false});
    for(let i=0;i<prepared.length;i++){
      if(stopped())break;
      onPhase({status:'sending',sent:i,total:prepared.length,loaded:loaded.size});
      // An RPC failure may mean the transaction was accepted. Keep the entire
      // journal and reconcile; never rebuild or resend an unknown transaction.
      try {await transport.broadcast(prepared[i],target.cluster);}
      catch(error) {if(isRateLimit(error))throw error;return {status:'pending',loaded:loaded.size,remaining:entries.length};}
    }
    return {status:'submitted',loaded:loaded.size,remaining:entries.length};
  })};
}
