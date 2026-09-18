import fs from 'node:fs';
import assert from 'node:assert/strict';
import {validateHiddenMetadata} from './prereveal-policy.mjs';
const m=JSON.parse(fs.readFileSync('metadata/prereveal.json'));
validateHiddenMetadata(m);
let passed=1;
for(const [key,value] of Object.entries({attributes:[],rank:1,rarity:0,properties:{rank:1},traits:[],trait_count:7,Status:'Unrevealed'})){
  assert.throws(()=>validateHiddenMetadata({...m,[key]:value}));passed++;
}
for(const key of Object.keys(m)){
  const copy={...m};delete copy[key];assert.throws(()=>validateHiddenMetadata(copy));passed++;
  assert.throws(()=>validateHiddenMetadata({...m,[key]:'Gold Glasses Rank 1'}));passed++;
}
const files=fs.readdirSync('build/prereveal-metadata').sort();
assert.equal(files.length,10000);
for(let i=0;i<10000;i++){
  const f=String(i).padStart(4,'0')+'.json';assert.equal(files[i],f);
  validateHiddenMetadata(JSON.parse(fs.readFileSync('build/prereveal-metadata/'+f)),i);
}
console.log(JSON.stringify({suite:'no-attributes-prereveal',negativeAndSchemaCases:passed,allItemsChecked:10000,attributes:0,rankFields:0,transactionsSent:0}));
