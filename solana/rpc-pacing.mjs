export const isRateLimit = error => error?.status===429 || error?.code===429 || /(?:\b429\b|rate limit|too many requests)/i.test(String(error?.message??error));

// One HTTP request at a time, shared by all uploader clients in this page.
// No automatic replay here: especially never replay sendTransaction.
export function pacedRpcFetch({fetch:fetcher=globalThis.fetch.bind(globalThis),interval=1500,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
 let tail=Promise.resolve(),next=0,cooldown=0;
 const run=async(...args)=>{
  while(now()<Math.max(next,cooldown))await sleep(Math.max(next,cooldown)-now());
  next=now()+interval;
  const response=await fetcher(...args);
  if(response.status===429){
   const header=response.headers?.get('retry-after');
   const seconds=header!==null&&header!==undefined&&header.trim()!==''?Number(header):NaN;
   const retry=Number.isFinite(seconds)?seconds*1000:Date.parse(header??'')-now();
   cooldown=now()+Math.max(30000,Number.isFinite(retry)?retry:0);
  }
  return response;
 };
 const fetch=(...args)=>{const result=tail.then(()=>run(...args));tail=result.catch(()=>{});return result;};
 return {fetch,retryAfter:()=>Math.max(0,cooldown-now())};
}
