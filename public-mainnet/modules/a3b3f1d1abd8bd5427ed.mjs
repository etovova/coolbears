import { Buffer } from '/public-mainnet/modules/b67364f30402cad4ee1b.mjs';
// Unsigned current-item preparation. No custody, signing or execution grant.
import policy from '/public-mainnet/modules/9753b87c4a3cad84685d.mjs';
import {createProtocolOrderModel} from '/public-mainnet/modules/c2e57714b2d49f910e34.mjs';
import {createOrderPlanner} from '/public-mainnet/modules/131eda32cd5b4bf1a327.mjs';
import {prepareAssetClaim} from '/public-mainnet/modules/8c19f4e554421cc56f55.mjs';
import {validateBlockhashAnchor} from '/public-mainnet/modules/59a7d0a819a7f7dfbf79.mjs';
import {currentItemIndex} from '/public-mainnet/modules/a194ea6bf24e2ca920fe.mjs';
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
