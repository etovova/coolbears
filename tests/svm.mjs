import { LiteSVM, FailedTransactionMetadata } from 'litesvm';
import { getTransactionDecoder } from '@solana/kit';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { generateSigner, signerIdentity, lamports } from '@metaplex-foundation/umi';
import { mplCore } from '@metaplex-foundation/mpl-core';
import { mplCandyMachine } from '@metaplex-foundation/mpl-core-candy-machine';
import { PROGRAMS } from '../chain/spec.mjs';
export function environment() {
  const svm = new LiteSVM();
  for (const [name, address] of Object.entries(PROGRAMS)) svm.addProgramFromFile(address, `private/programs/${name}.so`);
  const umi = createUmi('http://127.0.0.1:8899').use(mplCore()).use(mplCandyMachine());
  const owner = generateSigner(umi), buyer = generateSigner(umi);
  svm.airdrop(owner.publicKey, 100000000000000n);
  svm.airdrop(buyer.publicKey, 100000000000000n);
  umi.use(signerIdentity(owner));
  const account = async address => {
    const a = svm.getAccount(address);
    return a.exists ? { publicKey: address, exists: true, data: a.data, executable: a.executable,
      owner: a.programAddress, lamports: lamports(a.lamports), rentEpoch: 0n } : { publicKey: address, exists: false };
  };
  umi.rpc = { ...umi.rpc, getAccount: account, getAccounts: addresses => Promise.all(addresses.map(account)),
    getRent: async size => lamports(svm.minimumBalanceForRentExemption(BigInt(size))),
    getLatestBlockhash: async () => ({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: 10000n }) };
  async function send(builder, expectFailure = false) {
    const tx = await builder.setBlockhash(svm.latestBlockhash()).buildAndSign(umi);
    const bytes = umi.transactions.serialize(tx);
    if (bytes.length > 1232) throw Error(`Transaction too large: ${bytes.length}`);
    const result = svm.sendTransaction(getTransactionDecoder().decode(bytes));
    // Failed transactions are recorded too. A new user attempt uses a fresh
    // blockhash, as it would after the closed-sale guard is changed on-chain.
    svm.expireBlockhash();
    if (!expectFailure && result instanceof FailedTransactionMetadata) throw Error(`${result.err()}\n${result.meta().logs().join('\n')}`);
    if (expectFailure && !(result instanceof FailedTransactionMetadata)) throw Error('Expected transaction rejection');
    return { result, bytes: bytes.length };
  }
  return { svm, umi, owner, buyer, send };
}
