import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createNoopSigner, generateSigner, publicKey, signerIdentity } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { mintV1, mplCandyMachine } from '@metaplex-foundation/mpl-core-candy-machine';
import { mplCore } from '@metaplex-foundation/mpl-core';
import { setComputeUnitLimit } from '@metaplex-foundation/mpl-toolbox';
import { signAndSubmit } from '../devnet/submission.mjs';
import { validateSignedTransaction } from '../devnet/signed-transaction.mjs';
import { sendSignedTransaction } from '../devnet/sender.mjs';
import { settings as S } from '../devnet/settings.mjs';

const signature = '3rE7YDBzisnu164zPYLWs2PNuEGPZy6spQ1eG36Ez5YuTTKPKySDexqDyawZ2uF93Ri4C4hVoCgkrF7iv158KKQ7';
const endpoint = 'https://devnet.helius-rpc.com/?api-key=PRIVATE_TEST_KEY';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const operation = { version: 1, cluster: 'devnet', owner: S.owner, machine: S.machine, collection: S.collection,
    asset: 'J3kTD8CvWZgrKjW3EQ9UceYXVqvBRHJEQDK4PrE5xx57', blockhash: S.machine, lastValidBlockHeight: 1000,
    signature: null, stage: 'wallet-pending',
    walletAttempt: { wallet: 'phantom', transport: 'injected', method: 'signTransaction', outcome: 'pending', requestedAt: new Date().toISOString() },
  };
  const h = { saved: structuredClone(operation), active: true, events: [], writes: [], sends: 0, signs: 0, fresh: 0,
    prepared: { bytes: new Uint8Array([1, 2, 3]), operation: structuredClone(operation) },
  };
  h.options = {
    prepared: h.prepared, endpoint, timeoutMs: 1000,
    wallet: { async sign(bytes) {
      h.signs++; h.events.push('sign');
      assert.notEqual(bytes, h.prepared.bytes);
      assert.equal(h.saved.stage, 'wallet-pending');
      return new Uint8Array([9, 8, 7]);
    } },
    isActive: () => h.active,
    async checkFresh() { h.fresh++; h.events.push('fresh'); },
    readSaved: () => structuredClone(h.saved),
    persist(value) { h.saved = structuredClone(value); h.writes.push(structuredClone(value)); h.events.push(`save:${value.submission?.state || value.walletAttempt.outcome}`); },
    validate(prepared, signed, op) {
      assert.deepEqual([...prepared], [1, 2, 3]);
      assert.deepEqual([...signed], [9, 8, 7]);
      assert.equal(op.blockhash, S.machine);
      return { bytes: signed.slice(), signature };
    },
    async send(url, bytes, expectedSignature) {
      h.sends++; h.events.push('send');
      assert.equal(url, endpoint);
      assert.deepEqual([...bytes], [9, 8, 7]);
      assert.equal(expectedSignature, signature);
      assert.equal(h.saved.signature, signature, 'signature is durable before broadcast');
      assert.equal(h.saved.submission.state, 'sending', 'broadcast intent is durable before network');
      return signature;
    },
  };
  return h;
}

test('sign-only flow validates, journals, checks freshness and broadcasts exactly once', async () => {
  const h = harness();
  assert.equal(await signAndSubmit(h.options), signature);
  assert.deepEqual(h.events, ['sign', 'save:not-sent', 'fresh', 'save:sending', 'send', 'save:accepted']);
  assert.equal(h.signs, 1); assert.equal(h.sends, 1);
  assert.equal(h.saved.stage, 'submitted');
  assert.equal(h.saved.walletAttempt.outcome, 'signed');
  assert.ok(h.saved.walletAttempt.responseAt);
  assert.equal(h.saved.submission.state, 'accepted');
  assert.equal(JSON.stringify(h.saved).includes('PRIVATE_TEST_KEY'), false);
  assert.equal('bytes' in h.saved, false);
});

test('unknown broadcast response preserves known signature and never retries', async () => {
  const h = harness();
  h.options.send = async () => { h.sends++; throw Object.assign(Error(endpoint), { code: 'NETWORK' }); };
  await assert.rejects(signAndSubmit(h.options), e => e.code === 'SUBMISSION_UNKNOWN' && !e.message.includes('PRIVATE_TEST_KEY'));
  assert.equal(h.sends, 1); assert.equal(h.signs, 1);
  assert.equal(h.saved.signature, signature); assert.equal(h.saved.stage, 'unknown');
  assert.equal(h.saved.submission.state, 'unknown');
  assert.equal(h.saved.submission.errorCategory, 'NETWORK');
  assert.equal(JSON.stringify(h.saved).includes('PRIVATE_TEST_KEY'), false);
});

