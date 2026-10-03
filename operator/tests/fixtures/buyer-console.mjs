// UI-only ports. These simulate reviewed adapter outputs, never real chain evidence.
import {PublicKey} from '@solana/web3.js';
import {createPrivateBuyerController} from '../../orders/buyer-console/controller.mjs';
export const consoleKey=n=>new PublicKey(new Uint8Array(32).fill(n)).toBase58();
export const consoleConfig={version:1,cluster:'devnet',origin:'https://console-fixture.test',machine:consoleKey(2),collection:consoleKey(3),guard:consoleKey(4)};
export function buyerConsoleFixture({sendingEnabled=false}={}){
  const calls={persist:0,create:0,prepare:0,native:0,quote:0,wallet:0,send:0,recover:0,readonly:0,replacement:0,replacementSign:0},saved=[],records=new Map();
  let now=1900000000000,persistent=false,listener,connected=false,currentScope,lastQuote,failCreate=false,heldQuote;
  const account={address:consoleKey(5),publicKey:new Uint8Array(32).fill(5),chains:['solana:devnet'],features:['solana:signTransaction']};
  const wallet={name:'Fixture sign-only wallet',chains:['solana:devnet'],accounts:[account],features:{
    'standard:connect':{connect:async()=>({accounts:wallet.accounts})},'standard:events':{on:(_name,fn)=>{listener=fn;return()=>{listener=null;};}},
    'solana:signTransaction':{supportedTransactionVersions:[0],signTransaction:async()=>{throw Error('Real signing forbidden in UI fixture');}}}};
  const snapshot=()=>records.get(currentScope.id),advance=()=>{snapshot().order.revision++;};
  const cost=()=>({quoteId:'fixture-quote-'+calls.quote,issuedAt:now,expiresAt:now+300000,budget:{quantity:snapshot().order.quantity,unitPriceLamports:'200000000',networkFeeLamports:'10000',assetRentLamports:'1999999',protocolChargeLamports:'1500000',priorityFeeLamports:'0',totalLamports:'203509999',projectedOrderTotalLamports:String(203509999n*BigInt(snapshot().order.quantity))}});
  const storage={async readRecoverySnapshot(scope){return structuredClone(records.get(scope.id)??null);},
    async readCostSummary(){const s=snapshot();return{verifiedItemPriceLamports:String(s.order.items.filter(i=>i.attempts.at(-1)?.state==='verified').length*200000000),knownFailedFeesLamports:s.submission?.failureRecord?.evidence.feeLamports??'0'};},
    async create(scope){calls.create++;const order={id:scope.id,buyer:scope.buyer,quantity:scope.quantity,revision:0,paused:false,items:Array.from({length:scope.quantity},(_,index)=>({index,attempts:[]}))};
      records.set(scope.id,{order,custody:{status:'available'},assetSigning:null,buyerWallet:null,submission:null,responseRecovery:null,prewalletRecovery:null});if(failCreate)throw Error('STORAGE_UNCERTAIN');return order;},
    async prepareAssetSigning(_scope,candidate){calls.native++;const s=snapshot(),item=s.order.items[candidate.itemIndex];item.attempts.push({number:1,state:'wallet-pending'});advance();
      s.assetSigning={status:'asset-partial-saved',claim:{itemIndex:item.index,orderRevision:s.order.revision},request:{itemIndex:item.index}};s.prewalletRecovery={status:'prewallet-unknown'};s.submission=null;},
    async recoverAssetSigning(){return snapshot().assetSigning;},
    async prepareReplacementSigning(){calls.replacementSign++;const s=snapshot(),i=s.order.items.find(i=>i.attempts.at(-1)?.state!=='verified');i.attempts.push({number:2,state:'wallet-pending'});advance();
      s.assetSigning={status:'asset-partial-saved',claim:{itemIndex:i.index,orderRevision:s.order.revision},request:{itemIndex:i.index}};s.submission=null;s.responseRecovery=null;s.prewalletRecovery={status:'prewallet-unknown'};},
    async append(_scope,event){snapshot().order.paused=event.type==='pause';advance();return snapshot().order;}};
  const recover=async()=>{calls.recover++;return{status:'unknown'};};
  const reviewExpiry=async()=>{const s=snapshot(),i=s.order.items.find(i=>i.attempts.at(-1)?.state!=='verified');i.attempts.at(-1).state='expired';advance();s.submission={status:'expired'};return{status:'expired'};};
  const replace=async()=>{calls.replacement++;const s=snapshot();return{candidate:{itemIndex:s.order.items.find(i=>i.attempts.at(-1)?.state!=='verified').index,orderRevision:s.order.revision}};};
  const options={config:consoleConfig,storage,index:{list:()=>structuredClone(saved),save:scope=>saved.push({id:scope.id,buyer:scope.buyer})},clock:()=>now,
    crypto:{getRandomValues(bytes){bytes.fill(saved.length+10);return bytes;}},sendingEnabled,
    storageManager:{persist:async()=>{calls.persist++;persistent=true;return true;},persisted:async()=>persistent},
    prepare:async()=>{calls.prepare++;const s=snapshot();return{candidate:{itemIndex:s.order.items.find(i=>i.attempts.at(-1)?.state!=='verified').index,orderRevision:s.order.revision}};},
    makePorts:scope=>{currentScope=scope;connected=false;return{
      wallet:{dispose(){connected=false;},load:async()=>{},state:()=>({canRequestSignature:connected&&snapshot()?.assetSigning?.status==='asset-partial-saved'&&!snapshot().submission&&!snapshot().responseRecovery}),
        connect:async()=>{connected=true;},quoteCost:async()=>{calls.quote++;if(heldQuote)await heldQuote;return lastQuote=cost();},
        signOnly:async()=>{calls.wallet++;const s=snapshot(),i=s.order.items.find(i=>i.attempts.at(-1)?.state!=='verified');i.attempts.at(-1).state='unknown';advance();s.submission={status:'ready',costApproval:{quote:lastQuote}};s.prewalletRecovery=null;return{status:'buyer-response-saved'};}},
      sender:{sendOnce:async()=>{calls.send++;snapshot().submission.status='send-claimed';return{status:'accepted'};},recover,reviewExpiry,prepareReplacement:replace},
      response:{recoverMissingResponse:recover,reviewExpiry,prepareReplacement:replace},prewallet:{recover,reviewExpiry,prepareReplacement:replace},
      custody:{check:async()=>{calls.readonly++;return{status:'unknown',readOnly:true};}},
    };}};
  const controller=createPrivateBuyerController(options);
  return{controller,wallet,account,calls,records,saved,options,storage,get snapshot(){return snapshot();},advanceTime:ms=>now+=ms,
    accountChanged(){wallet.accounts=[];listener?.({accounts:[]});},set failCreate(value){failCreate=value;},set heldQuote(value){heldQuote=value;},
    async ready(quantity=2){await controller.connectWallet(wallet);await controller.selectAccount(account.address);await controller.requestPersistence({authorizePersistence:true});await controller.create({quantity,authorizeCreate:true});},
    failAttempt(){const s=snapshot(),i=s.order.items.find(i=>i.attempts.at(-1)?.state!=='verified');i.attempts.at(-1).state='failed';advance();s.submission={status:'failed',failureRecord:{evidence:{feeLamports:'10000'}}};},
    verify(){const s=snapshot(),i=s.order.items.find(i=>i.attempts.at(-1)?.state!=='verified');i.attempts.at(-1).state='verified';advance();s.submission={status:'verified'};},
  };
}
