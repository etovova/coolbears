// Pure, fail-closed schema shared by generation, publication and offline tests.
import assert from 'node:assert/strict';
export const HIDDEN_GIF='ipfs://bafybeibyftszumcapsb5hf3fv7i2y46wj4ti6and7qv5mkigb6prx33bni';
export const HIDDEN_DESCRIPTION='Your CoolBear is hiding. Final artwork, traits and rarity remain hidden until reveal, no earlier than January 1, 2027, 00:00 UTC. Everyone gets a bear. Not everyone gets a legend.';
export function validateHiddenMetadata(m,index=null){
  assert.deepEqual(Object.keys(m).sort(),['name','description','image','animation_url','external_url'].sort(),'Only five public prereveal fields are allowed; no attributes, rank or nested properties');
  if(index!==null)assert.ok(Number.isInteger(index)&&index>=0&&index<10000,'Invalid token index');
  assert.equal(m.name,index===null?'CoolBears — Hidden Bear':`CoolBears #${String(index).padStart(4,'0')} — Hidden Bear`);
  assert.equal(m.description,HIDDEN_DESCRIPTION,'Description must not expose traits or promise automatic reveal');
  assert.equal(m.image,HIDDEN_GIF,'Approved GIF must not change');
  assert.equal(m.animation_url,HIDDEN_GIF);
  assert.equal(m.external_url,'https://coolbears-nfts.com/');
  return true;
}
