// Disposable wallet only; checkPrepared uses the actual HTTPS transport.
import './buyer-signing-browser.mjs';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import {createBuyerWalletClient} from '../../orders/wallet-client.mjs';
import {createBuyerCheckClient} from '../../orders/gateway/client.mjs';
window.walletCalls=0;
window.openGatewayClient=async(scope,secret)=>{
  const buyer=Keypair.fromSecretKey(new Uint8Array(secret));
  const account={address:buyer.publicKey.toBase58(),publicKey:buyer.publicKey.toBytes(),chains:['solana:devnet'],features:['solana:signTransaction']};
  const wallet={name:'Disposable gateway fixture',accounts:[account],chains:['solana:devnet'],features:{
    'standard:connect':{connect:async()=>({accounts:[account]})},'standard:events':{on:()=>()=>{}},
    'solana:signTransaction':{supportedTransactionVersions:[0],signTransaction:async input=>{
      window.walletCalls++;if(input.account!==account||input.chain!=='solana:devnet')throw Error('WRONG_INPUT');
      const saved=await store.readBuyerResponse(scope);if(saved.status!=='wallet-response-unknown')throw Error('WALLET_BEFORE_CLAIM');
      const tx=VersionedTransaction.deserialize(input.transaction);tx.sign([buyer]);return[{signedTransaction:tx.serialize()}];
    }},'solana:signAndSendTransaction':{signAndSendTransaction:()=>{throw Error('SEND_FORBIDDEN');}}
  }};
  window.client=createBuyerWalletClient({storage:store,scope,checkPrepared:createBuyerCheckClient(),walletTimeoutMs:3000,
    storageManager:{persisted:async()=>true,persist:async()=>true}});
  await client.load();await client.connect(wallet);return client.state();
};

import {createBuyerSender} from '../../orders/sender.mjs';
import {createBuyerSubmissionTransport} from '../../orders/gateway/submission-client.mjs';
window.openSender=scope=>{
  const transport=createBuyerSubmissionTransport();
  window.sender=createBuyerSender({scope,storageManager:{persisted:async()=>window.sendPersisted!==false},
    storage:{readBuyerSubmission:store.readBuyerSubmission,
      claimBuyerSubmission:async(...args)=>{const value=await store.claimBuyerSubmission(...args);if(window.loseSendClaimAck)throw Error('LOST_CLAIM_ACK');return value;},
      saveBuyerProof:async(...args)=>{const value=await store.saveBuyerProof(...args);if(window.loseProofAck)throw Error('LOST_PROOF_ACK');return value;}},
    transport:{recover:transport.recover,send:async input=>{
      const saved=await store.readBuyerSubmission(scope);if(saved.status!=='send-claimed'||saved.input.order.revision!==input.order.revision)throw Error('HTTP_BEFORE_CLAIM');
      return transport.send(input);
    }}});
};
const add=IDBObjectStore.prototype.add;
IDBObjectStore.prototype.add=function(value,key){if(this.name==='events'&&value.type==='reconcile'&&window.failProofWrite)throw new DOMException('fixture quota','QuotaExceededError');return add.call(this,value,key);};

import {createBuyerPreparationClient} from '../../orders/gateway/preparation-client.mjs';
window.prepareThroughGateway=createBuyerPreparationClient();
