// Application cost consent, not an on-chain cap or proof of a human gesture.
// Quotes must come from the trusted checker and be persisted by the gateway.
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {validateAssetRequest,buyerRequestId} from './signing.mjs';
const need=(ok,code='COST_APPROVAL_INVALID')=>{if(!ok)throw Error(code);};
const exact=(v,names)=>v&&Object.keys(v).sort().join(' ')===names.split(' ').sort().join(' ');
const digest=v=>bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(v))));
const integer=v=>Number.isSafeInteger(v)&&v>=0;
export function lamports(value){
  need(typeof value==='string'&&/^(0|[1-9][0-9]{0,15})$/.test(value),'COST_AMOUNT');
  const n=BigInt(value);need(n<=BigInt(Number.MAX_SAFE_INTEGER),'COST_AMOUNT');return n;
}
function quoteBudget(value,order,itemIndex=0){
  const sequential=itemIndex>0;
  need(exact(value,'unitPriceLamports networkFeeLamports assetRentLamports protocolChargeLamports priorityFeeLamports totalLamports projectedOrderTotalLamports quantity'+(sequential?' completedQuantity remainingQuantity projectedRemainingTotalLamports':'')),'COST_QUOTE_INVALID');
  const names=['unitPriceLamports','networkFeeLamports','assetRentLamports','protocolChargeLamports','priorityFeeLamports','totalLamports','projectedOrderTotalLamports'];
  const amounts=Object.fromEntries(names.map(k=>[k,lamports(value[k])]));
  need(value.unitPriceLamports===order.unitPriceLamports&&value.quantity===order.quantity
    &&amounts.networkFeeLamports>0n&&amounts.assetRentLamports>0n&&amounts.protocolChargeLamports>0n
    &&amounts.priorityFeeLamports===0n
    &&amounts.totalLamports===amounts.unitPriceLamports+amounts.networkFeeLamports+amounts.assetRentLamports+amounts.protocolChargeLamports
    &&amounts.projectedOrderTotalLamports===amounts.totalLamports*BigInt(order.quantity),'COST_QUOTE_INVALID');
  if(sequential)need(value.completedQuantity===itemIndex&&value.remainingQuantity===order.quantity-itemIndex
    &&lamports(value.projectedRemainingTotalLamports)===amounts.totalLamports*BigInt(value.remainingQuantity),'COST_QUOTE_INVALID');
  return {...Object.fromEntries(names.map(k=>[k,value[k]])),quantity:value.quantity,
    ...(sequential?{completedQuantity:itemIndex,remainingQuantity:value.remainingQuantity,projectedRemainingTotalLamports:value.projectedRemainingTotalLamports}:{})};
}
export function checkedBudget(report,order){
  const itemIndex=report?.itemIndex??0;
  need(Number.isSafeInteger(itemIndex)&&itemIndex>=0&&itemIndex<order.quantity,'COST_QUOTE_INVALID');
  const b=report?.budget;
  need(b?.complete===true&&b.scope==='next-item-current-template'&&b.projectionOnly===true
    &&b.fullOrderTotalLamports===null&&b.orderItemPriceLamports===order.totalPriceLamports,'COST_QUOTE_INVALID');
  const result=quoteBudget({unitPriceLamports:b.unitPriceLamports,networkFeeLamports:b.nextItemFeeLamports,
    assetRentLamports:b.nextItemBaseRentLamports,protocolChargeLamports:b.protocolChargesLamports,priorityFeeLamports:b.priorityFeeLamports,
    totalLamports:b.nextItemKnownMinimumLamports,projectedOrderTotalLamports:b.projectedOrderTotalLamports,quantity:order.quantity,
    ...(itemIndex>0?{completedQuantity:b.completedQuantity,remainingQuantity:b.remainingQuantity,projectedRemainingTotalLamports:b.projectedRemainingTotalLamports}:{})},order,itemIndex);
  need(lamports(b.balanceLamports)>=lamports(result.totalLamports),'COST_QUOTE_INVALID');return result;
}
const fields=['version','kind','requestId','orderIdentitySha256','checkedSlot','issuedAt','expiresAt','budget'];
function quoteId(quote,order,itemIndex=0){return digest(Object.fromEntries(fields.map(k=>[k,k==='budget'?quoteBudget(quote.budget,order,itemIndex):quote[k]])));}
export const costQuoteKey=id=>'buyer-cost:v1:'+id;
export function createCostQuote(input,report){
  const {order,claim,request}=input;validateAssetRequest(order,claim,request);
  need(report.status==='wallet-check-passed'&&report.requestId===buyerRequestId(request)
    &&report.orderRevision===claim.orderRevision&&report.orderId===order.id&&report.readyToSign===true
    &&(report.itemIndex??0)===claim.itemIndex,'COST_QUOTE_INVALID');
  const quote={version:claim.itemIndex>0?2:1,kind:'coolbears-buyer-cost-quote',requestId:buyerRequestId(request),orderIdentitySha256:claim.orderIdentitySha256,
    checkedSlot:report.checkedSlot,issuedAt:report.checkedAt,expiresAt:report.checkedAt+300000,budget:checkedBudget(report,order)};
  quote.quoteId=quoteId(quote,order,claim.itemIndex);validateCostQuote(quote,input);return quote;
}
export function validateCostQuote(quote,{order,claim,request}){
  validateAssetRequest(order,claim,request);
  need(exact(quote,fields.join(' ')+' quoteId')&&quote.version===(claim.itemIndex>0?2:1)&&quote.kind==='coolbears-buyer-cost-quote'
    &&quote.requestId===buyerRequestId(request)&&quote.orderIdentitySha256===claim.orderIdentitySha256
    &&integer(quote.checkedSlot)&&integer(quote.issuedAt)&&integer(quote.expiresAt)
    &&quote.expiresAt-quote.issuedAt===300000&&quote.quoteId===quoteId(quote,order,claim.itemIndex),'COST_QUOTE_INVALID');
  return quote;
}
export function validateCostApproval(approval,input,{now}={}){
  need(exact(approval,'version quote maxTotalLamports approvedAt')&&approval.version===1,'COST_APPROVAL_REQUIRED');
  validateCostQuote(approval.quote,input);
  need(lamports(approval.maxTotalLamports)>=lamports(approval.quote.budget.totalLamports),'COST_LIMIT_TOO_LOW');
  need(integer(approval.approvedAt)&&approval.approvedAt>=approval.quote.issuedAt&&approval.approvedAt<approval.quote.expiresAt);
  if(now!==undefined)need(integer(now)&&now>=approval.approvedAt&&now<approval.quote.expiresAt,'COST_APPROVAL_EXPIRED');
  return approval;
}
export function enforceCostCeiling(approval,input,report,now=Date.now()){
  validateCostApproval(approval,input,{now});
  const budget=checkedBudget(report,input.order);
  need(lamports(budget.totalLamports)<=lamports(approval.maxTotalLamports),'COST_LIMIT_EXCEEDED');
  return budget;
}
