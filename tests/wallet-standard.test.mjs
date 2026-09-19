import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, Transaction, SystemProgram } from '@solana/web3.js';
import { standardOptions } from '../wallet/standard.mjs';
import { getWalletOptions, createWalletSession } from '../wallet-core.mjs';

test('Standard discovery, connection, real legacy transaction signing and account changes', async t => {
 const previous = globalThis.window, previousDocument = globalThis.document; globalThis.window = {}; globalThis.document = {}; t.after(() => { globalThis.window = previous; globalThis.document = previousDocument; });
 const key = Keypair.generate(), second = Keypair.generate();
 let changed, signed = 0;
 const account = k => ({ address: k.publicKey.toBase58(), publicKey: k.publicKey.toBytes(), chains: ['solana:devnet'], features: ['solana:signTransaction'] });
 const wallet = { version: '1.0.0', name: 'Backpack', icon: 'data:image/png;base64,', chains: ['solana:devnet'], accounts: [], features: {
  'standard:connect': { version:'1.0.0', async connect() { wallet.accounts = [account(key)]; return {accounts:wallet.accounts}; } },
  'standard:disconnect': { version:'1.0.0', async disconnect() { wallet.accounts=[]; } },
  'standard:events': { version:'1.0.0', on(event, callback) { changed=callback; return () => {}; } },
  'solana:signTransaction': { version:'1.0.0', supportedTransactionVersions:['legacy',0], async signTransaction(...inputs) { signed++; return inputs.map(input => { const tx=Transaction.from(input.transaction); tx.partialSign(key); return {signedTransaction:new Uint8Array(tx.serialize())}; }); } }
 }};
 const opts=standardOptions([wallet, {...wallet, name:'EVM',chains:['eip155:1']}, {...wallet,name:'SendOnly', features:{}}]);
 assert.deepEqual(opts.map(x=>x.name),['Backpack']);
 assert.equal(standardOptions([wallet])[0].provider,opts[0].provider);
 const merged=getWalletOptions({},'https://coolbears-nfts.com/',false,opts);
 assert.deepEqual(merged.map(x=>x.name),['Phantom','Solflare','Backpack']);
 const session=createWalletSession(); await session.connect(opts[0].provider);
 assert.equal(session.address,key.publicKey.toBase58()); assert.equal(signed,0);
 const tx=new Transaction({feePayer:key.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58()}).add(SystemProgram.transfer({fromPubkey:key.publicKey,toPubkey:second.publicKey,lamports:1}));
 const result=await session.provider.signTransaction(tx);
 assert.equal(result.verifySignatures(),true); assert.equal(signed,1);
 wallet.accounts=[account(second)]; changed({accounts:wallet.accounts});
 assert.equal(session.address,second.publicKey.toBase58());
 await session.disconnect(); assert.equal(session.address,'');
});
