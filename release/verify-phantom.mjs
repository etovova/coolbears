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
  const f = { vm, umi, payer, requests: 0, mode: 'ok', height: 100, genesis: DEVNET_GENESIS, statuses: new Map(), faults: {}, calls: {} };
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
    if (name in methods) return (...args) => {
      f.calls[name] = (f.calls[name] || 0) + 1;
      const spec = f.faults[name];
      const fault = typeof spec === 'string' ? { code: spec } : spec;
      if (fault && (!fault.at || fault.at === f.calls[name])) throw Error(fault.code || fault);
      return methods[name](...args);
    };
    if (typeof target[name] === 'function') return () => { throw Error(`Unexpected live RPC: ${String(name)}`); };
    return target[name];
  } });
  f.store = await openPhantomStore(payer.publicKey);
  f.makeFlow = (overrides = {}) => phantomCheck({ umi, wallet: f.wallet, store: f.store,
    expectedOwner: payer.publicKey, readHeight: async () => {
      if (f.faults.readHeight) throw Error(f.faults.readHeight);
      return { blockHeight: f.height, slot: f.height + 5000 };
    },
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
  for (const code of ['RPC_RATE_LIMIT', 'RPC_TIMEOUT', 'RPC_UNAVAILABLE', 'RPC_ACCESS_DENIED', 'RPC_ABORTED']) {
    for (const [method, at] of [['getGenesisHash', 1], ['getBalance', 1], ['getLatestBlockhash', 1], ['simulateTransaction', 1], ['getLatestBlockhash', 2]]) {
      await check(`${code} at ${method} call ${at} stops before intent/signature and permits a fresh manual attempt`, async () => {
        const f = await fixture(); f.faults[method] = { code, at };
        await assert.rejects(f.flow.start(), new RegExp(code));
        assert.equal(f.requests, 0); assert.equal(await f.store.load(), null);
        delete f.faults[method]; assert.equal((await f.flow.start()).phase, 'verified'); assert.equal(f.requests, 1);
      });
    }
    for (const method of ['getSignatureStatuses', 'getAccount']) {
      await check(`${code} at ${method} after submission survives controller restart without a second signature`, async () => {
        const f = await fixture(); f.faults[method] = code;
        await assert.rejects(f.flow.start(), new RegExp(code));
        const before = await f.store.load(); assert.ok(before.signature); assert.equal(before.phase, 'submitted');
        const balance = f.vm.getBalance(f.payer.publicKey);
        await assert.rejects(f.makeFlow().retry(), new RegExp(code)); assert.equal(f.requests, 1);
        delete f.faults[method]; const result = await f.makeFlow().start();
        assert.equal(result.asset, before.asset); assert.equal(result.phase, 'verified');
        assert.equal(f.requests, 1); assert.equal(f.vm.getBalance(f.payer.publicKey), balance);
      });
    }
    await check(`${code} while reading finalized height preserves unknown wallet outcome and blocks retry`, async () => {
      const f = await fixture(); f.mode = 'offline'; await assert.rejects(f.flow.start(), /unavailable/);
      f.height += 200; f.faults.readHeight = code;
      await assert.rejects(f.makeFlow().retry(), new RegExp(code));
      assert.equal((await f.store.load()).phase, 'awaiting-wallet'); assert.equal(f.requests, 1);
      delete f.faults.readHeight; assert.equal((await f.makeFlow().check()).phase, 'expired'); assert.equal(f.requests, 1);
    });
  }
  await check('insufficient test SOL stops before simulation, persistence or signature', async () => {
    const f = await fixture(); const a = f.vm.getAccount(f.payer.publicKey);
    f.vm.setAccount({ ...a, lamports: 9999999n });
    await assert.rejects(f.flow.start(), /NEED_TEST_SOL/); assert.equal(f.calls.simulateTransaction, undefined);
    assert.equal(f.requests, 0); assert.equal(await f.store.load(), null);
  });
  for (const [field, value] of [['version', 99], ['network', 'mainnet-beta'], ['owner', CORE_PROGRAM]]) {
    await check(`invalid saved ${field} blocks both start and replacement`, async () => {
      const f = await fixture(); f.mode = 'offline'; await assert.rejects(f.flow.start());
      const state = await f.store.load(); await f.store.patch(state.asset, { [field]: value });
      await assert.rejects(f.makeFlow().start(), /INVALID_SAVED_STATE/);
      await assert.rejects(f.makeFlow().retry(), /INVALID_SAVED_STATE/); assert.equal(f.requests, 1);
    });
  }
  await check('malformed wallet signature leaves an unresolved intent and never creates another request', async () => {
    const f = await fixture(); await assert.rejects(f.makeFlow({ send: async () => { f.requests++; return '123'; } }).start(), /INVALID_SIGNATURE/);
    assert.equal((await f.store.load()).phase, 'awaiting-wallet');
    await assert.rejects(f.makeFlow().retry(), /RESULT_STILL_PENDING/); assert.equal(f.requests, 1);
  });
  await check('disconnect before reopening preserves the journal until the owner reconnects', async () => {
    const f = await fixture(); f.mode = 'offline'; await assert.rejects(f.flow.start());
    const state = await f.store.load(); await f.wallet.disconnect();
    await assert.rejects(f.makeFlow().start(), /WRONG_WALLET/); assert.deepEqual(await f.store.load(), state);
    await f.wallet.connect(); await f.makeFlow().check(); assert.equal(f.requests, 1);
  });
  await check('invalid finalized height cannot expire an unresolved transaction', async () => {
    const f = await fixture(); f.mode = 'offline'; await assert.rejects(f.flow.start());
    await assert.rejects(f.makeFlow({ readHeight: async () => ({ blockHeight: NaN, slot: 999999 }) }).retry(), /INVALID_FINALIZED_HEIGHT/);
    assert.equal((await f.store.load()).phase, 'awaiting-wallet'); assert.equal(f.requests, 1);
  });
  for (const code of [4900, 4100, -32000, -32002, -32003, -32601, -32603]) {
    await check(`Phantom error ${code} preserves the unknown operation and blocks a second prompt`, async () => {
      const f = await fixture();
      await assert.rejects(f.makeFlow({ send: async () => { f.requests++; throw Object.assign(Error(`Phantom ${code}`), { code }); } }).start(), /Phantom/);
      assert.equal((await f.store.load()).phase, 'awaiting-wallet');
      await assert.rejects(f.makeFlow().retry(), /RESULT_STILL_PENDING/); assert.equal(f.requests, 1);
    });
  }
  for (const wrapper of ['cause', 'error']) {
    await check(`wrapped 4001 cancellation in ${wrapper} is recognized without automatic retry`, async () => {
      const f = await fixture();
      const result = await f.makeFlow({ send: async () => { f.requests++; throw { [wrapper]: { code: 4001 } }; } }).start();
      assert.equal(result.phase, 'cancelled'); assert.equal(f.requests, 1);
    });
  }
  for (const field of ['program', 'name', 'uri', 'truncated-data']) {
    await check(`unexpected asset ${field} is rejected during recovery without reminting`, async () => {
      const f = await fixture(); const first = await f.flow.start();
      const raw = f.vm.getAccount(first.asset);
      if (field === 'program') raw.programAddress = f.payer.publicKey;
      else if (field === 'truncated-data') raw.data = new Uint8Array(3);
      else {
        const bytes = Buffer.from(raw.data); const needle = field === 'name' ? TEST_NAME : TEST_URI;
        const offset = bytes.indexOf(needle); assert.ok(offset >= 0); bytes[offset] ^= 1; raw.data = bytes;
      }
      f.vm.setAccount(raw);
      await assert.rejects(f.makeFlow().check()); await assert.rejects(f.makeFlow().retry()); assert.equal(f.requests, 1);
    });
  }
  for (const commitment of ['processed', 'confirmed']) {
    await check(`${commitment} signature cannot certify an asset as finalized or authorize another mint`, async () => {
      const f = await fixture(); f.faults.getAccount = 'RPC_TIMEOUT'; await assert.rejects(f.flow.start());
      const saved = await f.store.load(); f.statuses.get(saved.signature).commitment = commitment;
      delete f.faults.getAccount; assert.equal((await f.makeFlow().check()).phase, 'submitted');
      await assert.rejects(f.makeFlow().retry(), /RESULT_STILL_PENDING/); assert.equal(f.requests, 1);
      f.statuses.get(saved.signature).commitment = 'finalized'; assert.equal((await f.makeFlow().check()).phase, 'verified');
    });
  }
  report.passed = true;
} catch (error) { report.error = String(error.stack); process.exitCode = 1; }
await writeFile(new URL('./reports/phantom-adapter.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
