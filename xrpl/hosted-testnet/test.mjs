import test from 'node:test';
import a from 'node:assert/strict';
import {generateSeed,deriveAddress,deriveKeypair,sign} from 'ripple-keypairs';
import {challenge,proof,validIdentity} from './proof.mjs';
import {hex,utf8,ISSUER,ORIGIN,PRICE} from './common.mjs';
import {newOffer} from './ledger.mjs';
import {DatabaseSync} from 'node:sqlite';
import {deflateSync} from 'node:zlib';
import {initialize,Journal} from './journal.mjs';
import signer from './issuer.mjs';

test('reservation binds buyer, request, public site, nonce and lifetime',async()=>{
  const k=deriveKeypair(generateSeed()), buyer=deriveAddress(k.publicKey);
  const input={buyer,request:crypto.randomUUID()};
  a.ok(validIdentity(input));a.equal(validIdentity({...input,buyer:ISSUER}),false);
  const c=await challenge(input,'unit-secret',1000);
  a.ok(c.message.includes(ORIGIN));
  const signed={...input,...c,publicKey:k.publicKey,signature:sign(hex(utf8(c.message)),k.privateKey)};
  a.ok(await proof(signed,'unit-secret',1010));
  for (const change of [{request:crypto.randomUUID()},{nonce:'0'.repeat(32)},{buyer:ISSUER},{signature:'A'.repeat(128)}])
    a.equal(await proof({...signed,...change},'unit-secret',1010),false);
  a.equal(await proof(signed,'unit-secret',1240),false);
  a.equal((await signer.fetch(new Request(ORIGIN+'/mint',{method:'POST'}),{})).status,404);
});

test('mint requires a single personal 10 XRP sell offer',()=>{
  const draft={Destination:'buyer',Expiration:100};
  const f={Owner:ISSUER,Flags:1,Destination:'buyer',Amount:PRICE,Expiration:100,NFTokenID:'2'.repeat(64)};
  const node={LedgerEntryType:'NFTokenOffer',LedgerIndex:'3'.repeat(64),NewFields:f};
  const meta={AffectedNodes:[{CreatedNode:node}]};
  a.equal(newOffer(meta,draft).token,f.NFTokenID);
  for (const change of [{Destination:null},{Amount:'1'},{Owner:'other'}]) {
    node.NewFields={...f,...change};a.throws(()=>newOffer(meta,draft));
  }
});

test('restores completed orders once and reuses released inventory',async()=>{
  const db=new DatabaseSync(':memory:');
  const storage={sql:{exec(sql,...args){const stmt=db.prepare(sql);const rows=stmt.all(...args);return {toArray:()=>rows};}},
    transactionSync(fn){db.exec('BEGIN');try{const val=fn();db.exec('COMMIT');return val;}catch(e){db.exec('ROLLBACK');throw e;}}};
  const hash=i=>i.toString(16).padStart(64,'0').toUpperCase();
  const slot=Array.from({length:7},(_,n)=>({n,state:n<3?'previous':'sold',token:n<3?null:hash(n),mint:n<3?null:hash(n+10)}));
  const orders=slot.slice(3).map(({n})=>({id:'old'+n,buyer:'buyer'+n,n,phase:'sold',expires:0,offer:hash(n+20),ledger:12,payment:hash(n+30)}));
  const signed=orders.map(o=>({hash:hash(o.n+10),request:o.id,blob:'old',draft:'{}',first_ledger:11,result:'tesSUCCESS',ledger:12}));
  await initialize(storage,deflateSync(JSON.stringify({slot,orders,signed,setup:[{previous:3}]})).toString('base64'));
  const j=new Journal(storage);a.equal(j.order('old6').phase,'sold');
  const r=j.claim('new','first',30);a.equal(r.n,7);
  a.throws(()=>j.claim('new','again',30));
  await initialize(storage,null);
  j.close(r,null);
  a.equal(j.claim('another','next',500).n,7);
});
