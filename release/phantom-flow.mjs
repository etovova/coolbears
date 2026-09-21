import { create as createAsset, deserializeAssetV1 } from '@metaplex-foundation/mpl-core';
import { generateSigner, publicKey } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { walletAdapterIdentity } from '@metaplex-foundation/umi-signer-wallet-adapters';
import { toWeb3JsTransaction } from '@metaplex-foundation/umi-web3js-adapters';
import policy from '../metadata/policy.json' with { type: 'json' };

export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

export const TEST_NAME = 'CoolBears Phantom Devnet';
export const TEST_URI = `${policy.website}/phantom-check/nft.json`;
export const CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const ensure = (condition, message) => { if (!condition) throw Error(message); };
const cancelled = error => error?.code === 4001 || error?.error?.code === 4001 || error?.cause?.code === 4001;

// The wallet signs AND sends. Persist the new asset address before invoking it.
// Recovery checks that same account; an unknown wallet response never mints again.
export function phantomCheck({ umi, wallet, store, send, readHeight,
  expectedOwner = policy.owner, progress = () => {}, now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  walletDeadlineMs = 120000, confirmationMs = 45000 }) {
  umi.use(walletAdapterIdentity(wallet));
  let pending;
  const owner = publicKey(expectedOwner);
  const currentOwner = () => {
    ensure(wallet.publicKey?.toString() === owner, 'WRONG_WALLET');
    return owner;
  };
  async function network() {
    currentOwner(); progress('network');
    ensure(await umi.rpc.getGenesisHash() === DEVNET_GENESIS, 'WRONG_NETWORK');
  }
  function validate(state) {
    ensure(state.version === 1 && state.owner === owner && state.network === 'devnet', 'INVALID_SAVED_STATE');
    publicKey(state.asset);
  }
  async function inspect(state) {
    validate(state); progress('confirming');
    const status = state.signature
      ? (await umi.rpc.getSignatureStatuses([base58.serialize(state.signature)], { searchTransactionHistory: true }))[0]
      : null;
    const raw = await umi.rpc.getAccount(publicKey(state.asset), { commitment: 'finalized',
      ...(status?.commitment === 'finalized' ? { minContextSlot: Number(status.slot) } : {}) });
    if (raw.exists) {
      ensure(raw.owner === CORE_PROGRAM, 'UNEXPECTED_ASSET_PROGRAM');
      const asset = deserializeAssetV1(raw);
      ensure(asset.owner === owner && asset.name === TEST_NAME && asset.uri === TEST_URI, 'UNEXPECTED_ASSET_STATE');
      ensure(!status?.error, 'UNEXPECTED_TRANSACTION_STATE');
      if (state.signature && status?.commitment !== 'finalized') return state;
      return store.patch(state.asset, { phase: 'verified', verifiedAt: new Date(now()).toISOString() });
    }
    if (state.phase === 'verified') throw Error('VERIFIED_ASSET_MISSING');
    if (status?.error) {
      if (status.commitment === 'finalized') return store.patch(state.asset, { phase: 'failed', chainError: JSON.stringify(status.error) });
      return state;
    }
    if (status?.commitment === 'finalized') throw Error('VERIFIED_ASSET_MISSING');
    // Read finalized height BEFORE a second finalized absence check. Never
    // discard an intent based only on elapsed time or an RPC timeout.
    const height = await readHeight();
    ensure(Number.isSafeInteger(height.slot) && Number.isSafeInteger(height.blockHeight), 'INVALID_FINALIZED_HEIGHT');
    if (BigInt(height.blockHeight) > BigInt(state.lastValidBlockHeight)) {
      const final = await umi.rpc.getAccount(publicKey(state.asset), { commitment: 'finalized', minContextSlot: height.slot });
      if (!final.exists && (!status || status.error)) return store.patch(state.asset, { phase: 'expired' });
    }
    return state;
  }
  async function check() {
    await network();
    const state = await store.load();
    return state ? inspect(state) : null;
  }
  async function startOnce() {
    await network();
    const existing = await store.load();
    if (existing) return inspect(existing);
    progress('preparing');
    // Do not leave a queued blockhash request running after a balance failure.
    const balance = await umi.rpc.getBalance(owner, { commitment: 'finalized' });
    ensure(balance.basisPoints >= 10000000n, 'NEED_TEST_SOL');
    const initialBlockhash = await umi.rpc.getLatestBlockhash({ commitment: 'confirmed' });
    const asset = generateSigner(umi);
    const builder = createAsset(umi, { asset, owner, name: TEST_NAME, uri: TEST_URI,
      plugins: [{ type: 'Royalties', basisPoints: policy.royaltyPercent * 100,
        creators: [{ address: owner, percentage: 100 }], ruleSet: { __kind: 'None' } }]
    }).useLegacyVersion().setBlockhash(initialBlockhash);
    let partial = await asset.signTransaction(builder.build(umi));
    ensure(umi.transactions.serialize(partial).length <= 1232, 'TRANSACTION_TOO_LARGE');
    const simulation = await umi.rpc.simulateTransaction(partial, { commitment: 'confirmed', verifySignatures: false });
    ensure(!simulation.err, 'SIMULATION_FAILED');
    currentOwner();
    // Start the wallet prompt with a fresh validity window after simulation.
    const blockhash = await umi.rpc.getLatestBlockhash({ commitment: 'confirmed' });
    partial = await asset.signTransaction(builder.setBlockhash(blockhash).build(umi));
    currentOwner();
    const candidate = { version: 1, network: 'devnet', owner, asset: asset.publicKey,
      phase: 'awaiting-wallet', lastValidBlockHeight: String(blockhash.lastValidBlockHeight),
      startedAt: new Date(now()).toISOString() };
    // The store's claim is atomic across tabs. Only its winner may prompt.
    const claimed = await store.claim(candidate);
    if (claimed.asset !== candidate.asset) return inspect(claimed);
    currentOwner(); progress('wallet');
    let timer;
    try {
      const sending = Promise.resolve().then(() => { currentOwner(); return send(toWeb3JsTransaction(partial)); })
        .then(async signature => {
          ensure(base58.serialize(signature).length === 64, 'INVALID_SIGNATURE');
          return store.patch(candidate.asset, { signature, phase: 'submitted' });
        });
      // The continuation still saves a late wallet response after this deadline.
      await Promise.race([sending, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('WALLET_RESULT_UNKNOWN')), walletDeadlineMs);
      })]);
    } catch (error) {
      const saved = await store.load();
      if (cancelled(error) && !saved?.signature) {
        return store.patch(candidate.asset, { phase: 'cancelled' });
      }
      // Preserve the intent and any signature even after an ambiguous error.
      throw error;
    } finally { clearTimeout(timer); }
    const deadline = now() + confirmationMs;
    do {
      const result = await inspect(await store.load());
      if (['verified', 'failed', 'expired'].includes(result.phase)) return result;
      await wait(2000);
    } while (now() < deadline);
    return store.load();
  }
  return {
    start() {
      if (!pending) pending = startOnce().finally(() => { pending = null; });
      return pending;
    },
    check,
    async retry() {
      await network();
      const state = await store.load();
      if (state) {
        validate(state);
        const result = state.phase === 'cancelled' ? state : await inspect(state);
        ensure(['cancelled', 'expired', 'failed'].includes(result.phase), 'RESULT_STILL_PENDING');
        await store.removeIf(state.asset, result.phase);
      }
      return this.start();
    },
  };
}
