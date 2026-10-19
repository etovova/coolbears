import {validatePublicBuyerConfig} from './config.mjs';
const fields=['version','status','cluster','genesisHash','machine','collection','guard','storageMode','hiddenCommitmentSha256',
  'unitPriceLamports','maximumPerOrder','profileSha256','checkedAt','expiresAt','salesOpen'];
const exact=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key));
const blocked=()=>({status:'unavailable',salesOpen:false,checkedAt:null,expiresAt:null});
export function validatePublicReadiness(value,input,now=Date.now()){
  const config=validatePublicBuyerConfig(input),same=['cluster','genesisHash','machine','collection','guard','storageMode','hiddenCommitmentSha256','profileSha256'];
  if(!exact(value)||value.version!==1||!['closed','open','sold-out','unavailable'].includes(value.status)
    ||!same.every(key=>value[key]===config[key])||value.unitPriceLamports!=='200000000'||value.maximumPerOrder!==50
    ||value.salesOpen!==(value.status==='open')||!Number.isSafeInteger(now)||!Number.isSafeInteger(value.checkedAt)||!Number.isSafeInteger(value.expiresAt)
    ||value.checkedAt>now||value.expiresAt<=now||value.expiresAt<=value.checkedAt||value.expiresAt-value.checkedAt>10000)throw Error('PUBLIC_READINESS_UNAVAILABLE');
  return Object.freeze(structuredClone(value));
}
export function createPublicReadinessClient(input,{fetchImpl=globalThis.fetch,clock=Date.now,onChange=()=>{},origin=globalThis.location?.origin}={}){
  const config=validatePublicBuyerConfig(input);if(origin!==config.origin||typeof fetchImpl!=='function')throw Error('PUBLIC_ORIGIN');
  let evidence=blocked(),pending=null,disposed=false,generation=0;
  const state=()=>{if(evidence.expiresAt!==null&&evidence.expiresAt<=clock())return blocked();return{...evidence,pending:!!pending};};
  const emit=()=>{try{onChange(state());}catch{}};
  async function refresh(){
    if(disposed)throw Error('PUBLIC_READINESS_UNAVAILABLE');if(pending)return pending;
    const epoch=++generation;evidence=blocked();
    pending=(async()=>{try{
      const response=await fetchImpl(config.origin+'/api/buyer/readiness',{method:'GET',credentials:'omit',cache:'no-store',redirect:'error',headers:{accept:'application/json'},signal:AbortSignal.timeout(10000)});
      if(!response.ok||!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''))throw Error('PUBLIC_READINESS_UNAVAILABLE');
      const text=await response.text();if(text.length>8192)throw Error('PUBLIC_READINESS_UNAVAILABLE');
      const checked=validatePublicReadiness(JSON.parse(text),config,clock());if(disposed||epoch!==generation)throw Error('PUBLIC_READINESS_UNAVAILABLE');
      evidence=checked;return state();
    }catch{evidence=blocked();throw Error('PUBLIC_READINESS_UNAVAILABLE');}
    finally{pending=null;emit();}})();emit();return pending;
  }
  return Object.freeze({state,refresh,async requireOpen(){const value=await refresh();if(value.salesOpen!==true||value.status!=='open')throw Error('PUBLIC_SALES_CLOSED');return value;},
    dispose(){disposed=true;generation++;evidence=blocked();emit();}});
}
