// Read-only Mainnet rent estimate; no keypair files, signing or sending.
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createNoopSigner, publicKey, signerIdentity, some } from '@metaplex-foundation/umi';
import { mplCore } from '@metaplex-foundation/mpl-core';
import { mplCandyMachine, getCandyMachineSize } from '@metaplex-foundation/mpl-core-candy-machine';
import { LAUNCH_OWNER, launchPlan, launchCollectionBuilder, launchMachineBuilder, launchItemsBuilder } from '../solana/launch-plan.mjs';
import { configLineSettings } from '../solana/builders.mjs';
const umi=createUmi('https://api.mainnet-beta.solana.com').use(mplCore()).use(mplCandyMachine()).use(signerIdentity(createNoopSigner(publicKey(LAUNCH_OWNER))));
const plan=launchPlan({treasury:LAUNCH_OWNER,royaltyRecipient:LAUNCH_OWNER});
// Existing public keys are placeholders for SIZE only, not deployment addresses.
const collection=createNoopSigner(publicKey('7TBBVkBziGZxGp8a8Uhv6U27fpj8gLQJP2mFE4H19dj9'));
const machine=createNoopSigner(publicKey('3cCPC8tECbbqj7j6HMLuPNF8ga8YVkrdwbRn15rjTjwu'));
const bytes=getCandyMachineSize(10000,some(configLineSettings));
const [genesis,rent,balance]=await Promise.all([umi.rpc.call('getGenesisHash',[]),umi.rpc.getRent(bytes),umi.rpc.getBalance(publicKey(LAUNCH_OWNER))]);
if(genesis!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')throw Error('Not Solana Mainnet');
const builders=[launchCollectionBuilder(umi,plan,collection),await launchMachineBuilder(umi,plan,machine,collection.publicKey),launchItemsBuilder(umi,plan,machine.publicKey,0,25)];
console.log(JSON.stringify({network:'mainnet-beta',unsigned:true,recipientProposal:LAUNCH_OWNER,ownerBalanceLamports:String(balance.basisPoints),machineAccountBytes:bytes,machineRentLamports:String(rent.basisPoints),transactionBytes:builders.map(b=>b.getTransactionSize(umi)),configLineBatches:Math.ceil(10000/25),note:'Machine rent only; collection/guard/fees/mint costs additional. No transactions sent.'},null,2));
