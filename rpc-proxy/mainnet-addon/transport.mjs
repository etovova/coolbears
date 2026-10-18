// Private Worker-to-Worker transport only. The caller's separate durable buyer
// gateway owns admission, budget, exact transaction policy and single-use send.
export const MAINNET_UPSTREAM='https://mainnet.helius-rpc.com/';
const METHODS=new Set(['getGenesisHash','getMultipleAccounts','getAccountInfo','getBalance','getFeeForMessage',
  'getMinimumBalanceForRentExemption','simulateTransaction','isBlockhashValid','getBlockHeight','getSignatureStatuses',
  'getTransaction','getLatestBlockhash','getBlock','getFirstAvailableBlock','getSignaturesForAddress','sendTransaction']);
const LIMITS=Object.freeze({requestBytes:8192,responseBytes:4*1024*1024,requestTimeoutMs:4000,upstreamTimeoutMs:12000});
const need=(value,code,status=400)=>{if(!value)throw Object.assign(Error(code),{code,status});};
const exact=(v,names)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(' ')===names.slice().sort().join(' ');
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const headers=()=>({'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
function failure(code,status,id=null,retryAfter){return new Response(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32000,message:code}}),
  {status,headers:{...headers(),...(retryAfter?{'retry-after':retryAfter}:{})}});}
function secretReflected(text,secret){return [secret,encodeURIComponent(secret),new URLSearchParams({'api-key':secret}).toString().slice(8)].some(value=>text.includes(value));}
function parsedSecretReflected(value,secret){
  const pending=[value];while(pending.length){const item=pending.pop();
    if(typeof item==='string'&&secretReflected(item,secret))return true;
    if(item&&typeof item==='object')for(const [key,child]of Object.entries(item)){
      if(secretReflected(key,secret))return true;pending.push(child);
    }
  }return false;
}
function safeRetryAfter(value,secret){return typeof value==='string'&&value.length<=128&&/^[\x20-\x7e]+$/.test(value)
  &&!secretReflected(value,secret)&&(/^\d{1,10}$/.test(value)||Number.isFinite(Date.parse(value)))?value:undefined;}
