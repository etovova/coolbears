import { publicKey, lamports, base64, base58, createNoopSigner, signerIdentity } from '@metaplex-foundation/umi';
import { deserializeCandyMachine, MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core-candy-machine';
import { toWeb3JsLegacyTransaction } from '@metaplex-foundation/umi-web3js-adapters';
import { devnetUmi, configLineSettings, SITE } from './builders.mjs';
import { LAUNCH_OWNER, SUPPLY, launchItemsBuilder } from './launch-plan.mjs';

export const TARGET = Object.freeze({owner:LAUNCH_OWNER, cluster:'devnet', collection:'BZRkdsRsmeBBGb1JsVUbgZbThWraaMPSRazdiQdioLcy', machine:'FLpAJpBG7BDEL5cFZPiouGD6ZWnTWRRBrWxtkjVz9s3R'});
export const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const KEY = 'coolbears-operator:devnet-load-v2';
export const LEGACY_KEY = `coolbears-operator:coolbears-upload-v1:devnet:${TARGET.machine}`;
export const SETTINGS_KEY = 'coolbears-operator:devnet-rpc-settings-v1';
export const LOCKS = ['coolbears-operator:devnet-upload-setup-v1', LEGACY_KEY];
export const isHeight = n => Number.isSafeInteger(n) && n >= 0;
export function validSignature(value) {
  try { const bytes=base58.serialize(value); return bytes.length===64 && bytes.some(b=>b!==0); } catch { return false; }
}
export function decodeProgress(result, minSlot=0) {
  if (!isHeight(result?.context?.slot) || result.context.slot<minSlot || !result.value || result.value.data?.[1]!=='base64') throw Error('Не удалось получить актуальное состояние машины.');
  const v=result.value;
  const m=deserializeCandyMachine({publicKey:publicKey(TARGET.machine), owner:publicKey(v.owner), executable:v.executable, lamports:lamports(v.lamports), rentEpoch:v.rentEpoch??0, data:base64.serialize(v.data[0])});
  if (m.header.owner!==MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID || m.header.executable || m.authority!==TARGET.owner || m.collectionMint!==TARGET.collection || m.data.itemsAvailable!==BigInt(SUPPLY) || !m.data.isMutable || m.itemsRedeemed!==0n) throw Error('Параметры машины отличаются от проверенной коллекции Devnet.');
  const settings=m.data.configLineSettings;
  if (settings.__option!=='Some' || Object.entries(configLineSettings).some(([k,v])=>settings.value[k]!==v)) throw Error('Настройки записей отличаются от коллекции.');
  const loaded=new Set();
  for (const item of m.items) {
    const id=String(item.index).padStart(4,'0');
    if (!Number.isInteger(item.index)||item.index<0||item.index>=SUPPLY||loaded.has(item.index)||item.minted||item.name!==`CoolBears #${id} — Hidden Bear`||item.uri!==`${SITE}/metadata/hidden/${id}.json`) throw Error('Содержимое загруженных записей отличается от коллекции.');
    loaded.add(item.index);
  }
  if (loaded.size!==m.itemsLoaded) throw Error('Не совпадает число загруженных записей.');
  let start=0; while(loaded.has(start)&&start<SUPPLY)start++;
  let count=0; while(count<25&&start+count<SUPPLY&&!loaded.has(start+count))count++;
  return {loaded, slot:result.context.slot, next:count?{start,count}:null};
}
export function buildUpload(batch, latest) {
  if (!isHeight(latest?.context?.slot)||!isHeight(latest?.value?.lastValidBlockHeight)) throw Error('Некорректный срок транзакции.');
  publicKey(latest.value.blockhash);
  const umi=devnetUmi().use(signerIdentity(createNoopSigner(publicKey(TARGET.owner))));
  const tx=launchItemsBuilder(umi,TARGET,TARGET.machine,batch.start,batch.count).setBlockhash(latest.value).build(umi);
  const legacy=toWeb3JsLegacyTransaction(tx);
  if (legacy.serialize({requireAllSignatures:false,verifySignatures:false}).length>1232) throw Error('Превышен размер транзакции.');
  return legacy;
}
export function browserStore(storage=globalThis.localStorage, locks=globalThis.navigator?.locks) {
  return {
    read(key) {const value=storage.getItem(key);return value===null?null:JSON.parse(value);},
    write(key,value) {const raw=JSON.stringify(value);storage.setItem(key,raw);if(storage.getItem(key)!==raw)throw Error('Не удалось сохранить результат в браузере.');},
    lock(fn) {
      if(!locks?.request)throw Error('Открой страницу в браузере Phantom с поддержкой блокировки вкладок.');
      const take=i=>i===LOCKS.length?fn():locks.request(LOCKS[i],{mode:'exclusive',ifAvailable:true},lock=>{
        if(!lock)throw Error('Загрузка уже открыта в другой вкладке.');return take(i+1);
      });
      return take(0);
    }
  };
}
