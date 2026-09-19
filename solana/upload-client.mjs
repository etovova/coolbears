import { generateSigner, publicKey } from '@metaplex-foundation/umi';
import { fetchCollection } from '@metaplex-foundation/mpl-core';
import { fetchCandyMachine } from '@metaplex-foundation/mpl-core-candy-machine';
import { devnetUmi, SITE } from './builders.mjs';
import { launchPlan, LAUNCH_OWNER, launchCollectionBuilder, launchMachineBuilder } from './launch-plan.mjs';
import { createUploader, umiUploadTransport, loadedItems } from './upload.mjs';
import { createGroupUploader } from './upload-group.mjs';
import { sendTracked, canDiscardPending } from './transactions.mjs';
import { pacedRpcFetch } from './rpc-pacing.mjs';
const paced= pacedRpcFetch();
export { isRateLimit } from './rpc-pacing.mjs';
export { runUpload } from './upload-runner.mjs';
export { browserUploadStore } from './browser-upload-store.mjs';
export const SETUP_KEY='devnet-upload-setup-v1';
export function uploadClient(provider,store) {
 const umi=devnetUmi(provider,{fetch:paced.fetch,disableRetryOnRateLimit:true}),plan=launchPlan({treasury:LAUNCH_OWNER,royaltyRecipient:LAUNCH_OWNER});
 const target=s=>({cluster:'devnet',collection:s.collection,machine:s.machine});
 const transports=new Map();
 const transport=s=>{const key=`${s.collection}:${s.machine}`;if(!transports.has(key))transports.set(key,umiUploadTransport(umi,plan,target(s),{networkCacheMs:30000}));return transports.get(key);};
 const load=()=>{const s=store.read(SETUP_KEY)||{owner:LAUNCH_OWNER,cluster:'devnet'};if(s.owner!==LAUNCH_OWNER||s.cluster!=='devnet')throw Error('Чужой журнал.');return s;};
 const save=s=>store.write(SETUP_KEY,s);
 async function read(s) {
  await transport(s).assertNetwork('devnet');
  let collection,machine;
  if(s.collection && await umi.rpc.accountExists(publicKey(s.collection),{commitment:'finalized'})) {
   collection=await fetchCollection(umi,publicKey(s.collection),{commitment:'finalized'});
   if(collection.updateAuthority!==LAUNCH_OWNER||collection.name!=='CoolBears'||collection.uri!==`${SITE}/metadata/collection.json`||collection.royalties?.basisPoints!==700)throw Error('Неожиданная коллекция.');
  }
  if(s.machine && await umi.rpc.accountExists(publicKey(s.machine),{commitment:'finalized'})) {
   machine=await fetchCandyMachine(umi,publicKey(s.machine),{commitment:'finalized'});loadedItems(machine,target(s));
  }
  if(s.pending) {
   const found=s.pending.kind==='collection'?collection:s.pending.kind==='machine'?machine:null;
   if(found){delete s.pending;save(s);}
   else if(await canDiscardPending(umi.rpc,s.pending)) {
    if(s.pending.kind==='collection')delete s.collection;
    else if(s.pending.kind==='machine')delete s.machine;
    else throw Error('Неизвестная операция.');
    delete s.pending;save(s);
   }
  }
  return {state:s,collection:!!collection,machine:!!machine,loaded:machine?.itemsLoaded??0,balance:Number((await umi.rpc.getBalance(publicKey(LAUNCH_OWNER))).basisPoints)/1e9};
 }
 return {
  read:()=>store.withLock(SETUP_KEY,()=>read(load())),
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
   const size=typeof provider.signAllTransactions==='function'?options?.size??10:1;
   return createGroupUploader(transport(s),store,target(s)).step({...options,size});
  }),
  backup:()=>{const s=load();const key=s.machine?`coolbears-upload-v1:devnet:${s.machine}`:null;return JSON.stringify({setup:s,upload:key?store.read(key):null},null,2);}
 };
}
