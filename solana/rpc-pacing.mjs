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
export function pacedRpcFetch({fetch:fetcher=globalThis.fetch.bind(globalThis),interval=0,timeout=15000,now=Date.now,sleep=rpcDelay,fallbackEndpoints=[]}={}) {
 let tail=Promise.resolve(),next=0;
 const cooldowns=new Map();
 const limited=endpoint=>Object.assign(Error('Сервер Solana ограничил запросы. Повтори проверку вручную позже.'),{status:429,retryAfterMs:Math.max(0,(cooldowns.get(endpoint)??0)-now())});
 const reads=new Set(['getAccountInfo','getMultipleAccounts','getBalance','getGenesisHash','getSlot','getBlock','getBlockHeight','getLatestBlockhash','getSignatureStatuses']);
 const run=async(input,options={})=>{
  const signal=options.signal;
  signal?.throwIfAborted();
  if(now()<next)await abortable(sleep(next-now(),signal),signal);
  signal?.throwIfAborted();
  next=now()+interval;
  let payload;
  try {payload=JSON.parse(options.body);} catch {}
  const methods=Array.isArray(payload)?payload.map(item=>item?.method):[payload?.method];
  // Only known read methods may fail over. Sending is always attempted once.
  const readOnly=methods.length>0&&methods.every(method=>reads.has(method));
  const endpoints=readOnly?[...new Set([input,...fallbackEndpoints])]:[input];
  let lastError;
  for(const endpoint of endpoints){
   signal?.throwIfAborted();
   // Respect Retry-After without freezing the next manual action in a timer.
   if((cooldowns.get(endpoint)??0)>now()){lastError=limited(endpoint);continue;}
   const request=new AbortController();
   const abort=()=>request.abort(signal.reason);
   signal?.addEventListener('abort',abort,{once:true});
   const timer=setTimeout(()=>request.abort(new DOMException('Сервер Solana не ответил вовремя. Проверь состояние ещё раз.','TimeoutError')),timeout);
   try {
    const result=await abortable((async()=>{
     const response=await fetcher(endpoint,{...options,signal:request.signal});
     const body=typeof response.text==='function'?await response.text():null;
     request.signal.throwIfAborted();
     let json;try {json=JSON.parse(body);}catch {}
     const errors=(Array.isArray(json)?json:[json]).map(r=>r?.error).filter(Boolean);
     const rateLimited=response.status===429||errors.some(isRateLimit);
     if(rateLimited){
      const header=response.headers?.get('retry-after');
      const seconds=header?.trim()?Number(header):NaN;
      const retry=Number.isFinite(seconds)?seconds*1000:Date.parse(header??'')-now();
      cooldowns.set(endpoint,now()+Math.max(0,Number.isFinite(retry)?retry:30000));
      throw limited(endpoint);
     }
     if(readOnly&&[502,503,504].includes(response.status))throw Object.assign(Error('Сервер Solana временно недоступен.'),{status:response.status});
     return body===null?response:new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    })(),request.signal);
    return result;
   } catch(error){
    signal?.throwIfAborted();
    const transient=isRateLimit(error)||error.name==='TimeoutError'||error instanceof TypeError||[502,503,504].includes(error.status);
    if(!readOnly||!transient)throw error;
    lastError=error;
   } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  throw lastError;
 };
 const fetch=(input,options)=>{const result=tail.then(()=>run(input,options));tail=result.catch(()=>{});return abortable(result,options?.signal);};
 return {fetch,retryAfter:()=>Math.max(0,...[...cooldowns.values()].map(until=>until-now()))};
}
