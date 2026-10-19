// Disposable, genuinely signed unrelated transactions; all RPC remains intercepted.
import {SystemProgram,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {base58} from '@metaplex-foundation/umi/serializers';
export function prewalletExpiryFixture(f){
  const upstream=f.upstream;let enabled=false,edit,rows=[],transactions=new Map();
  function history(slots=[850,599]){
    transactions=new Map();rows=slots.map((slot,i)=>{
      const message=new TransactionMessage({payerKey:f.owner.publicKey,recentBlockhash:f.key('unrelated-expiry-'+i).publicKey.toBase58(),
        instructions:[SystemProgram.transfer({fromPubkey:f.owner.publicKey,toPubkey:f.key('history-recipient-'+i).publicKey,lamports:1})]});
      const tx=new VersionedTransaction(i%2?message.compileToLegacyMessage():message.compileToV0Message());tx.sign([f.owner]);
      const signature=base58.deserialize(tx.signatures[0])[0],row={signature,slot,err:null,confirmationStatus:'finalized'};
      transactions.set(signature,{slot,version:tx.version,transaction:[Buffer.from(tx.serialize()).toString('base64'),'base64'],meta:{err:null}});return row;
    });
  }
  history();
  f.upstream=async(request,ResponseType=Response)=>{
    if(!enabled)return upstream(request,ResponseType);
    const call=await request.clone().json(),response=await upstream(request,ResponseType),body=await response.json();
    if(call.method==='getSignaturesForAddress'&&call.params[0]===f.policy.owner){
      const start=call.params[1].before?rows.findIndex(r=>r.signature===call.params[1].before)+1:0;
      body.result=rows.slice(start,start+call.params[1].limit);
    }
    if(call.method==='getTransaction')body.result=structuredClone(transactions.get(call.params[0])??null);
    edit?.(call,body);
    return new ResponseType(JSON.stringify(body),{headers:{'content-type':'application/json'}});
  };
  return{set(value=true){enabled=value;f.setMode(value?'expiry-clear':'normal');},history,
    rewrite(value){edit=value;},get rows(){return structuredClone(rows);},get transactions(){return structuredClone(transactions);}};
}
