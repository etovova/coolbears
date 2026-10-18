// Historical receipt projection only. This cache never proves current finality,
// balances, fees, readiness or account state. The unmodified native checker must
// still re-read statuses/accounts and verify the complete wire on every hit.
import policy from '../../../metadata/policy.json' with {type:'json'};
import {sha256} from '@noble/hashes/sha256';
import {VersionedTransaction} from '@solana/web3.js';
import {createOrderModel} from '../journal-model.mjs';
import {assertCurrentItem} from '../sequential.mjs';
import {createOrderPlanner} from '../transaction-model.mjs';
import {createSigningRequest,verifySigningResponse} from '../../deployment/signing.mjs';
import {networkProfile} from '../../deployment/network.mjs';

export const PUBLIC_PREFIX_CACHE_KIND='finalized-receipt-projection-v1';
const MAX_RESPONSE=4*1024*1024,MAX_PROJECTION=3072,MAX_WIRE=1644;
const need=(ok)=>{if(!ok)throw Object.assign(Error('PUBLIC_PREFIX_RECEIPT_CACHE'),{code:'PUBLIC_PREFIX_RECEIPT_CACHE'});};
const digest=value=>Buffer.from(sha256(value)).toString('hex');
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const exact=(v,names)=>v&&[Object.prototype,null].includes(Object.getPrototypeOf(v))
  &&Reflect.ownKeys(v).length===names.length&&names.every(name=>Object.hasOwn(v,name)
    &&Object.hasOwn(Object.getOwnPropertyDescriptor(v,name),'value'));
const same=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
const RECORD_KEYS=['version','kind','cluster','genesisHash','profileSha256','signature','slot','signedWireSha256','projectionJson','recordSha256'];

