// Disposable wallet only; checkPrepared uses the actual HTTPS transport.
import './buyer-signing-browser.mjs';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import {createBuyerWalletClient} from '../../orders/wallet-client.mjs';
import {createBuyerCheckClient} from '../../orders/gateway/client.mjs';
window.walletCalls=0;
window.openGatewayClient=async(scope,secret)=>{
  window.costConsent=null;
  const buyer=Keypair.fromSecretKey(new Uint8Array(secret));
  const account={address:buyer.publicKey.toBase58(),publicKey:buyer.publicKey.toBytes(),chains:['solana:devnet'],features:['solana:signTransaction']};
  const wallet={name:'Disposable gateway fixture',accounts:[account],chains:['solana:devnet'],features:{
    'standard:connect':{connect:async()=>({accounts:[account]})},'standard:events':{on:()=>()=>{}},
    'solana:signTransaction':{supportedTransactionVersions:[0],signTransaction:async input=>{
      window.walletCalls++;if(input.account!==account||input.chain!=='solana:devnet')throw Error('WRONG_INPUT');
      const saved=await store.readBuyerResponse(scope);if(saved.status!=='wallet-response-unknown'||!saved.claim.costApproval)throw Error('WALLET_BEFORE_CLAIM');
      const tx=VersionedTransaction.deserialize(input.transaction);tx.sign([buyer]);
      if(window.discardWalletResponse){window.fixtureSignedBytes=Buffer.from(tx.serialize()).toString('base64');throw Error('fixture lost wallet response');}
      return[{signedTransaction:tx.serialize()}];
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
      saveBuyerProof:async(...args)=>{const value=await store.saveBuyerProof(...args);if(window.loseProofAck)throw Error('LOST_PROOF_ACK');return value;},
      saveBuyerFailure:async(...args)=>{const value=await store.saveBuyerFailure(...args);if(window.loseFailureAck)throw Error('LOST_FAILURE_ACK');return value;},
      saveBuyerExpiry:async(...args)=>{const value=await store.saveBuyerExpiry(...args);if(window.loseExpiryAck)throw Error('LOST_EXPIRY_ACK');return value;}},
    transport:{recover:transport.recover,reviewExpiry:transport.reviewExpiry,replace:transport.replace,send:async(input,approval)=>{
      const saved=await store.readBuyerSubmission(scope);if(saved.status!=='send-claimed'||saved.input.order.revision!==input.order.revision)throw Error('HTTP_BEFORE_CLAIM');
      return transport.send(input,approval);
    }}});
};
const add=IDBObjectStore.prototype.add;
IDBObjectStore.prototype.add=function(value,key){if(this.name==='events'&&value.type==='reconcile'&&window.failProofWrite)throw new DOMException('fixture quota','QuotaExceededError');return add.call(this,value,key);};

import {createBuyerPreparationClient} from '../../orders/gateway/preparation-client.mjs';
window.prepareThroughGateway=createBuyerPreparationClient();

window.approveFixtureCost=async()=>{const quote=await client.quoteCost();window.costConsent={authorizeCost:true,quoteId:quote.quoteId,maxTotalLamports:quote.budget.totalLamports};return quote;};

import {createBuyerResponseRecovery} from '../../orders/response-recovery-client.mjs';
window.openResponseRecovery=scope=>{
  window.responseRecovery=createBuyerResponseRecovery({scope,transport:createBuyerSubmissionTransport(),storage:{
    readBuyerResponseRecovery:store.readBuyerResponseRecovery,
    saveRecoveredBuyerResponse:async(...args)=>{const value=await store.saveRecoveredBuyerResponse(...args);
      if(window.loseResponseRecoveryAck)throw Error('LOST_RESPONSE_RECOVERY_ACK');return value;}}});
};
window.responseTransport=createBuyerSubmissionTransport();

import {createBuyerPrewalletRecovery} from '../../orders/prewallet-recovery-client.mjs';
window.openPrewalletRecovery=scope=>{
  window.prewalletRecovery=createBuyerPrewalletRecovery({scope,transport:createBuyerSubmissionTransport(),storage:{
    readPrewalletRecovery:store.readPrewalletRecovery,
    readPrewalletReplacement:store.readPrewalletReplacement,
    savePrewalletRecovery:async(...args)=>{const value=await store.savePrewalletRecovery(...args);
      if(window.losePrewalletAck)throw Error('LOST_PREWALLET_ACK');return value;}}});
};
// Synthetic externally observed transaction only. Never used by the application,
// never broadcast; it reuses the disposable native signature captured by this fixture.
window.observedPrewalletBytes=async(scope,secret)=>{
  const state=await store.readPrewalletRecovery(scope),tx=VersionedTransaction.deserialize(Buffer.from(state.input.claim.transactionBase64,'base64'));
  tx.signatures[1]=new Uint8Array(window.lastNativeSignature);tx.sign([Keypair.fromSecretKey(new Uint8Array(secret))]);
  return Buffer.from(tx.serialize()).toString('base64');
};
