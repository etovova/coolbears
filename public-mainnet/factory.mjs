// Public composition over the existing validated order, custody, signature and
// recovery adapters. Only the fixed public factory enables its send port.
import {createBuyerStorage} from '../operator/orders/browser-storage.mjs';
import {createBuyerWalletClient} from '../operator/orders/wallet-client.mjs';
import {createBuyerPreparationClient} from '../operator/orders/gateway/preparation-client.mjs';
import {createBuyerCheckClient} from '../operator/orders/gateway/client.mjs';
import {createBuyerSubmissionTransport} from '../operator/orders/gateway/submission-client.mjs';
import {createBuyerSender} from '../operator/orders/sender.mjs';
import {createBuyerResponseRecovery} from '../operator/orders/response-recovery-client.mjs';
import {createBuyerPrewalletRecovery} from '../operator/orders/prewallet-recovery-client.mjs';
import {createBuyerCustodyRecovery} from '../operator/orders/custody-recovery-client.mjs';
import {createPrivateBuyerController} from '../operator/orders/buyer-console/controller.mjs';
import {createScopeIndex,consoleStorageOptions} from '../operator/orders/buyer-console/config.mjs';
import {validateCostApproval} from '../operator/orders/cost-approval.mjs';
import {validatePublicBuyerConfig,buyerScopeConfig} from './config.mjs';
import {createPublicReadinessClient} from './readiness-client.mjs';
export function createPublicBuyerConsole(input,{onChange=()=>{}}={}){
  const deployment=validatePublicBuyerConfig(input),config=buyerScopeConfig(deployment);
  if(globalThis.location?.origin!==config.origin)throw Error('PUBLIC_ORIGIN');
  let client,gateBusy=false,approvedQuote=null,indexUnavailable=false,nativeIndex;
  try{nativeIndex=createScopeIndex({config});}catch{indexUnavailable=true;}
  const index={list(){try{if(!nativeIndex)throw Error();return nativeIndex.list();}catch{indexUnavailable=true;return[];}},
    async save(scope){try{if(indexUnavailable||!nativeIndex)throw Error();await nativeIndex.save(scope);}catch(error){indexUnavailable=true;throw Error('STORAGE_UNAVAILABLE');}}};
  const emit=()=>{try{onChange(state());}catch{}};
  const readiness=createPublicReadinessClient(deployment,{onChange:emit});
  const storage=createBuyerStorage({cluster:'mainnet-beta',authorizeMainnet:true,storageOptions:consoleStorageOptions(config)});
  const transport=createBuyerSubmissionTransport({origin:config.origin});
  client=createPrivateBuyerController({config,storage,index,prepare:createBuyerPreparationClient({origin:config.origin}),onChange:emit,sendingEnabled:true,
    makePorts:scope=>({wallet:createBuyerWalletClient({storage,scope,authorizeMainnet:true,checkPrepared:createBuyerCheckClient({origin:config.origin}),onChange:emit}),
      sender:createBuyerSender({storage,scope,authorizeMainnet:true,transport}),response:createBuyerResponseRecovery({storage,scope,transport}),
      prewallet:createBuyerPrewalletRecovery({storage,scope,transport}),custody:createBuyerCustodyRecovery({storage,scope,transport})})});
  function state(){const value=client?.state()??{},gate=readiness.state(),allowed=gate.salesOpen===true&&!indexUnavailable&&!gateBusy;return{...value,busy:gateBusy||value.busy===true,salesOpen:gate.salesOpen===true,saleStatus:gate.status,readiness:gate,storageAvailable:!indexUnavailable,approvedQuote:approvedQuote?structuredClone(approvedQuote):null,
    canCreate:value.canCreate===true&&allowed,canPrepare:value.canPrepare===true&&allowed,
    canQuote:value.canQuote===true&&allowed,canSign:value.canSign===true&&allowed,canSend:value.canSend===true&&allowed};}
  const guarded=new Set(['create','prepare','quoteCost','sign','send','reviewReplacement','prepareReviewedReplacement']);
  async function refreshApprovedQuote(){
    approvedQuote=null;const current=client.state();if(!current.scope)return;
    const scope={...current.scope,cluster:config.cluster,machine:config.machine,collection:config.collection,guard:config.guard,...consoleStorageOptions(config)};
    const saved=await storage.readBuyerSubmission(scope);if(saved?.status!=='ready')return;
    validateCostApproval(saved.costApproval,saved.input,{now:Date.now()});approvedQuote=structuredClone(saved.costApproval.quote);
  }
  const sync=new Set(['load','refresh','sign','recoverWalletResponse','recover','prepareReviewedReplacement','send']);
  const api={state,refreshReadiness:()=>{state();if(indexUnavailable)throw Error('STORAGE_UNAVAILABLE');return readiness.refresh();},dispose(){readiness.dispose();client.dispose();}};
  for(const name of Object.keys(client))if(!['state','dispose'].includes(name))api[name]=async(...args)=>{
    if(gateBusy)throw Error('BUSY');if(guarded.has(name)){gateBusy=true;emit();}
    try{if(guarded.has(name)){state();if(indexUnavailable)throw Error('STORAGE_UNAVAILABLE');await readiness.requireOpen();}return await client[name](...args);}
    finally{if(sync.has(name))try{await refreshApprovedQuote();}catch{approvedQuote=null;}gateBusy=false;emit();}
  };
  return Object.freeze(api);
}
