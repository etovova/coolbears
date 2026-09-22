import test from 'node:test';
import assert from 'node:assert/strict';
import { walletErrorDetails, publicWalletAttempt, mergeWalletAttempt, publicPreparation } from '../devnet/diagnostics.mjs';

const requestedAt = '2026-09-22T08:09:00.000Z';
const responseAt = '2026-09-22T08:09:03.000Z';
const attempt = { wallet: 'phantom', transport: 'injected', requestedAt, outcome: 'pending' };

test('wallet diagnostics classify errors without retaining raw text or unrecognized codes', () => {
  const secret = 'https://devnet.helius-rpc.com/?api-key=secret';
  for (const [error, expected] of [
    [{ code: 4001, message: secret }, { errorCategory: 'user-rejected', errorCode: 4001 }],
    [{ cause: { code: 4001 } }, { errorCategory: 'user-rejected', errorCode: 4001 }],
    [{ code: -32603, message: `Blockhash not found at ${secret}` }, { errorCategory: 'blockhash-expired', errorCode: -32603 }],
    [{ code: -32003, message: secret }, { errorCategory: 'transaction-error', errorCode: -32003 }],
    [{ message: `Failed to fetch ${secret}` }, { errorCategory: 'network-error' }],
    [{ code: secret, message: secret }, { errorCategory: 'wallet-error' }],
  ]) assert.deepEqual(walletErrorDetails(error), expected);
  const safe = publicWalletAttempt({ ...attempt, responseAt, outcome: 'error', errorCategory: 'wallet-error', errorCode: -32603, message: secret, secret });
  assert.equal(JSON.stringify(safe).includes('secret'), false);
  assert.equal(publicWalletAttempt({ ...attempt, requestedAt: secret }), null);
  assert.equal(publicWalletAttempt({ ...attempt, outcome: secret }), null);
  assert.deepEqual(publicWalletAttempt({ ...attempt, wallet: secret, transport: secret, responseAt: secret, errorCategory: secret, errorCode: 123456789 }), { ...attempt, wallet: 'other', transport: 'other' });
});

test('stale recovery preserves late wallet errors and timeout evidence', () => {
  const timeoutAt = '2026-09-22T08:09:01.000Z';
  const timedOut = { ...attempt, timeoutAt };
  const rejected = { ...timedOut, responseAt, outcome: 'error', errorCategory: 'wallet-error', errorCode: -32603 };
  assert.deepEqual(mergeWalletAttempt(attempt, rejected), rejected);
  assert.deepEqual(mergeWalletAttempt(rejected, timedOut), rejected);
  const submitted = { ...attempt, outcome: 'submitted', responseAt: '2026-09-22T08:09:04.000Z' };
  assert.deepEqual(mergeWalletAttempt(submitted, timedOut), { ...submitted, timeoutAt });
});

test('preparation diagnostics whitelist valid timing and block counts', () => {
  const preparation = { startedAt: requestedAt, readyAt: responseAt, elapsedMs: 3000, remainingBlocks: 140, attempt: 1 };
  assert.deepEqual(publicPreparation({ ...preparation, endpoint: 'secret' }), preparation);
  for (const change of [{ startedAt: 'secret' }, { remainingBlocks: -1 }, { elapsedMs: NaN }, { attempt: 3 }]) assert.equal(publicPreparation({ ...preparation, ...change }), null);
});
