import { publicKey } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { fetchCandyMachine, MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core-candy-machine';
import { LAUNCH_OWNER, SUPPLY, launchItemsBuilder } from './launch-plan.mjs';
import { configLineSettings, SITE } from './builders.mjs';

export const GENESIS = Object.freeze({
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
});
export function loadedItems(machine, target) {
  if (machine.publicKey !== target.machine || machine.header?.owner !== MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID || machine.authority !== LAUNCH_OWNER || machine.collectionMint !== target.collection || machine.data.itemsAvailable !== BigInt(SUPPLY) || !machine.data.isMutable || machine.itemsRedeemed !== 0n) throw Error('Upload machine mismatch or mint already started.');
  const settings = machine.data.configLineSettings;
  if (settings?.__option !== 'Some' || Object.entries(configLineSettings).some(([k,v]) => settings.value[k] !== v)) throw Error('Unexpected config settings.');
  const loaded = new Set();
  for (const item of machine.items) {
    const i = item.index, id = String(i).padStart(4,'0');
    if (!Number.isInteger(i) || i < 0 || i >= SUPPLY || loaded.has(i) || item.minted || item.name !== `CoolBears #${id} — Hidden Bear` || item.uri !== `${SITE}/metadata/hidden/${id}.json`) throw Error('Loaded item differs from approved metadata.');
    loaded.add(i);
  }
  if (loaded.size !== machine.itemsLoaded) throw Error('Loaded count mismatch.');
  return loaded;
}
export function nextBatch(loaded) {
  let start = 0;
  while (loaded.has(start) && start < SUPPLY) start++;
  if (start === SUPPLY) return null;
  let count = 1;
  while (count < 25 && start + count < SUPPLY && !loaded.has(start + count)) count++;
  return {start,count};
}
export function validatePending(p) {
  if (!Number.isInteger(p.start) || !Number.isInteger(p.count) || p.start < 0 || p.count < 1 || p.count > 25 || p.start+p.count > SUPPLY || !Number.isSafeInteger(p.lastValidBlockHeight) || p.lastValidBlockHeight < 0 || typeof p.signature !== 'string' || base58.serialize(p.signature).length !== 64) throw Error('Invalid pending upload journal.');
}
// Store must implement durable read/write and a cross-tab/process exclusive
// withLock(key, fn). A single step sends at most one batch; never an automatic retry.
export function createUploader(transport, store, target) {
  target = Object.freeze({...target});
  if (!GENESIS[target.cluster]) throw Error('Choose explicit supported cluster.');
  publicKey(target.machine); publicKey(target.collection);
  if (![store.read,store.write,store.withLock].every(x=>typeof x==='function')) throw Error('Durable locked store required.');
  const key = `coolbears-upload-v1:${target.cluster}:${target.machine}`;
  const binding = {version:1,cluster:target.cluster,machine:target.machine,collection:target.collection,owner:LAUNCH_OWNER};
  return {step: () => store.withLock(key,async()=>{
    await transport.assertNetwork(target.cluster);
    const saved = await store.read(key);
    let journal = saved ?? {...binding,pending:null,history:[]};
    if (Object.entries(binding).some(([k,v])=>journal[k]!==v) || !Array.isArray(journal.history)) throw Error('Upload journal belongs to another launch.');
    if (journal.pendingGroup?.length) throw Error('Продолжи групповую загрузку для проверки сохранённых транзакций.');
    if (journal.pending) validatePending(journal.pending);
    const snapshot = await transport.snapshot(journal.pending);
    if (!Number.isSafeInteger(snapshot.slot) || snapshot.slot < 0 || !Number.isSafeInteger(snapshot.height) || snapshot.height < 0) throw Error('Invalid finalized snapshot.');
    const loaded = loadedItems(snapshot.machine,target);
    if (journal.pending) {
      const p = journal.pending;
      const present = Array.from({length:p.count},(_,i)=>loaded.has(p.start+i));
      if (present.every(Boolean)) {
        journal = {...journal,pending:null,history:[...journal.history,{...p,outcome:'account-verified',slot:snapshot.slot}]};
        await store.write(key,journal);
        return {status:'verified',loaded:loaded.size};
      }
      if (present.some(Boolean)) throw Error('Partial pending batch: operator review required.');
      const status = snapshot.signatureStatus;
      const safeToRetry = (status === null && snapshot.height > p.lastValidBlockHeight) || (status?.confirmationStatus === 'finalized' && status.err != null);
      if (!safeToRetry) return {status:'pending',loaded:loaded.size,signature:p.signature};
      journal = {...journal,pending:null,history:[...journal.history,{...p,outcome:status===null?'expired':'failed',slot:snapshot.slot}]};
      await store.write(key,journal);
      return {status:'retry-available',loaded:loaded.size};
    }
    const batch = nextBatch(loaded);
    if (!batch) return {status:'complete',loaded:SUPPLY};
    const prepared = await transport.prepare(batch,target.cluster);
    const pending = {...batch,signature:prepared.signature,lastValidBlockHeight:prepared.lastValidBlockHeight};
    validatePending(pending);
    // Await durable write. If it fails, broadcasting is forbidden.
    journal = {...journal,pending};
    await store.write(key,journal);
    await transport.broadcast(prepared,target.cluster);
    return {status:'submitted',loaded:loaded.size,signature:pending.signature};
  })};
}

export function umiUploadTransport(umi,plan,target) {
  const assertNetwork = async cluster => {
    if (!GENESIS[cluster] || await umi.rpc.call('getGenesisHash',[]) !== GENESIS[cluster]) throw Error('Сеть RPC не совпадает с выбранной сетью загрузки.');
    if (plan.owner !== LAUNCH_OWNER || umi.identity.publicKey !== LAUNCH_OWNER || umi.payer.publicKey !== LAUNCH_OWNER) throw Error('Upload wallet changed.');
  };
  return {
    assertNetwork,
    async snapshot(pending) {
      const group = Array.isArray(pending) ? pending : pending ? [pending] : [];
      const slot = await umi.rpc.call('getSlot',[{commitment:'finalized'}]);
      if (!Number.isSafeInteger(slot) || slot < 0) throw Error('Invalid finalized slot.');
      // Tie expiry height to this exact finalized slot, even behind a load
      // balancer. Status/account reads must be at least as recent as that slot.
      const block = await umi.rpc.call('getBlock',[slot,{commitment:'finalized',transactionDetails:'none',rewards:false,maxSupportedTransactionVersion:0}]);
      const height = block?.blockHeight;
      if (!Number.isSafeInteger(height) || height < 0) throw Error('Cannot establish finalized expiry height.');
      let signatureStatus;
      if (group.length) {
        const r = await umi.rpc.call('getSignatureStatuses',[group.map(p=>p.signature),{searchTransactionHistory:true}]);
        if (!Number.isSafeInteger(r?.context?.slot) || r.context.slot < slot || !Array.isArray(r.value) || r.value.length!==group.length) throw Error('Stale signature status.');
        signatureStatus=Array.isArray(pending)?r.value:r.value[0];
      }
      // Read after status so finalized success has a chance to be reflected.
      const machine=await fetchCandyMachine(umi,publicKey(target.machine),{commitment:'finalized',minContextSlot:slot});
      return {slot,height,machine,signatureStatus};
    },
    async prepare(batch,cluster) {
      await assertNetwork(cluster);
      const latest=await umi.rpc.call('getLatestBlockhash',[{commitment:'confirmed'}]);
      if (!Number.isSafeInteger(latest?.context?.slot) || !latest?.value?.blockhash || !Number.isSafeInteger(latest.value.lastValidBlockHeight)) throw Error('Invalid recent blockhash.');
      const tx=await launchItemsBuilder(umi,plan,target.machine,batch.start,batch.count).setBlockhash(latest.value).buildAndSign(umi);
      const sig=tx.signatures[0];
      if (!sig || sig.length!==64 || !sig.some(x=>x!==0)) throw Error('Missing wallet signature.');
      await assertNetwork(cluster);
      const height=await umi.rpc.call('getBlockHeight',[{commitment:'confirmed',minContextSlot:latest.context.slot}]);
      if (!Number.isSafeInteger(height) || height<0 || height>latest.value.lastValidBlockHeight) throw Error('Signature expired before upload.');
      return {tx,signature:base58.deserialize(sig)[0],lastValidBlockHeight:latest.value.lastValidBlockHeight,minContextSlot:latest.context.slot};
    },
    async prepareGroup(batches,cluster) {
      if (!Array.isArray(batches) || batches.length<1 || batches.length>10) throw Error('Invalid signing group.');
      await assertNetwork(cluster);
      const latest=await umi.rpc.call('getLatestBlockhash',[{commitment:'confirmed'}]);
      if (!Number.isSafeInteger(latest?.context?.slot) || !latest?.value?.blockhash || !Number.isSafeInteger(latest.value.lastValidBlockHeight)) throw Error('Invalid recent blockhash.');
      const unsigned=batches.map(b=>launchItemsBuilder(umi,plan,target.machine,b.start,b.count).setBlockhash(latest.value).build(umi));
      const messages=unsigned.map(tx=>Uint8Array.from(tx.serializedMessage));
      const signed=batches.length===1?[await umi.identity.signTransaction(unsigned[0])]:await umi.identity.signAllTransactions(unsigned);
      if (!Array.isArray(signed) || signed.length!==batches.length) throw Error('Кошелёк вернул неполную группу. Ничего не отправлено.');
      const result=signed.map((tx,i)=>{
        if (!tx.serializedMessage || tx.serializedMessage.length!==messages[i].length || !messages[i].every((b,j)=>b===tx.serializedMessage[j])) throw Error('Кошелёк изменил транзакцию. Отправка остановлена.');
        const sig=tx.signatures[0];
        if (!sig || sig.length!==64 || !sig.some(x=>x!==0)) throw Error('Missing wallet signature.');
        return {tx,signature:base58.deserialize(sig)[0],lastValidBlockHeight:latest.value.lastValidBlockHeight,minContextSlot:latest.context.slot};
      });
      await assertNetwork(cluster);
      const height=await umi.rpc.call('getBlockHeight',[{commitment:'confirmed',minContextSlot:latest.context.slot}]);
      if (!Number.isSafeInteger(height) || height<0 || height>latest.value.lastValidBlockHeight) throw Error('Срок подписи истёк до отправки. Прогресс сохранён. Нажми «Продолжить загрузку» для новой подписи.');
      return result;
    },
    async broadcast(prepared,cluster) {
      await assertNetwork(cluster);
      await umi.rpc.sendTransaction(prepared.tx,{preflightCommitment:'confirmed',minContextSlot:prepared.minContextSlot,skipPreflight:false,maxRetries:3});
    }
  };
}
