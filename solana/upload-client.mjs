import { generateSigner, publicKey } from '@metaplex-foundation/umi';
import { safeFetchCollectionV1 } from '@metaplex-foundation/mpl-core';
import { safeFetchCandyMachine } from '@metaplex-foundation/mpl-core-candy-machine';
import { devnetUmi, SITE } from './builders.mjs';
import { launchPlan, LAUNCH_OWNER, launchCollectionBuilder, launchMachineBuilder } from './launch-plan.mjs';
import { createUploader, umiUploadTransport, loadedItems } from './upload.mjs';
import { createGroupUploader } from './upload-group.mjs';
import { sendTracked, canDiscardPending } from './transactions.mjs';
import { pacedRpcFetch } from './rpc-pacing.mjs';
const defaultPaced=pacedRpcFetch();
export { isRateLimit } from './rpc-pacing.mjs';
export { runUpload } from './upload-runner.mjs';
export { browserUploadStore } from './browser-upload-store.mjs';
export const SETUP_KEY='devnet-upload-setup-v1';
export function uploadClient(provider,store,{paced=defaultPaced}={}) {
 const umi=devnetUmi(provider,{fetch:paced.fetch,disableRetryOnRateLimit:true}),plan=launchPlan({treasury:LAUNCH_OWNER,royaltyRecipient:LAUNCH_OWNER});
 const target=s=>({cluster:'devnet',collection:s.collection,machine:s.machine});
 const transports=new Map();
 const transport=s=>{const key=`${s.collection}:${s.machine}`;if(!transports.has(key))transports.set(key,umiUploadTransport(umi,plan,target(s),{networkCacheMs:30000}));return transports.get(key);};
 const load=()=>{const s=store.read(SETUP_KEY)||{owner:LAUNCH_OWNER,cluster:'devnet'};if(s.owner!==LAUNCH_OWNER||s.cluster!=='devnet')throw Error('Чужой журнал.');return s;};
 const save=s=>store.write(SETUP_KEY,s);
 async function read(s,{signal}={}) {
  signal?.throwIfAborted();
  const reader=signal?devnetUmi(provider,{fetch:(input,options)=>paced.fetch(input,{...options,signal}),disableRetryOnRateLimit:true}):umi;
  const checked=signal?umiUploadTransport(reader,plan,target(s)):transport(s);
  await checked.assertNetwork('devnet');
  let collection,machine;
  // Existing launches only need the machine account to verify the loaded count.
  // Read the collection as well during setup or when a collection operation is pending.
  if(s.collection&&(!s.machine||s.pending?.kind==='collection'))collection=await safeFetchCollectionV1(reader,publicKey(s.collection),{commitment:'finalized'});
  if(collection) {
   if(collection.updateAuthority!==LAUNCH_OWNER||collection.name!=='CoolBears'||collection.uri!==`${SITE}/metadata/collection.json`||collection.royalties?.basisPoints!==700)throw Error('Неожиданная коллекция.');
  }
  if(s.machine)machine=await safeFetchCandyMachine(reader,publicKey(s.machine),{commitment:'finalized'});
  if(machine)loadedItems(machine,target(s));
  signal?.throwIfAborted();
  if(s.pending) {
   const found=s.pending.kind==='collection'?collection:s.pending.kind==='machine'?machine:null;
   if(found){delete s.pending;save(s);}
   else if(await canDiscardPending(reader.rpc,s.pending)) {
    signal?.throwIfAborted();
    if(s.pending.kind==='collection')delete s.collection;
    else if(s.pending.kind==='machine')delete s.machine;
    else throw Error('Неизвестная операция.');
    delete s.pending;save(s);
   }
  }
  signal?.throwIfAborted();
  return {state:s,collection:!!collection||!!s.collection,machine:!!machine,loaded:machine?.itemsLoaded??0,balance:null};
 }
 return {
  read:options=>store.withLock(SETUP_KEY,()=>read(load(),options)),
  create:kind=>store.withLock(SETUP_KEY,async()=>{
   const s=load(),current=await read(s);
   if(s.pending)throw Error('Предыдущая операция ещё проверяется.');
   if(kind==='collection' && s.collection || kind==='machine' && s.machine)throw Error('Адрес уже сохранён. Проверь состояние.');
   if(kind!=='collection'&&kind!=='machine')throw Error('Неизвестная операция.');
   if(kind==='machine'&&!current.collection)throw Error('Сначала создай коллекцию.');
   const signer=generateSigner(umi);
   const builder=kind==='collection'?launchCollectionBuilder(umi,plan,signer):await launchMachineBuilder(umi,plan,signer,s.collection);
   await sendTracked(umi,builder,s,save,{kind},()=>{s[kind]=signer.publicKey;});
   return read(s);
  }),
  step:()=>store.withLock(SETUP_KEY,async()=>{
   const s=load(),current=await read(s);
   if(s.pending||!current.machine)throw Error('Сначала дождись создания машины.');
   return createUploader(transport(s),store,target(s)).step();
  }),
  retryAfter:paced.retryAfter,
  groupSupported:()=>typeof provider.signAllTransactions==='function',
  groupStep:options=>store.withLock(SETUP_KEY,async()=>{
   const s=load();
   if(s.pending||!s.machine||!s.collection)throw Error('Сначала дождись создания машины.');
   const size=1;
   return createGroupUploader(transport(s),store,target(s)).step({...options,size});
  }),
  backup:()=>{const s=load();const key=s.machine?`coolbears-upload-v1:devnet:${s.machine}`:null;return JSON.stringify({setup:s,upload:key?store.read(key):null},null,2);}
 };
}
