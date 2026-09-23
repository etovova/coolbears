// Test-only Wallet Standard and trusted-check fixtures; never a live integration.
import './buyer-signing-browser.mjs';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { createBuyerWalletClient } from '../../orders/wallet-client.mjs';
import { buyerRequestId } from '../../orders/signing.mjs';
window.walletCalls=0;window.checkCalls=0;window.walletObservations=[];window.fakePersisted=true;
async function openClient(scope, {walletSeed=1,walletTimeoutMs=3000}={}) {
  const buyer=Keypair.fromSeed(new Uint8Array(32).fill(walletSeed));let changed;
  const account={address:buyer.publicKey.toBase58(),publicKey:buyer.publicKey.toBytes(),chains:['solana:devnet'],features:['solana:signTransaction']};
  const wallet={name:'Disposable fixture',chains:['solana:devnet'],accounts:[account],features:{
    'standard:connect':{connect:async()=>({accounts:[account]})},
    'standard:events':{on:(_event,callback)=>{changed=callback;return()=>{changed=null;};}},
    'solana:signAndSendTransaction':{signAndSendTransaction:()=>{throw Error('SEND_FORBIDDEN');}},
    'solana:signTransaction':{supportedTransactionVersions:[0],signTransaction:async input=>{
      window.walletCalls++;if(input.chain!=='solana:devnet'||input.account!==account)throw Error('WRONG_WALLET_INPUT');
      const key=scopeKey(scope),order=await raw(['orders'],'readonly',tx=>tx.objectStore('orders').get(key));
      const rows=await raw(['signing'],'readonly',tx=>tx.objectStore('signing').getAll(IDBKeyRange.bound([key],[key,[]])));
      const observation={revision:order.revision,state:order.items[0].attempts[0].state,phases:rows.map(r=>r.phase)};
      window.walletObservations.push(observation);
      if(order.revision!==2||observation.state!=='unknown'||rows.length!==3||rows[2].phase!=='wallet-claimed')throw Error('WALLET_BEFORE_COMMIT');
      window.walletEntered=true;
      if(window.walletMode==='reject')throw Object.assign(Error('fixture rejected'),{code:4001});
      if(window.walletMode==='throw')throw Error('fixture transport failed');
      if(window.walletMode==='hold')await new Promise(resolve=>window.releaseWallet=resolve);
      const tx=VersionedTransaction.deserialize(input.transaction);
      if(window.walletMode==='tamper')tx.message.compiledInstructions[0].data[1]^=1;
      tx.sign([buyer]);
      if(window.walletMode==='storage-unavailable')window.storageUnavailable=true;
      if(window.walletMode==='account-change'){wallet.accounts=[];changed?.({accounts:[]});}
      return [{signedTransaction:tx.serialize()}];
    }},
  }};
  const checked=async({order,claim,request})=>{
    window.checkCalls++;
    const now=Date.now();
    const report={status:'wallet-check-passed',mode:'closed-devnet-sign-only-check',cluster:'devnet',orderId:order.id,
      orderRevision:order.revision,orderSha256:bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(order)))),
      requestId:buyerRequestId(request),candidate:{...request},quantity:order.quantity,itemIndex:0,
      networkVerified:true,guardPriceVerified:true,blockhashVerified:true,simulationVerified:true,simulationMode:'unsigned',
      checkedSlot:600,checkedAt:now,expiresAt:now+20000,readyToSign:true,readyToSubmit:false,salesOpen:false};
    if(window.checkMode==='expired')report.expiresAt=now-1;
    if(window.checkMode==='altered')report.candidate.messageSha256='0'.repeat(64);
    if(window.checkMode==='account-change'){wallet.accounts=[];changed?.({accounts:[]});}
    if(window.checkMode==='hold'){window.checkEntered=true;await new Promise(resolve=>window.releaseCheck=resolve);}
    return report;
  };
  const wrapped={read:async(...args)=>{if(window.storageUnavailable)throw Error('STORAGE_UNAVAILABLE');return store.read(...args);},readAssetSigning:store.readAssetSigning,readBuyerResponse:store.readBuyerResponse,
    claimBuyerWallet:store.claimBuyerWallet,
    saveBuyerResponse:async(...args)=>{if(window.storageUnavailable)throw Error('STORAGE_UNAVAILABLE');const result=await store.saveBuyerResponse(...args);if(window.loseAck)throw Error('LOST_ACK');return result;}};
  window.fakeWallet=wallet;window.walletChanged=()=>{wallet.accounts=[];changed?.({accounts:[]});};
  window.client=createBuyerWalletClient({storage:wrapped,scope,checkPrepared:checked,walletTimeoutMs,
    storageManager:{persisted:async()=>window.fakePersisted,persist:async()=>window.fakePersisted}});
  await client.load();await client.connect(wallet);return client.state();
}
Object.assign(window,{openClient,buyerRequestId});
