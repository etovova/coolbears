// Bounded UTF-8 JSON decoding for this check-only protocol.
export class BuyerCheckError extends Error {
  constructor(code, status = 503, retryAfter) { super(code); this.code=code; this.status=status; this.retryAfter=retryAfter; }
}
export const need = (ok, code, status = 400, retryAfter) => { if (!ok) throw new BuyerCheckError(code,status,retryAfter); };
export const exact = (value, fields) => value && typeof value==='object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',')===fields.split(' ').sort().join(',');
export async function readJson(message, {limit=65536,timeoutMs=4000,signal,canonical=true}={}) {
  need(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(message.headers.get('content-type')??'')
    && !message.headers.has('content-encoding'),'CONTENT_TYPE',415);
  const length=message.headers.get('content-length');
  need(length===null||(/^\d+$/.test(length)&&Number(length)<=limit),'BODY_SIZE',413);
  need(message.body?.getReader,'BODY',400);
  const reader=message.body.getReader();let timer,abort;
  const cancel=()=>{try{void reader.cancel().catch(()=>{});}catch{}};
  try{
    return await Promise.race([(async()=>{
      const bytes=new Uint8Array(limit);let size=0;
      while(true){
        need(!signal?.aborted,'TIMEOUT',408);const {done,value}=await reader.read();if(done)break;
        need(value instanceof Uint8Array&&size+value.length<=limit,'BODY_SIZE',413);bytes.set(value,size);size+=value.length;
      }
      try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size)),value=JSON.parse(text);
        need(!canonical||JSON.stringify(value)===text,'BODY',400);return value;
      }catch{throw new BuyerCheckError('BODY',400);}
    })(),new Promise((_,reject)=>{
      abort=()=>{cancel();reject(new BuyerCheckError('TIMEOUT',408));};
      timer=setTimeout(abort,timeoutMs);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    })]);
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);cancel();try{reader.releaseLock();}catch{}}
}
