import { isRateLimit } from './rpc-pacing.mjs';
// No background signing on page load. Called only by the Continue button.
export async function runUpload(client,{size=10,continuous=true,stopped=()=>false,onProgress=()=>{},sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  let sign=false,waits=0,rateLimits=0;
  while(!stopped()){
    let r;
    try {r=await client.groupStep({size,sign,stopped,onPhase:onProgress});}
    catch(error){
      if(!isRateLimit(error))throw error;
      sign=false; // Reconcile saved signatures before another signing request.
      if(++rateLimits>5)return {status:'rate-limited'};
      let delay=Math.max(client.retryAfter?.()??0,Math.min(120000,30000*2**(rateLimits-1)));
      while(delay>0&&!stopped()){
        onProgress({status:'cooldown',seconds:Math.ceil(delay/1000)});
        const tick=Math.min(1000,delay);await sleep(tick);delay-=tick;
      }
      continue;
    }
    onProgress(r);
    if(['complete','retry-available','stopped'].includes(r.status))return r;
    if(r.status==='verified'&&!continuous)return r;
    if(r.status==='pending'||r.status==='submitted'){
      sign=false;
      if(++waits>=60)return {status:'waiting',loaded:r.loaded};
      await sleep(12000);
    }else{
      waits=0;sign=true;
    }
  }
  return {status:'stopped'};
}
