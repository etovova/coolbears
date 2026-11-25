import {encode} from 'ripple-binary-codec';
import {signingFields, signOrder} from './delegate.mjs';
import {assert, bytes, hex, ID, ISSUER, json, METADATA, PRICE, utf8} from './common.mjs';
import {entry, matchOffer, newOffer, read, removal, rpc, snapshot} from './ledger.mjs';
import {Journal, initialize} from './journal.mjs';
import {challenge, proof, validIdentity} from './proof.mjs';

const waiting = () => json({state:'preparing'},202);
export class MintJournal {
  constructor(ctx,env) {
    this.ctx=ctx;
    this.env=env;
    this.queue=Promise.resolve();
    this.queued=0;
    ctx.blockConcurrencyWhile(() => initialize(ctx.storage,env.CHECKPOINT));
    this.journal=new Journal(ctx.storage);
  }
  async fetch(req) {
    const input = await req.json();
    const record = new URL(req.url).pathname === '/receipt';
    const {buyer,request} = input;
    if (!record && !validIdentity({buyer,request})) return json({error:'Invalid reservation'},400);
    if (this.queued >= 12) return json({error:'Testnet is busy. Retry the same order.'},429);
    this.queued++;
    const run=this.queue.then(() => record ? this.receipt(input) : this.reserve(buyer,request));
    this.queue=run.catch(() => {});
    try { return await run; } finally { this.queued--; }
  }
  async receipt({buyer,offer,token,hash}) {
    const j=this.journal;
    const order=j.first('SELECT id FROM orders WHERE offer=?',offer);
    if (!order) return json({saved:false, historical:true});
    const row=j.order(order.id);
    assert(row.buyer===buyer && row.token===token && ID.test(hash));
    if (row.phase==='sold') {assert(row.payment===hash);return json({saved:true});}
    const tx=await rpc('tx',{transaction:hash});
    assert(row.phase==='open' && tx.validated && tx.hash===hash && tx.meta.TransactionResult==='tesSUCCESS' &&
      tx.tx_json.TransactionType==='NFTokenAcceptOffer' && tx.tx_json.Account===buyer && tx.tx_json.NFTokenSellOffer===offer &&
      !tx.tx_json.NFTokenBuyOffer && !tx.tx_json.NFTokenBrokerFee);
    const n=tx.meta.AffectedNodes.find(n => n.DeletedNode?.LedgerIndex===offer)?.DeletedNode;
    assert(n?.LedgerEntryType==='NFTokenOffer');
    matchOffer(n.FinalFields,row);
    j.close(row,hash);
    return json({saved:true});
  }
  async stage(row, ledger, cancelling=false) {
    const j=this.journal;
    const root=(await read('account_info',ledger,{account:ISSUER})).account_data;
    const expected=j.first('SELECT (SELECT previous FROM setup)+COUNT(mint) AS n FROM slot').n;
    assert(root.Account === ISSUER && root.MintedNFTokens === expected,'Issuer inventory changed');
    const fee=(await rpc('fee')).drops.open_ledger_fee;
    assert(/^(?:[1-9]\d?|100)$/.test(fee),'Testnet fee is above the limit');
    let fields;
    if (cancelling) {
      assert(row.phase === 'open' && row.expires <= ledger.close && ID.test(row.offer));
      fields={TransactionType:'NFTokenCancelOffer',NFTokenOffers:[row.offer]};
    } else {
      assert(row.phase === 'held' && row.n >= 0 && row.n < 10000);
      fields=row.token ? {TransactionType:'NFTokenCreateOffer',Flags:1,NFTokenID:row.token} :
        {TransactionType:'NFTokenMint',Flags:8,TransferFee:7000,NFTokenTaxon:20270201,
          URI:hex(utf8(METADATA+'/xrpl/metadata/'+String(row.n).padStart(4,'0')+'.json'))};
      Object.assign(fields,{Amount:PRICE,Destination:row.buyer,Expiration:ledger.close+600});
    }
    const signer=signingFields(fields.TransactionType,this.env.TESTNET_DELEGATE_PUBLIC_KEY);
    const source=cancelling ? (await read('account_info',ledger,{account:signer.Account})).account_data : root;
    assert(source.Account===signer.Account);
    const draft={...signer,Sequence:source.Sequence,LastLedgerSequence:ledger.seq+32,Fee:fee,...fields};
    const sim=await rpc('simulate',{tx_json:draft});
    assert(sim.applied === false && sim.engine_result === 'tesSUCCESS','Testnet simulation: '+sim.engine_result);
    if (cancelling) {
      const node=sim.meta.AffectedNodes.find(n => n.DeletedNode?.LedgerIndex === row.offer)?.DeletedNode;
      matchOffer(node?.FinalFields,row);
    } else newOffer(sim.meta,draft);
    const tx=await signOrder(draft,this.env.TESTNET_DELEGATE_PRIVATE_KEY);
    const blob=encode(tx);
    const hash=hex(new Uint8Array(await crypto.subtle.digest('SHA-512',bytes('54584E00'+blob))).slice(0,32));
    j.exec('INSERT INTO signed(hash,request,blob,draft,first_ledger) VALUES(?,?,?,?,?)',
      hash,row.id,blob,JSON.stringify(draft),ledger.seq);
    await rpc('submit',{tx_blob:blob});
  }
  async resume(p, ledger) {
    const j=this.journal, draft=JSON.parse(p.draft), end=draft.LastLedgerSequence;
    const range=ledger.seq>end?{min_ledger:p.first_ledger,max_ledger:end}:{};
    const tx=await rpc('tx',{transaction:p.hash,...range},['txnNotFound']);
    if (!tx.validated) {
      if (ledger.seq>end) {
        assert(tx.error==='txnNotFound' && tx.searched_all === true,'Awaiting complete Testnet history');
        const root=(await read('account_info',ledger,{account:draft.Account})).account_data;
        assert(root.Sequence === draft.Sequence,'Issuer sequence requires reconciliation');
        j.exec("UPDATE signed SET result='notApplied' WHERE hash=?",p.hash);
        return true;
      }
      await rpc('submit',{tx_blob:p.blob});
      return false;
    }
    assert(tx.hash === p.hash && tx.ledger_index <= end && tx.ledger_index >= p.first_ledger);
    for (const [k,v] of Object.entries(draft)) assert(JSON.stringify(tx.tx_json[k])===JSON.stringify(v),'Validated transaction differs: '+k);
    const code=tx.meta.TransactionResult, row=j.order(p.request);
    let settlement;
    if (draft.TransactionType === 'NFTokenCancelOffer') {
      const deleted=tx.meta.AffectedNodes.find(n => n.DeletedNode?.LedgerIndex === row.offer)?.DeletedNode;
      if (code === 'tesSUCCESS' && deleted) {
        matchOffer(deleted.FinalFields,row);
        settlement=null;
      } else {
        // An expired offer can be removed by another account while our cancellation is pending.
        if (ledger.seq < tx.ledger_index) return false;
        if (!await entry(row,ledger)) settlement=await removal(row,ledger);
        else assert(code!=='tesSUCCESS','Cancellation left the offer on the ledger');
      }
    }
    j.storage.transactionSync(() => {
      if (settlement!==undefined) {
        j.exec('UPDATE orders SET phase=?,payment=? WHERE id=?',settlement?'sold':'expired',settlement,row.id);
        j.exec('UPDATE slot SET state=? WHERE n=?',settlement?'sold':'free',row.n);
      } else if (code === 'tesSUCCESS') {
        const o=newOffer(tx.meta,draft);
        assert(row.phase === 'held' && (!row.token || row.token === o.token));
        j.exec('UPDATE slot SET token=?,mint=COALESCE(mint,?) WHERE n=?',o.token,p.hash,row.n);
        j.exec("UPDATE orders SET phase='open',offer=?,ledger=?,expires=? WHERE id=?",o.id,tx.ledger_index,draft.Expiration,row.id);
      }
      j.exec('UPDATE signed SET result=?,ledger=? WHERE hash=?',code,tx.ledger_index,p.hash);
    });
    assert(code === 'tesSUCCESS' || settlement!==undefined,'Testnet transaction result: '+code);
    return true;
  }
  async refresh(row, ledger) {
    if (row.phase==='held' && ledger.close>=row.expires) this.journal.close(row,null);
    if (row.phase!=='open') return true;
    if (row.ledger>ledger.seq) return false;
    if (!await entry(row,ledger)) this.journal.close(row,await removal(row,ledger));
    else if (row.expires<=ledger.close) {
      if (row.expires===ledger.close) return false;
      await this.stage(row,ledger,true);
      return false;
    }
    return true;
  }
  async reserve(buyer,request) {
    const j=this.journal;
    let prior=j.order(request);
    if (prior && prior.buyer!==buyer) return json({error:'Order belongs to another wallet'},403);
    let l=await snapshot();
    const info=await rpc('account_info',{account:buyer,ledger_hash:l.hash},['actNotFound']);
    if (!info.validated || info.ledger_hash!==l.hash || info.account_data?.Account!==buyer ||
       (info.account_data.Flags & 0x00100000)) return json({error:'A funded Testnet wallet with an enabled master key is required.'},403);
    const pending=j.pending();
    if (pending) {
      if (!await this.resume(pending,l)) return waiting();
      l=await snapshot();
    }
    const active=j.first("SELECT id FROM orders WHERE buyer=? AND phase IN ('open','held')",buyer);
    if (active && (!prior || active.id===request)) {
      if (!await this.refresh(j.order(active.id),l)) return waiting();
      const current=j.order(active.id);
      if (current.phase==='open' || current.phase==='held') {
        if (current.id!==request) return json({state:'resume',request:current.id});
        prior=current;
      }
    }
    if (prior) prior=j.order(prior.id);
    if (!prior) {
      const due=j.first("SELECT id FROM orders WHERE phase IN ('held','open') AND expires<=? ORDER BY expires LIMIT 1",l.close);
      if (due && !await this.refresh(j.order(due.id),l)) return waiting();
      if (j.first("SELECT COUNT(*) AS n FROM orders WHERE phase IN ('held','open')").n>=16)
        return json({error:'All reservations are in use. Try again shortly.'},429);
      prior=j.claim(buyer,request,l.close);
      if (!prior) return json({error:'All 10,000 NFTs are sold or reserved.'},409);
    }
    if (prior.phase==='expired') return json({state:'expired',error:'Reservation expired. Start a new mint.'},410);
    if (prior.phase==='sold') return json({state:'sold',id:prior.offer,token:prior.token,slot:prior.n,hash:prior.payment});
    if (prior.phase==='held') {
      await this.stage(prior,l);
      return waiting();
    }
    if (prior.expires<=l.close+60) return json({error:'Reservation is near expiry. Retry after it expires.'},409);
    return json({state:'open',id:prior.offer,token:prior.token,mint:prior.mint,slot:prior.n});
  }
}
export default {
  async fetch(req,env) {
    try {
      const u=new URL(req.url);
      if (u.origin !== 'https://orders.internal' || !['/mint','/challenge','/xaman-challenge','/receipt'].includes(u.pathname) || req.method !== 'POST')
        return json({error:'Unknown endpoint'},404);
      const data=await req.json();
      const actor=env.JOURNAL.get(env.JOURNAL.idFromName(ISSUER));
      if (u.pathname==='/receipt')
        return actor.fetch('https://journal.internal/receipt',{method:'POST',body:JSON.stringify(data)});
      if (!validIdentity(data)) return json({error:'Invalid wallet or order'},400);
      const now=Math.floor(Date.now()/1000);
      if (u.pathname==='/challenge' || u.pathname==='/xaman-challenge')
        return json(await challenge(data,env.CHALLENGE_KEY,now,u.pathname==='/xaman-challenge'));
      if (!await proof(data,env.CHALLENGE_KEY,now)) return json({error:'A fresh wallet signature is required.'},403);
      return await actor.fetch('https://journal.internal/reserve',{method:'POST',body:JSON.stringify({buyer:data.buyer,request:data.request})});
    } catch (err) {
      console.error('Testnet order:',err.message);
      return json({error:'Testnet mint temporarily unavailable. Retry the same order.'},503);
    }
  }
};