async function boundedRead(message,limit,signal){
  const length=message.headers.get('content-length');need(length===null||(/^\d+$/.test(length)&&Number(length)<=limit),'BODY_SIZE',413);
  need(message.body?.getReader,'BODY',400);const reader=message.body.getReader(),chunks=[];let size=0;
  const cancel=()=>{try{void reader.cancel().catch(()=>{});}catch{}};
  const aborted=new Promise((_,reject)=>{signal.addEventListener('abort',()=>{cancel();reject(Object.assign(Error('TIMEOUT'),{code:'TIMEOUT',status:504}));},{once:true});});
  try{return await Promise.race([(async()=>{while(true){need(!signal.aborted,'TIMEOUT',504);const {done,value}=await reader.read();if(done)break;
    need(value instanceof Uint8Array&&(size+=value.length)<=limit,'BODY_SIZE',413);chunks.push(value);}
    const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  })(),aborted]);}finally{cancel();try{reader.releaseLock();}catch{}}
}
function validateRpc(value,text){
  need(exact(value,['jsonrpc','id','method','params'])&&value.jsonrpc==='2.0'&&integer(value.id)&&METHODS.has(value.method)&&Array.isArray(value.params),'RPC_REQUEST',400);
  need(JSON.stringify(value)===text,'RPC_CANONICAL_JSON',400); // duplicate keys, alternate numbers and batches cannot pass.
  if(value.method==='sendTransaction'){
    const [wire,config]=value.params;
    need(value.params.length===2&&typeof wire==='string'&&wire.length>0&&wire.length<=1644&&/^[A-Za-z0-9+/]*={0,2}$/.test(wire)
      &&wire.length%4===0&&exact(config,['encoding','skipPreflight','preflightCommitment','maxRetries','minContextSlot'])
      &&config.encoding==='base64'&&config.skipPreflight===false&&config.preflightCommitment==='confirmed'&&config.maxRetries===0&&integer(config.minContextSlot),'SEND_OPTIONS',400);
  }
  return value;
}
export async function handleMainnetRpc(request,env,{fetchImpl=(...args)=>globalThis.fetch(...args),limits=LIMITS}={}){
  let id=null,controller,timer,onAbort;
  try{
    need(request instanceof Request&&request.url===MAINNET_UPSTREAM,'RPC_ENDPOINT',404);
    need(request.method==='POST','METHOD',405);
    need(!['origin','cookie','authorization','content-encoding'].some(name=>request.headers.has(name)),'PRIVATE_SERVICE_ONLY',403);
    need(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''),'CONTENT_TYPE',415);
    controller=new AbortController();onAbort=()=>controller.abort();request.signal.addEventListener('abort',onAbort,{once:true});if(request.signal.aborted)onAbort();
    timer=setTimeout(()=>controller.abort(),limits.requestTimeoutMs);
    const body=await boundedRead(request,limits.requestBytes,controller.signal);let rpc;try{rpc=JSON.parse(body);}catch{need(false,'RPC_JSON',400);}
    rpc=validateRpc(rpc,body);id=rpc.id;
    const secret=env?.HELIUS_API_KEY;need(typeof secret==='string'&&secret.length>=8&&secret.length<=256&&!/\s/.test(secret),'CONFIGURATION',503);
    const target=new URL(MAINNET_UPSTREAM);target.searchParams.set('api-key',secret);
    need(!controller.signal.aborted,'TIMEOUT',504);
    clearTimeout(timer);timer=setTimeout(()=>controller.abort(),limits.upstreamTimeoutMs);
    const abortFailure=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Object.assign(Error('TIMEOUT'),{code:'TIMEOUT',status:504})),{once:true}));
    const upstream=await Promise.race([fetchImpl(target.href,{method:'POST',headers:{'content-type':'application/json'},body,
      signal:controller.signal,redirect:'manual',credentials:'omit',cache:'no-store'}),abortFailure]);
    const retryAfter=safeRetryAfter(upstream.headers.get('retry-after'),secret);
    if(!upstream.ok){try{void upstream.body?.cancel().catch(()=>{});}catch{}return failure('UPSTREAM_HTTP',upstream.status,id,retryAfter);}
    const text=await boundedRead(upstream,limits.responseBytes,controller.signal);need(!secretReflected(text,secret),'UPSTREAM_REDACTED',502);
    let data;try{data=JSON.parse(text);}catch{need(false,'UPSTREAM_JSON',502);}
    // JSON escapes can conceal reflected credentials from the raw-byte scan.
    need(!parsedSecretReflected(data,secret),'UPSTREAM_REDACTED',502);
    need(data&&typeof data==='object'&&!Array.isArray(data)&&data.jsonrpc==='2.0'&&data.id===id
      &&(Object.hasOwn(data,'result')!==Object.hasOwn(data,'error')),'UPSTREAM_ENVELOPE',502);
    // Never emit arbitrary provider error text, headers, request URLs or secrets.
    if(Object.hasOwn(data,'error')){
      const code=Number.isSafeInteger(data.error?.code)?data.error.code:-32000;
      return new Response(JSON.stringify({jsonrpc:'2.0',id,error:{code,message:'Upstream RPC request failed.'}}),{status:upstream.status,headers:{...headers(),...(retryAfter?{'retry-after':retryAfter}:{})}});
    }
    return new Response(text,{status:upstream.status,headers:{...headers(),...(retryAfter?{'retry-after':retryAfter}:{})}});
  }catch(error){return failure(['RPC_ENDPOINT','METHOD','PRIVATE_SERVICE_ONLY','CONTENT_TYPE','BODY_SIZE','BODY','RPC_JSON','RPC_REQUEST','RPC_CANONICAL_JSON','SEND_OPTIONS','CONFIGURATION','TIMEOUT','UPSTREAM_REDACTED','UPSTREAM_JSON','UPSTREAM_ENVELOPE'].includes(error?.code)?error.code:'UPSTREAM_UNAVAILABLE',Number.isInteger(error?.status)?error.status:502,id);}
  finally{clearTimeout(timer);request?.signal?.removeEventListener('abort',onAbort);if(controller&&!controller.signal.aborted)controller.abort();}
}
