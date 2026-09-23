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
