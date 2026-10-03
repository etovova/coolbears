// Unsigned current-item preparation. No custody, signing or execution grant.
import policy from '../../metadata/policy.json' with {type:'json'};
import {createProtocolOrderModel} from './journal-model.mjs';
import {createOrderPlanner} from './transaction-model.mjs';
import {prepareAssetClaim} from './signing.mjs';
import {validateBlockhashAnchor} from './blockhash-anchor.mjs';
import {currentItemIndex} from './sequential.mjs';
const model=createProtocolOrderModel(policy),planner=createOrderPlanner(model);
export function preparationFor(order,block,sourceSlot){
  const itemIndex=currentItemIndex(order);
  if(itemIndex===null)throw Error('ORDER_COMPLETE');
  const template=planner.buildOrderItemTemplate(order,itemIndex,block);
  const candidate={orderRevision:order.revision,itemIndex,blockhash:template.blockhash,lastValidBlockHeight:template.lastValidBlockHeight,
    transactionBase64:Buffer.from(template.unsignedBytes).toString('base64')};
  const {claim}=prepareAssetClaim(order,candidate);
  const anchor={version:1,orderIdentitySha256:claim.orderIdentitySha256,messageSha256:claim.messageSha256,
    blockhash:claim.blockhash,lastValidBlockHeight:claim.lastValidBlockHeight,sourceSlot};
  validateBlockhashAnchor(anchor,claim);return {anchor,candidate};
}
export function validatePreparation(order,record){
  const expected=preparationFor(order,record?.anchor,record?.anchor?.sourceSlot);
  if(JSON.stringify(record)!==JSON.stringify(expected))throw Error('PREPARATION_MISMATCH');
  return record;
}