test('submission diagnostics retain only known sender categories and numeric codes', async () => {
  for (const failure of [
    Object.assign(Error(endpoint), { code: 'HTTP', status: 429, rpcCode: -32005 }),
    Object.assign(Error(endpoint), { code: endpoint, status: endpoint, rpcCode: endpoint }),
  ]) {
    const h = harness(); h.options.send = async () => { throw failure; };
    await assert.rejects(signAndSubmit(h.options), e => e.code === 'SUBMISSION_UNKNOWN');
    assert.equal(JSON.stringify(h.saved).includes('PRIVATE_TEST_KEY'), false);
    if (failure.code === 'HTTP') {
      assert.equal(h.saved.submission.errorCategory, 'HTTP');
      assert.equal(h.saved.submission.httpStatus, 429);
      assert.equal(h.saved.submission.errorCode, -32005);
    } else assert.equal('errorCategory' in h.saved.submission, false);
  }
});

test('wallet rejection is cancelled; generic wallet errors remain unknown without a send', async () => {
  for (const code of [4001, -32603]) {
    const h = harness(); h.options.wallet.sign = async () => { throw Object.assign(Error(endpoint), { code }); };
    await assert.rejects(signAndSubmit(h.options), e => e.code === (code === 4001 ? 4001 : 'WALLET_SIGN_FAILED') && !e.message.includes('PRIVATE_TEST_KEY'));
    assert.equal(h.saved.stage, code === 4001 ? 'cancelled' : 'unknown');
    assert.equal(h.saved.walletAttempt.outcome, code === 4001 ? 'rejected' : 'error');
    assert.equal(h.saved.walletAttempt.errorCode, code);
    assert.equal(h.saved.signature, null); assert.equal(h.sends, 0); assert.equal(h.fresh, 0);
    assert.equal(JSON.stringify(h.saved).includes('PRIVATE_TEST_KEY'), false);
  }
});

test('invalid signed transaction cannot be sent and raw validation errors are not saved', async () => {
  const h = harness(); h.options.validate = () => { throw Error(endpoint); };
  await assert.rejects(signAndSubmit(h.options), e => e.code === 'SIGNED_TRANSACTION_INVALID');
  assert.equal(h.sends, 0); assert.equal(h.fresh, 0); assert.equal(h.saved.signature, null);
  assert.equal(h.saved.walletAttempt.errorCategory, 'invalid-response');
  assert.equal(JSON.stringify(h.saved).includes('PRIVATE_TEST_KEY'), false);
});

test('late signed reply after timeout is durable evidence but never broadcasts', async () => {
  const h = harness(), pending = deferred();
  h.options.timeoutMs = 8; h.options.wallet.sign = () => pending.promise;
  await assert.rejects(signAndSubmit(h.options), e => e.code === 'WALLET_TIMEOUT');
  assert.ok(h.saved.walletAttempt.timeoutAt);
  pending.resolve(new Uint8Array([9, 8, 7])); await flush();
  assert.equal(h.saved.signature, signature); assert.equal(h.saved.stage, 'unknown');
  assert.equal(h.saved.walletAttempt.outcome, 'signed'); assert.ok(h.saved.walletAttempt.timeoutAt);
  assert.equal(h.saved.submission.state, 'not-sent');
  assert.equal(h.sends, 0); assert.equal(h.fresh, 0);
});

test('late rejection cannot cancel a signature already found by recovery', async () => {
  const h = harness(), pending = deferred();
  h.options.timeoutMs = 8; h.options.wallet.sign = () => pending.promise;
  await assert.rejects(signAndSubmit(h.options), e => e.code === 'WALLET_TIMEOUT');
  h.saved.signature = signature;
  pending.reject(Object.assign(Error(endpoint), { code: 4001 })); await flush();
  assert.equal(h.saved.signature, signature); assert.equal(h.saved.stage, 'unknown');
  assert.equal(h.saved.walletAttempt.outcome, 'rejected'); assert.ok(h.saved.walletAttempt.timeoutAt);
  assert.equal(h.sends, 0); assert.equal(h.fresh, 0);
});

