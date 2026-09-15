import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const gcd=(a,b)=>b?gcd(b,a%b):a;
const add=(a,b)=>{const n=a.n*b.d+b.n*a.d,d=a.d*b.d,g=gcd(n,d);return {n:n/g,d:d/g}};
const compare=(a,b)=>a.n*b.d>b.n*a.d?1:a.n*b.d<b.n*a.d?-1:0;
export function reserveRarest(records, expectedCount=10000){
  assert.equal(records.length,expectedCount,'Collection size mismatch');
  assert(records.length>1);
  const frequencies=new Map(), signatures=new Set();let schema;
  const rows=records.map((record,sourceIndex)=>{
    assert(typeof record.image==='string' && record.image.length>0,'Missing artwork');
    assert(Array.isArray(record.attributes)&&record.attributes.length>0,'Missing final traits');
    const attrs=record.attributes.map(a=>{assert(typeof a.trait_type==='string'&&typeof a.value==='string');return [a.trait_type,a.value]}).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
    assert.equal(new Set(attrs.map(a=>a[0])).size,attrs.length,'Duplicate trait type');
    const types=JSON.stringify(attrs.map(a=>a[0]));schema??=types;assert.equal(types,schema,'All NFTs require the same trait categories, including None');
    const signature=JSON.stringify(attrs);assert(!signatures.has(signature),'Duplicate combination');signatures.add(signature);
    const keys=attrs.map(a=>JSON.stringify(a));for(const k of keys)frequencies.set(k,(frequencies.get(k)||0)+1);
    return {record,sourceIndex,keys};
  });
  for(const r of rows)r.score=r.keys.reduce((s,k)=>add(s,{n:BigInt(records.length),d:BigInt(frequencies.get(k))}),{n:0n,d:1n});
  const ranked=[...rows].sort((a,b)=>-compare(a.score,b.score)||a.sourceIndex-b.sourceIndex);
  assert(compare(ranked[0].score,ranked[1].score)>0,'Top rarity is tied: adjust the private generation and retry; no artificial bonus is allowed');
  const winner=ranked[0];const assigned=[winner,...rows.filter(r=>r!==winner)];
  const ids=new Map(assigned.map((r,id)=>[r.sourceIndex,id]));
  const ranking=ranked.map((r,i)=>({tokenId:ids.get(r.sourceIndex),sourceIndex:r.sourceIndex,rank:i+1,scoreNumerator:r.score.n.toString(),scoreDenominator:r.score.d.toString()}));
  assert.equal(ranking[0].tokenId,0);
  return {metadata:assigned.map((r,i)=>({...r.record,name:`CoolBears #${String(i).padStart(4,'0')}`})),ranking};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [input,out]=process.argv.slice(2);assert(input&&out,'Usage: node scripts/reserve-rarest.mjs PRIVATE_INPUT.json NEW_PRIVATE_OUTPUT_DIRECTORY');
  const repo=fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
  const parent=fs.realpathSync(path.dirname(path.resolve(out)));const output=path.join(parent,path.basename(out));
  assert(output!==repo&&!output.startsWith(repo+path.sep),'Final data must be outside the public repository');
  assert(!fs.existsSync(output),'Refusing to overwrite existing output');
  const result=reserveRarest(JSON.parse(fs.readFileSync(input,'utf8')));
  fs.mkdirSync(output,{mode:0o700});fs.mkdirSync(path.join(output,'metadata'),{mode:0o700});
  result.metadata.forEach((m,i)=>fs.writeFileSync(path.join(output,'metadata',`${String(i).padStart(4,'0')}.json`),JSON.stringify(m),{mode:0o600}));
  fs.writeFileSync(path.join(output,'private-ranking.json'),JSON.stringify(result.ranking),{mode:0o600});
  fs.writeFileSync(path.join(output,'private-top50.json'),JSON.stringify(result.ranking.slice(0,50)),{mode:0o600});
  console.log('PRIVATE_RESERVATION_VERIFIED: token 0 is the unique highest score; no upload performed.');
}
