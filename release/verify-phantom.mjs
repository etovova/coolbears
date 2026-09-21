// Official wallet adapter + real Core program in LiteSVM; faulted wallet/RPC
// responses are simulated. This does not certify a physical Phantom device.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { indexedDB } from 'fake-indexeddb';
import { LiteSVM, FailedTransactionMetadata } from 'litesvm';
import { getTransactionDecoder } from '@solana/kit';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { StandardWalletAdapter } from '@solana/wallet-standard-wallet-adapter-base';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { generateSigner, lamports } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { mplCore, fetchAsset } from '@metaplex-foundation/mpl-core';
import { phantomCheck, DEVNET_GENESIS, CORE_PROGRAM, TEST_NAME, TEST_URI } from './phantom-flow.mjs';
import { openPhantomStore } from './phantom-store.mjs';
globalThis.window = {}; globalThis.document = {}; globalThis.indexedDB = indexedDB;
const program = await readFile(new URL(`../private/programs/${CORE_PROGRAM}.so`, import.meta.url));
const reference = JSON.parse(await readFile(new URL('./reports/programs.json', import.meta.url)));
assert.equal(createHash('sha256').update(program).digest('hex'), reference.programs.find(p => p.program === CORE_PROGRAM).sha256);
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function fixture() {
  const vm = new LiteSVM(); vm.addProgram(CORE_PROGRAM, program);
  const umi = createUmi('https://api.devnet.solana.com').use(mplCore());
  const payer = generateSigner(umi); vm.airdrop(payer.publicKey, 1000000000n);
  const f = { vm, umi, payer, requests: 0, mode: 'ok', height: 100, genesis: DEVNET_GENESIS, statuses: new Map() };
  let change;
  const account = { address: payer.publicKey, publicKey: Keypair.fromSecretKey(payer.secretKey).publicKey.toBytes(),
    chains: ['solana:devnet'], features: ['solana:signAndSendTransaction'] };
  const wallet = { name: 'Phantom', version: '1.0.0', icon: 'data:image/svg+xml,<svg/>', chains: ['solana:devnet'], accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: wallet.accounts }) },
      'standard:events': { version: '1.0.0', on: (_, callback) => { change = callback; return () => {}; } },
      'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy'],
        signAndSendTransaction: async input => {
          f.requests++; assert.equal(input.chain, 'solana:devnet');
          assert.equal(input.account.address, payer.publicKey);
          if (f.mode === 'cancel') throw Object.assign(Error('User rejected'), { code: 4001 });
          if (f.mode === 'offline') throw Error('Wallet response unavailable');
          if (f.mode === 'late') await new Promise(resolve => { f.release = resolve; });
          const tx = VersionedTransaction.deserialize(input.transaction);
          assert.equal(tx.version, 'legacy');
          tx.sign([Keypair.fromSecretKey(payer.secretKey)]);
          const bytes = tx.serialize(); assert.ok(bytes.length <= 1232); f.packetBytes = bytes.length;
          const signature = base58.deserialize(tx.signatures[0])[0];
          if (f.mode === 'chain-failed') {
            f.statuses.set(signature, { slot: f.height + 5000, commitment: 'finalized', error: { InstructionError: [0, 'Custom'] } });
          } else {
            const result = vm.sendTransaction(getTransactionDecoder().decode(bytes));
            assert.ok(!(result instanceof FailedTransactionMetadata), result.toString());
            f.statuses.set(signature, { slot: f.height + 5000, commitment: 'finalized', error: null });
          }
          if (f.mode === 'lost-response') throw Error('Response lost after submission');
          return [{ signature: tx.signatures[0] }];
        } },
    } };
  f.wallet = new StandardWalletAdapter({ wallet }); f.wallet.on('error', () => {}); await f.wallet.connect();
  const read = async (key, options = {}) => {
    if (f.confirmationRateLimited) throw Error('RPC_RATE_LIMIT');
    if (options.minContextSlot !== undefined) {
      assert.ok(Number.isSafeInteger(options.minContextSlot));
      if (f.lagging) throw Error('Minimum context slot has not been reached');
      f.checkedMinimumSlot = options.minContextSlot;
    }
    const value = vm.getAccount(key);
    return !value.exists ? { exists: false, publicKey: key } : { exists: true, publicKey: key,
      executable: value.executable, owner: value.programAddress, lamports: lamports(value.lamports), rentEpoch: 0n, data: value.data };
  };
  umi.rpc = new Proxy(umi.rpc, { get(target, name) {
    const methods = {
      getGenesisHash: async () => { if (f.genesisRateLimited) throw Error('RPC_RATE_LIMIT'); return f.genesis; },
      getCluster: () => 'devnet',
      getAccount: read, getAccounts: keys => Promise.all(keys.map(read)),
      getBalance: async key => lamports(vm.getBalance(key) || 0n),
      getRent: async bytes => lamports(vm.minimumBalanceForRentExemption(BigInt(bytes))),
      getLatestBlockhash: async () => ({ blockhash: vm.latestBlockhash(), lastValidBlockHeight: BigInt(f.height + 150) }),
      getSignatureStatuses: async signatures => signatures.map(s => f.statuses.get(base58.deserialize(s)[0]) || null),
      simulateTransaction: async transaction => {
        vm.withSigverify(false);
        const result = vm.simulateTransaction(getTransactionDecoder().decode(umi.transactions.serialize(transaction)));
        vm.withSigverify(true);
        if (f.changeDuringSimulation) {
          wallet.accounts = [{ ...account, address: generateSigner(umi).publicKey }];
          change({ accounts: wallet.accounts });
        }
        return { err: f.badSimulation || result instanceof FailedTransactionMetadata ? { simulated: true } : null };
      },
    };
    if (name in methods) return methods[name];
    if (typeof target[name] === 'function') return () => { throw Error(`Unexpected live RPC: ${String(name)}`); };
    return target[name];
  } });
  f.store = await openPhantomStore(payer.publicKey);
  f.makeFlow = (overrides = {}) => phantomCheck({ umi, wallet: f.wallet, store: f.store,
    expectedOwner: payer.publicKey, readHeight: async () => ({ blockHeight: f.height, slot: f.height + 5000 }),
    send: transaction => f.wallet.sendTransaction(transaction, connection, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 }),
    confirmationMs: 0, wait: async () => {}, ...overrides });
  f.flow = f.makeFlow(); return f;
}
const report = { checkedAt: new Date().toISOString(), scope: 'official StandardWalletAdapter + Umi + Core in LiteSVM; fake IndexedDB and faulted transport; no physical Phantom', passed: false, checks: [] };
async function check(name, fn) { await fn(); report.checks.push(name); }
try {
  await check('official signAndSend-only wallet creates a Core asset with owner, URI and 7% royalties', async () => {
    const f = await fixture(); const state = await f.flow.start(); assert.equal(state.phase, 'verified');
    const asset = await fetchAsset(f.umi, state.asset); assert.equal(asset.owner, f.payer.publicKey);
    assert.equal(asset.name, TEST_NAME); assert.equal(asset.uri, TEST_URI); assert.equal(asset.royalties.basisPoints, 700);
    assert.equal(f.requests, 1); report.transactionBytes = f.packetBytes;
  });
  await check('concurrent clicks coalesce to one wallet request', async () => {
    const f = await fixture(); const [a, b] = await Promise.all([f.flow.start(), f.flow.start()]);
    assert.equal(a.asset, b.asset); assert.equal(f.requests, 1);
  });
  await check('two controllers sharing atomic IndexedDB claim cannot both request mint', async () => {
    const f = await fixture(); const other = f.makeFlow({ store: await openPhantomStore(f.payer.publicKey) });
    await Promise.all([f.flow.start(), other.start()]); assert.equal(f.requests, 1);
    assert.equal((await f.flow.check()).phase, 'verified');
  });
  await check('completed restart checks existing account with no new request or fee', async () => {
    const f = await fixture(); const first = await f.flow.start(); const balance = f.vm.getBalance(f.payer.publicKey);
    const again = await f.makeFlow().start(); assert.equal(again.asset, first.asset); assert.equal(again.phase, 'verified');
    assert.equal(f.requests, 1); assert.equal(f.vm.getBalance(f.payer.publicKey), balance);
  });
  await check('wallet cancellation requires an explicit retry', async () => {
    const f = await fixture(); f.mode = 'cancel'; assert.equal((await f.flow.start()).phase, 'cancelled');
    f.mode = 'ok'; await f.flow.start(); assert.equal(f.requests, 1);
    assert.equal((await f.flow.retry()).phase, 'verified'); assert.equal(f.requests, 2);
  });
  await check('lost successful wallet response recovers by saved asset without another mint', async () => {
    const f = await fixture(); f.mode = 'lost-response'; await assert.rejects(f.flow.start(), /Response lost/);
    assert.equal((await f.makeFlow().check()).phase, 'verified'); assert.equal(f.requests, 1);
  });
  await check('unknown wallet outcome blocks retry until finalized expiry and repeated absence', async () => {
    const f = await fixture(); f.mode = 'offline'; await assert.rejects(f.flow.start(), /unavailable/);
    await assert.rejects(f.flow.retry(), /RESULT_STILL_PENDING/); assert.equal(f.requests, 1);
    f.height += 200; assert.equal((await f.flow.check()).phase, 'expired');
    assert.equal(f.checkedMinimumSlot, f.height + 5000);
    f.mode = 'ok'; assert.equal((await f.flow.retry()).phase, 'verified'); assert.equal(f.requests, 2);
  });
  await check('late wallet signature is saved after UI timeout', async () => {
    const f = await fixture(); f.mode = 'late';
    await assert.rejects(f.makeFlow({ walletDeadlineMs: 5 }).start(), /WALLET_RESULT_UNKNOWN/);
    f.release(); await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok((await f.store.load()).signature); assert.equal((await f.flow.check()).phase, 'verified'); assert.equal(f.requests, 1);
  });
  await check('wrong wallet and wrong genesis cannot request a signature', async () => {
    const f = await fixture(); await assert.rejects(f.makeFlow({ expectedOwner: generateSigner(f.umi).publicKey }).start(), /WRONG_WALLET/);
    f.genesis = 'wrong-network'; await assert.rejects(f.flow.start(), /WRONG_NETWORK/); assert.equal(f.requests, 0);
  });
  await check('account change during preparation stops before persisting or prompting', async () => {
    const f = await fixture(); f.changeDuringSimulation = true;
    await assert.rejects(f.flow.start(), /WRONG_WALLET/); assert.equal(f.requests, 0); assert.equal(await f.store.load(), null);
  });
  await check('failed simulation and unavailable persistence prevent wallet prompts', async () => {
    const f = await fixture(); f.badSimulation = true; await assert.rejects(f.flow.start(), /SIMULATION_FAILED/);
    f.badSimulation = false;
    await assert.rejects(f.makeFlow({ store: { ...f.store, claim: async () => { throw Error('STORAGE_UNAVAILABLE'); } } }).start(), /STORAGE_UNAVAILABLE/);
    assert.equal(f.requests, 0);
  });
  await check('on-chain failure is recorded as failed and never as an NFT success', async () => {
    const f = await fixture(); f.mode = 'chain-failed'; const state = await f.flow.start(); assert.equal(state.phase, 'failed');
    assert.equal(f.vm.getAccount(state.asset).exists, false);
  });
  await check('an unfinalized chain error does not authorize a replacement', async () => {
    const f = await fixture(); f.mode = 'chain-failed'; const state = await f.flow.start();
    const status = f.statuses.get(state.signature); status.commitment = 'processed';
    await f.store.patch(state.asset, { phase: 'submitted' });
    await assert.rejects(f.flow.retry(), /RESULT_STILL_PENDING/); assert.equal(f.requests, 1);
  });
  await check('a lagging RPC cannot authorize expiry from a stale absent account', async () => {
    const f = await fixture(); f.mode = 'offline'; await assert.rejects(f.flow.start());
    f.height += 200; f.lagging = true;
    await assert.rejects(f.flow.retry(), /Minimum context slot/); assert.equal(f.requests, 1);
    assert.equal((await f.store.load()).phase, 'awaiting-wallet');
  });
  await check('rate limit before preparation leaves no intent or wallet request', async () => {
    const f = await fixture(); f.genesisRateLimited = true;
    await assert.rejects(f.flow.start(), /RPC_RATE_LIMIT/);
    assert.equal(await f.store.load(), null); assert.equal(f.requests, 0);
    f.genesisRateLimited = false; assert.equal((await f.flow.start()).phase, 'verified'); assert.equal(f.requests, 1);
  });
  await check('rate limit after submission preserves signature and resumes without another mint', async () => {
    const f = await fixture(); f.confirmationRateLimited = true;
    await assert.rejects(f.flow.start(), /RPC_RATE_LIMIT/);
    const saved = await f.store.load(); assert.ok(saved.signature); assert.equal(f.requests, 1);
    f.confirmationRateLimited = false;
    const checked = await f.flow.check(); assert.equal(checked.phase, 'verified');
    assert.equal(checked.asset, saved.asset); assert.equal(f.requests, 1);
  });
  report.passed = true;
} catch (error) { report.error = String(error.stack); process.exitCode = 1; }
await writeFile(new URL('./reports/phantom-adapter.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
