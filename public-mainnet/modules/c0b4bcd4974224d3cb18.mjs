import {validatePublicBuyerConfig} from '/public-mainnet/modules/9609056ec7e489d2b838.mjs';
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
  const state=()=>{if(evidence.expiresAt!==null&&evidence.expiresAt<=clock())return {...blocked(),expiredOpen:evidence.status==='open'};return{...evidence,pending:!!pending};};
  const emit=()=>{try{onChange(state());}catch{}};
  const pause=(ms=450)=>new Promise(resolve=>setTimeout(resolve,ms));
  async function refresh(){
    if(disposed)throw Error('PUBLIC_READINESS_UNAVAILABLE');if(pending)return pending;
    const epoch=++generation;evidence=blocked();
    pending=(async()=>{try{
      let waited=0;for(let attempt=0;attempt<4;attempt++){
      let response;try{response=await fetchImpl(config.origin+'/api/buyer/readiness',{method:'GET',credentials:'omit',cache:'no-store',redirect:'error',headers:{accept:'application/json'},signal:AbortSignal.timeout(10000)});}catch(error){
        if(!attempt&&!disposed&&epoch===generation){await pause();if(disposed||epoch!==generation)throw error;continue;}throw error;}
      // Retry only transient read-only failures without a server retry policy.
      if(attempt<3&&[502,503,504].includes(response.status)&&!response.headers.has('retry-after')){
        await pause(450*3**attempt);if(disposed||epoch!==generation)throw Error('PUBLIC_READINESS_UNAVAILABLE');continue;}
      if(!response.ok||!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''))throw Error('PUBLIC_READINESS_UNAVAILABLE');
      const text=await response.text();if(text.length>8192)throw Error('PUBLIC_READINESS_UNAVAILABLE');
      const raw=JSON.parse(text);let checked;
      try{checked=validatePublicReadiness(raw,config,clock());}catch(error){
        // Never extend the evidence window. A verified, otherwise canonical response can
        // arrive just before its timestamp or after its server-side cache lifetime.
        if(response.headers.get('x-coolbears-network-verified')!=='1')throw error;
        validatePublicReadiness(raw,config,raw.checkedAt);const now=clock(),ahead=raw.checkedAt-now;
        if(ahead>0&&ahead<=2000){await new Promise(resolve=>setTimeout(resolve,ahead+20));checked=validatePublicReadiness(raw,config,clock());}
        else if(attempt===0&&now>=raw.expiresAt&&now-raw.expiresAt<=10000&&!disposed&&epoch===generation){await pause();if(disposed||epoch!==generation)throw error;continue;}
        else throw error;
      }if(disposed||epoch!==generation)throw Error('PUBLIC_READINESS_UNAVAILABLE');
      if(checked.status==='unavailable'&&response.headers.get('x-coolbears-network-verified')==='0'){
        const reason=response.headers.get('x-coolbears-readiness-reason'),seconds=Number(response.headers.get('retry-after'));
        if(attempt<3&&['BUSY','COOLDOWN'].includes(reason)&&Number.isSafeInteger(seconds)&&seconds>=1&&seconds+waited<=45){
          waited+=seconds;await new Promise(resolve=>setTimeout(resolve,seconds*1000+200));
          if(disposed||epoch!==generation)throw Error('PUBLIC_READINESS_UNAVAILABLE');continue;
        }
      }
      if(attempt===0&&checked.status==='unavailable'&&response.headers.get('x-coolbears-network-verified')==='0'&&!response.headers.has('retry-after')){
        await new Promise(resolve=>setTimeout(resolve,450));if(disposed||epoch!==generation)throw Error('PUBLIC_READINESS_UNAVAILABLE');continue;
      }
      evidence=checked;return state();}

    }catch{evidence=blocked();throw Error('PUBLIC_READINESS_UNAVAILABLE');}
    finally{pending=null;emit();}})();emit();return pending;
  }
  return Object.freeze({state,refresh,async requireOpen(){const value=await refresh();if(value.status==='unavailable')throw Error('PUBLIC_READINESS_UNAVAILABLE');if(value.salesOpen!==true||value.status!=='open')throw Error('PUBLIC_SALES_CLOSED');return value;},
    dispose(){disposed=true;generation++;evidence=blocked();emit();}});
}