test('invalidation while signing saves the signature but never calls freshness or sender', async () => {
  const h = harness(), pending = deferred(); h.options.wallet.sign = () => pending.promise;
  const run = signAndSubmit(h.options);
  h.active = false; pending.resolve(new Uint8Array([9, 8, 7]));
  await assert.rejects(run, e => e.code === 'SUBMISSION_INACTIVE');
  assert.equal(h.saved.signature, signature); assert.equal(h.saved.submission.state, 'not-sent');
  assert.equal(h.fresh, 0); assert.equal(h.sends, 0);
});

test('invalidation during the freshness await prevents broadcast', async () => {
  const h = harness(), pending = deferred(), started = deferred();
  h.options.checkFresh = () => { started.resolve(); return pending.promise; };
  const run = signAndSubmit(h.options); await started.promise;
  h.active = false; pending.resolve();
  await assert.rejects(run, e => e.code === 'SUBMISSION_INACTIVE');
  assert.equal(h.sends, 0); assert.equal(h.saved.submission.state, 'not-sent');
});

test('a different journal asset or blockhash is never overwritten by a late reply', async () => {
  for (const field of ['asset', 'blockhash']) {
    const h = harness(), pending = deferred(); h.options.wallet.sign = () => pending.promise;
    const run = signAndSubmit(h.options);
    h.saved[field] = 'DIFFERENT_OPERATION';
    const expected = structuredClone(h.saved);
    pending.resolve(new Uint8Array([9, 8, 7]));
    await assert.rejects(run, e => e.code === 'SUBMISSION_INACTIVE');
    assert.deepEqual(h.saved, expected); assert.equal(h.writes.length, 0); assert.equal(h.sends, 0);
  }
});

test('changed signature or already-submitted stage during freshness stops a second send', async () => {
  for (const change of [{ signature: 'OTHER_SIGNATURE' }, { stage: 'submitted' }, { stage: 'verified' }]) {
    const h = harness(); h.options.checkFresh = async () => { Object.assign(h.saved, change); };
    await assert.rejects(signAndSubmit(h.options), e => e.code === 'SUBMISSION_INACTIVE');
    assert.equal(h.sends, 0);
  }
});

test('journal durability failure before signing or broadcast prevents network writes', async () => {
  const unreadable = harness(); unreadable.options.readSaved = () => { throw Error(endpoint); };
  await assert.rejects(signAndSubmit(unreadable.options), e => e.code === 'SUBMISSION_JOURNAL' && !e.message.includes('PRIVATE_TEST_KEY'));
  assert.equal(unreadable.signs, 0); assert.equal(unreadable.sends, 0);
  for (const lostState of ['not-sent', 'sending']) {
    const h = harness(), persist = h.options.persist;
    h.options.persist = value => { if (value.submission?.state !== lostState) persist(value); };
    await assert.rejects(signAndSubmit(h.options), e => e.code === 'SUBMISSION_INACTIVE');
    assert.equal(h.sends, 0);
  }
});

test('invalidation caused by the sending-journal callback is checked before fetch', async () => {
  const h = harness(), persist = h.options.persist;
  h.options.persist = value => { persist(value); if (value.submission?.state === 'sending') h.active = false; };
  await assert.rejects(signAndSubmit(h.options), e => e.code === 'SUBMISSION_INACTIVE');
  assert.equal(h.sends, 0); assert.equal(h.saved.submission.errorCategory, 'ABORTED');
});

test('freshness errors retain signed evidence and do not leak endpoint text', async () => {
  const h = harness(); h.options.checkFresh = async () => { throw Error(endpoint); };
  await assert.rejects(signAndSubmit(h.options), e => e.code === 'SUBMISSION_FRESHNESS' && !e.message.includes('PRIVATE_TEST_KEY'));
  assert.equal(h.saved.signature, signature); assert.equal(h.saved.submission.state, 'not-sent'); assert.equal(h.sends, 0);
});

test('signing and validation use independent copies of mutable transaction inputs', async () => {
  const h = harness();
  h.options.wallet.sign = async bytes => {
    bytes[0] = 255; h.prepared.bytes[1] = 254; h.prepared.operation.blockhash = 'changed';
    return new Uint8Array([9, 8, 7]);
  };
  assert.equal(await signAndSubmit(h.options), signature);
  assert.equal(h.sends, 1);
});