async function boundedText(response){
  need(response instanceof Response&&response.status===200&&response.body?.getReader);
  const length=response.headers.get('content-length');need(length===null||(/^\d+$/.test(length)&&Number(length)<=MAX_RESPONSE));
  const reader=response.body.getReader(),chunks=[];let size=0,timer;
  const cancel=()=>{try{void reader.cancel().catch(()=>{});}catch{}};
  try{return await Promise.race([(async()=>{while(true){const {value,done}=await reader.read();if(done)break;
    need(value instanceof Uint8Array&&(size+=value.length)<=MAX_RESPONSE);chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  })(),new Promise((_,reject)=>{timer=setTimeout(()=>{cancel();reject(Error('PUBLIC_PREFIX_RECEIPT_CACHE'));},5000);})]);}
  finally{clearTimeout(timer);cancel();try{reader.releaseLock();}catch{}}
}

// The constructor receives the gateway's independently profile-bound order.
// It must not be constructed for recovery, expiry or replacement transports.
export function createPublicPrefixReceiptCache({storage,profileSha256,order,itemIndex}){
  need(storage&&typeof storage.get==='function'&&typeof storage.put==='function'
    &&typeof profileSha256==='string'&&/^[a-f0-9]{64}$/.test(profileSha256)&&profileSha256!=='0'.repeat(64));
  order=structuredClone(order);assertCurrentItem(order,itemIndex);
  need(order.cluster==='mainnet-beta'&&order.storageMode==='hidden-settings');
  const network=networkProfile(order.cluster),model=createOrderModel(policy,{storageMode:order.storageMode,hiddenCommitmentSha256:order.hiddenCommitmentSha256});
  model.validateOrder(order);const planner=createOrderPlanner(model),prefix=new Map(order.items.slice(0,itemIndex).map(item=>[item.attempts.at(-1).signature,item]));
  function scope(method,params){
    if(method!=='getTransaction'||!Array.isArray(params)||params.length!==2||!same(Reflect.ownKeys(params),['0','1','length']))return null;
    const [signature,config]=params;
    if(!exact(config,['commitment','encoding','maxSupportedTransactionVersion'])||config.commitment!=='finalized'
      ||config.encoding!=='base64'||config.maxSupportedTransactionVersion!==0)return null;
    const item=prefix.get(signature);return item?{item,attempt:item.attempts.at(-1),signature}:null;
  }
  const key=signature=>`public-prefix-receipt:v1:${network.genesisHash}:${profileSha256}:${signature}`;
  function validateProjection(value,entry){
    need(exact(value,['slot','version','transaction','meta'])&&integer(value.slot)&&value.slot===entry.attempt.proof.slot&&value.version===0
      &&exact(value.meta,['err'])&&value.meta.err===null&&Array.isArray(value.transaction)&&value.transaction.length===2
      &&same(Reflect.ownKeys(value.transaction),['0','1','length'])&&value.transaction[1]==='base64');
    const wire=value.transaction[0];need(typeof wire==='string'&&wire.length>0&&wire.length<=MAX_WIRE);
    const bytes=Buffer.from(wire,'base64');need(bytes.length<=1232&&bytes.toString('base64')===wire);
    const transaction=VersionedTransaction.deserialize(bytes),template=planner.buildOrderItemTemplate(order,entry.item.index,entry.attempt);
    need(transaction.version===0&&same([...transaction.serialize()],[...bytes])
      &&same([...transaction.message.serialize()],[...VersionedTransaction.deserialize(template.unsignedBytes).message.serialize()]));
    transaction.signatures[0]=new Uint8Array(64);
    const request=createSigningRequest({deploymentId:order.id,stepId:`item-${entry.item.index}`,attempt:entry.attempt.number,
      cluster:order.cluster,owner:order.buyer,transactionBase64:Buffer.from(transaction.serialize()).toString('base64'),lastValidBlockHeight:entry.attempt.lastValidBlockHeight});
    const signed=verifySigningResponse(request,{transactionBase64:wire});
    need(signed.signature===entry.signature&&signed.messageSha256===entry.attempt.messageSha256);
    const projectionJson=JSON.stringify({slot:value.slot,version:0,transaction:[wire,'base64'],meta:{err:null}});
    need(Buffer.byteLength(projectionJson,'utf8')<=MAX_PROJECTION);
    return {projectionJson,signedWireSha256:digest(bytes)};
  }
  function makeRecord(projection,entry){
    const checked=validateProjection(projection,entry),record={version:1,kind:PUBLIC_PREFIX_CACHE_KIND,cluster:order.cluster,
      genesisHash:network.genesisHash,profileSha256,signature:entry.signature,slot:entry.attempt.proof.slot,...checked};
    return {...record,recordSha256:digest(Buffer.from(JSON.stringify(record),'utf8'))};
  }
  function validateRecord(record,entry){
    need(exact(record,RECORD_KEYS)&&typeof record.projectionJson==='string'&&Buffer.byteLength(record.projectionJson,'utf8')<=MAX_PROJECTION);
    const expected=makeRecord(JSON.parse(record.projectionJson),entry);
    need(RECORD_KEYS.every(name=>record[name]===expected[name]));return expected;
  }
  return Object.freeze({
    async read(method,params,rpcId){
      const entry=scope(method,params);if(!entry)return null;need(integer(rpcId));
      const stored=await storage.get(key(entry.signature));if(stored===undefined||stored===null)return null;
      let record;try{record=validateRecord(stored,entry);}catch{return null;}
      return new Response(`{"jsonrpc":"2.0","id":${rpcId},"result":${record.projectionJson}}`,{status:200,headers:{
        'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-coolbears-receipt-cache':PUBLIC_PREFIX_CACHE_KIND}});
    },
    async remember(method,params,responseClone,expectedRpcId){
      const entry=scope(method,params);if(!entry)return false;need(integer(expectedRpcId));
      let record;try{
        const envelope=JSON.parse(await boundedText(responseClone));
        need(exact(envelope,['jsonrpc','id','result'])&&envelope.jsonrpc==='2.0'&&envelope.id===expectedRpcId);
        const result=envelope.result;need(result&&typeof result==='object'&&result.meta?.err===null);
        record=makeRecord({slot:result.slot,version:result.version,transaction:result.transaction,meta:{err:null}},entry);
      }catch{return false;}
      const stored=await storage.get(key(entry.signature));
      if(stored!==undefined&&stored!==null){let previous;try{previous=validateRecord(stored,entry);}catch{}
        if(previous){need(previous.recordSha256===record.recordSha256);return true;}}
      await storage.put(key(entry.signature),record);return true;
    },
  });
}
