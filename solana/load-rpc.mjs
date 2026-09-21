export const DEFAULT_RPC='https://api.devnet.solana.com';
export function rpcUrl(value=DEFAULT_RPC) {
  let url;try{url=new URL(value.trim());}catch{throw Error('Вставь полный HTTPS-адрес RPC Devnet.');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash)throw Error('Нужен HTTPS-адрес RPC Devnet.');
  return url.href;
}
// One endpoint, one request, bounded wait. No hidden retries, endpoint switching,
// web3 error wrapping, background polling, or transaction submission here.
export function readRpc(endpoint,{fetch=globalThis.fetch,timeout=10000,onEvent=()=>{},now=Date.now}={}) {
  endpoint=rpcUrl(endpoint);let id=0,cooldown=0;
  const methods=new Set(['getGenesisHash','getAccountInfo','getLatestBlockhash','getEpochInfo','getSignatureStatuses','getTransaction']);
  return async (method,params=[])=>{
    if(!methods.has(method))throw Error('Этот RPC используется только для проверки.');
    if(now()<cooldown)throw Error('RPC ограничил запросы. Повтори проверку через несколько секунд.');
    const controller=new AbortController(),started=now();let timer,outcome='network';
    try {
      const operation=(async()=>{
        const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:controller.signal});
        outcome=response.status;
        if(response.status===429){const seconds=Number(response.headers.get('Retry-After'));cooldown=now()+Math.max(1000,Math.min(60000,Number.isFinite(seconds)&&seconds>0?seconds*1000:5000));throw Error('RPC ограничил запросы. Проверь лимит своего проекта и повтори проверку позже.');}
        if(response.status===401||response.status===403)throw Error('RPC отклонил доступ. Проверь адрес и ключ проекта.');
        if(!response.ok)throw Error(`Сервер RPC недоступен (HTTP ${response.status}).`);
        const body=await response.json();
        if(body.error){
          const code=Number.isInteger(body.error.code)?body.error.code:null;outcome=code;
          // Keep only the numeric code. Provider messages/data may contain keys.
          throw Object.assign(Error(`RPC не выполнил ${method} (код ${code}).`),{code});
        }
        if(!Object.hasOwn(body,'result'))throw Error('RPC вернул неполный ответ.');
        return body.result;
      })();
      return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>{outcome='timeout';controller.abort();reject(Error('RPC не ответил за 10 секунд. Проверь подключение и повтори проверку.'));},timeout);})]);
    } finally {clearTimeout(timer);onEvent({at:new Date(now()).toISOString(),phase:'rpc',method,host:new URL(endpoint).host,outcome,elapsedMs:now()-started});}
  };
}