test('an already-verified operation stays verified when an in-flight RPC reply arrives', async () => {
  const h = harness();
  h.options.send = async () => { h.sends++; h.saved.stage = 'verified'; return signature; };
  assert.equal(await signAndSubmit(h.options), signature);
  assert.equal(h.saved.stage, 'verified'); assert.equal(h.saved.submission.state, 'accepted'); assert.equal(h.sends, 1);
});

test('the signing deadline does not also time out the separately bounded freshness check', async () => {
  const h = harness(); h.options.timeoutMs = 100;
  h.options.checkFresh = () => new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await signAndSubmit(h.options), signature);
  assert.equal(h.sends, 1); assert.equal(h.saved.walletAttempt.timeoutAt, undefined);
});

test('real Core mint signing, validation and sender compose into one journaled RPC request', async () => {
  // Generated test keys and a recorded blockhash keep this integration offline.
  const fixture = JSON.parse(await readFile(new URL('./fixtures/devnet-rpc.json', import.meta.url), 'utf8'));
  const owner = Keypair.generate(), address = owner.publicKey.toBase58();
  const umi = createUmi(S.rpc).use(mplCore()).use(mplCandyMachine()).use(signerIdentity(createNoopSigner(publicKey(address))));
  const asset = generateSigner(umi), blockhash = fixture.getLatestBlockhash.value;
  const tx = await setComputeUnitLimit(umi, { units: 300000 }).add(mintV1(umi, {
    candyMachine: publicKey(S.machine), candyGuard: publicKey(S.guard), collection: publicKey(S.collection),
    asset, owner: publicKey(address), mintArgs: { solPayment: { destination: publicKey(S.owner) } },
  })).setBlockhash(blockhash).buildAndSign(umi);
  const bytes = umi.transactions.serialize(tx), baseline = bytes.slice();
  const operation = { version: 1, cluster: 'devnet', machine: S.machine, collection: S.collection,
    owner: address, asset: asset.publicKey, blockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight, stage: 'wallet-pending', signature: null,
    walletAttempt: { wallet: 'phantom', transport: 'injected', method: 'signTransaction', outcome: 'pending', requestedAt: new Date().toISOString() },
  };
  let saved = structuredClone(operation), signedBytes, actualSignature, requests = 0, signs = 0;
  const events = [];
  const result = await signAndSubmit({
    prepared: { bytes, operation }, endpoint, isActive: () => true,
    readSaved: () => structuredClone(saved),
    persist(value) { saved = structuredClone(value); events.push(`save:${value.submission.state}`); },
    wallet: { async sign(input) {
      signs++; events.push('sign');
      assert.equal(saved.stage, 'wallet-pending');
      const signed = VersionedTransaction.deserialize(input);
      signed.sign([owner]);
      signedBytes = signed.serialize();
      actualSignature = base58.deserialize(signed.signatures[0])[0];
      return signedBytes;
    } },
    validate: (prepared, signed, op) => validateSignedTransaction(prepared, signed, op, { expectedOwner: address }),
    async checkFresh() {
      events.push('fresh');
      assert.equal(saved.signature, actualSignature);
      assert.equal(saved.submission.state, 'not-sent');
    },
    send: (url, signed, expected) => sendSignedTransaction(url, signed, expected, {
      async fetchImpl(url, init) {
        requests++; events.push('fetch');
        assert.equal(url, endpoint); assert.equal(init.method, 'POST');
        assert.equal(saved.signature, actualSignature, 'validated signature is durable before the HTTP request');
        assert.equal(saved.stage, 'unknown'); assert.equal(saved.submission.state, 'sending');
        const body = JSON.parse(init.body);
        assert.equal(body.method, 'sendTransaction');
        assert.equal(body.params[1].encoding, 'base64'); assert.equal(body.params[1].skipPreflight, false);
        assert.deepEqual(new Uint8Array(Buffer.from(body.params[0], 'base64')), signedBytes, 'exact validated bytes are posted');
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: actualSignature }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      },
    }),
  });
  assert.equal(result, actualSignature); assert.equal(signs, 1); assert.equal(requests, 1);
  assert.deepEqual(events, ['sign', 'save:not-sent', 'fresh', 'save:sending', 'fetch', 'save:accepted']);
  assert.equal(saved.stage, 'submitted'); assert.equal(saved.submission.state, 'accepted');
  assert.deepEqual(bytes, baseline, 'the prepared asset-signed transaction remains unchanged');
});
