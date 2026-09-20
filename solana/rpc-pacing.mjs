export const isRateLimit = error => error?.status===429 || error?.code===429 || /(?:\b429\b|rate limit|too many requests)/i.test(String(error?.message??error));

// One HTTP request at a time, shared by all uploader clients in this page.
// No automatic replay here: especially never replay sendTransaction.
export function abortable(promise,signal) {
 if(!signal)return promise;
 return new Promise((resolve,reject)=>{
  const abort=()=>reject(signal.reason??new DOMException('Проверка отменена.','AbortError'));
  if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
  Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
 });
}
export function rpcDelay(ms,signal) {
 return new Promise((resolve,reject)=>{
  const done=()=>{signal?.removeEventListener('abort',abort);resolve();};
  const timer=setTimeout(done,ms);
  const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal.reason??new DOMException('Проверка отменена.','AbortError'));};
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 });
}
export function pacedRpcFetch({fetch:fetcher=globalThis.fetch.bind(globalThis),interval=1500,timeout=15000,now=Date.now,sleep=rpcDelay}={}) {
 let tail=Promise.resolve(),next=0,cooldown=0;
 const run=async(input,options={})=>{
  const signal=options.signal;
  signal?.throwIfAborted();
  while(now()<Math.max(next,cooldown))await abortable(sleep(Math.max(next,cooldown)-now(),signal),signal);
  signal?.throwIfAborted();
  next=now()+interval;
  const request=new AbortController();
  const abort=()=>request.abort(signal.reason);
  signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>request.abort(new DOMException('Сервер Solana не ответил за 15 секунд. Сохранённые транзакции не потеряны. Проверь состояние ещё раз.','TimeoutError')),timeout);
  try {
   return await abortable((async()=>{
    const response=await fetcher(input,{...options,signal:request.signal});
    request.signal.throwIfAborted();
    if(response.status===429){
     const header=response.headers?.get('retry-after');
     const seconds=header!==null&&header!==undefined&&header.trim()!==''?Number(header):NaN;
     const retry=Number.isFinite(seconds)?seconds*1000:Date.parse(header??'')-now();
     cooldown=now()+Math.max(30000,Number.isFinite(retry)?retry:0);
    }
    // Include body consumption in the deadline, not just response headers.
    if(typeof response.text!=='function')return response;
    const body=await response.text();
    request.signal.throwIfAborted();
    return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
   })(),request.signal);
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 };
 const fetch=(input,options)=>{const result=tail.then(()=>run(input,options));tail=result.catch(()=>{});return abortable(result,options?.signal);};
 return {fetch,retryAfter:()=>Math.max(0,cooldown-now())};
}
