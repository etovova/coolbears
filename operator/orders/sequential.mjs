// Executor policy for a contiguous order. Structural checks are not chain proof.
import policy from '../../metadata/policy.json' with {type:'json'};
import {createOrderModel} from './journal-model.mjs';
const model=createOrderModel(policy);
const need=(ok,code='ORDER_SEQUENCE')=>{if(!ok)throw Error(code);};
export function validateSequentialOrder(order){
  model.validateOrder(order);
  let pending=false;
  for(const item of order.items){
    need(item.attempts.length<=2,'ATTEMPT_LIMIT');
    if(item.attempts.length===2)need(['expired','failed'].includes(item.attempts[0].state),'REPLACEMENT_NOT_READY');
    need(!pending||item.attempts.length===0);
    if(item.attempts.at(-1)?.state!=='verified')pending=true;
  }
  return order;
}
export function currentItemIndex(order){
  validateSequentialOrder(order);
  const index=order.items.findIndex(item=>item.attempts.at(-1)?.state!=='verified');
  return index<0?null:index;
}
export function assertCurrentItem(order,index,{allowVerified=false}={}){
  validateSequentialOrder(order);
  need(Number.isSafeInteger(index)&&index>=0&&index<order.quantity,'INVALID_ITEM_INDEX');
  need(order.items.slice(0,index).every(item=>item.attempts.at(-1)?.state==='verified'));
  need(allowVerified&&order.items[index].attempts.at(-1)?.state==='verified'||currentItemIndex(order)===index);
  return order.items[index];
}
