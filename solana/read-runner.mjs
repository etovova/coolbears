import {abortable,isRateLimit,rpcDelay} from './rpc-pacing.mjs';

// Only read/reconcile is retried. Never replay a signing or sending operation.
export async function readWithRecovery(client,{signal,onProgress=()=>{},sleep=rpcDelay,timeout=45000,maxAttempts=3}={}) {
 let rateLimited=false;
 for(let attempt=1;attempt<=maxAttempts;attempt++) {
  let remaining=Math.max(client.retryAfter?.()??0,rateLimited?30000:0);
  while(remaining>0){
   signal?.throwIfAborted();
   onProgress({status:'cooldown',seconds:Math.ceil(remaining/1000),attempt});
   const tick=Math.min(1000,remaining);await abortable(sleep(tick,signal),signal);remaining-=tick;
  }
  signal?.throwIfAborted();
  onProgress({status:'checking',attempt});
  const request=new AbortController(),abort=()=>request.abort(signal.reason);
  signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>request.abort(new DOMException('Проверка не завершилась за 45 секунд. Прогресс сохранён. Можно повторить проверку.','TimeoutError')),timeout);
  try {
   const result=await abortable(client.read({signal:request.signal}),request.signal);
   signal?.throwIfAborted();return result;
  }catch(error){
   signal?.throwIfAborted();
   if(!isRateLimit(error)||attempt===maxAttempts)throw error;
   rateLimited=true;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
}
