// Disposable synthetic account/transaction fixtures. All network calls intercepted.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import approved from '../../metadata/policy.json' with {type:'json'};
import { buyerGatewayFixture } from './fixtures/buyer-gateway.mjs';
import { missingResponse } from './fixtures/buyer-missing-response.mjs';
import { prewalletExpiryFixture } from './fixtures/buyer-prewallet-expiry.mjs';
import { closeAttempt } from './fixtures/buyer-replacement.mjs';
import { recoverBuyerOrder } from '../orders/recovery.mjs';
import { discoverBuyerResponse } from '../orders/discover-response.mjs';
import { discoverPrewalletResult } from '../orders/discover-prewallet.mjs';
import { reviewBuyerExpiry } from '../orders/review-expiry.mjs';
import { reviewPrewalletExpiry } from '../orders/review-prewallet-expiry.mjs';
import { reviewResponseExpiry } from '../orders/review-response-expiry.mjs';
import { anchorKey } from '../orders/blockhash-anchor.mjs';
import { failureRecord, restoreFailureReport } from '../orders/failure-record.mjs';
import { responseRecoveryRecord, restoreResponseRecovery, validateResponseRecovery } from '../orders/response-recovery.mjs';
import { prewalletRecoveryRecord, restorePrewalletRecovery, validatePrewalletRecovery } from '../orders/prewallet-recovery.mjs';
import { expiryRecord, restoreExpiryReport, validateBuyerExpiryResult } from '../orders/expiry-review.mjs';
import { prewalletExpiryRecord, restorePrewalletExpiry, validatePrewalletExpiry } from '../orders/prewallet-expiry.mjs';
import { responseExpiryRecord, restoreResponseExpiry, validateResponseExpiry } from '../orders/response-expiry.mjs';
import { validateReplacementSource, validateReplacementAcknowledgment } from '../orders/replacement.mjs';
import { GENESIS_HASHES } from '../deployment/network.mjs';
import { verifyExpiredTransaction } from '../deployment/expiry.mjs';
const oldOwner = approved.owner, originalFetch = globalThis.fetch;
let f, legacy, unsignedHistory;
before(async () => {
  globalThis.fetch = () => assert.fail('Live network forbidden');
  f = await buyerGatewayFixture({ syntheticOwner: true, cluster: 'mainnet-beta' });
  legacy = await buyerGatewayFixture({ syntheticOwner: true }); approved.owner = f.policy.owner;
  unsignedHistory = prewalletExpiryFixture(f);
});
after(() => { approved.owner = oldOwner; globalThis.fetch = originalFetch; });
const options = (fixture, input, authorizeMainnet = fixture === f) => ({ input, authorizeMainnet,
  endpoint: `https://${fixture === f ? 'mainnet' : 'devnet'}.helius-rpc.com/?api-key=fixture-secret-42`,
  fetchImpl: (url, init) => fixture.upstream(new Request(url, init)),
  blockhashAnchor: fixture.preparations.get(anchorKey(input.order)).anchor });
const closed = report => { assert.equal(report.cluster, 'mainnet-beta'); assert.equal(report.transactionsSent, 0);
  assert.equal(report.genesisHash, GENESIS_HASHES['mainnet-beta']);
  assert.equal(report.salesOpen, false); assert.equal(report.readyToSubmit, false); };
test('Mainnet and legacy finalized recovery preserve their own cluster; retained failure cannot cross networks', async () => {
  for (const fixture of [legacy, f]) {
    const input = fixture.signedInput('recover-network-' + (fixture === f ? 'mainnet' : 'devnet'));
    fixture.receipt(input.response.transactionBase64); fixture.setMode('normal');
    const report = await recoverBuyerOrder(options(fixture, input));
    assert.equal(report.status, 'verified'); assert.equal(report.cluster, input.order.cluster); assert.equal(report.proof.cluster, input.order.cluster);
    assert.equal(report.transactionsSent, 0); assert.equal(report.salesOpen, false);
  }
  const input = f.signedInput('mainnet-retained-failure'); f.receipt(input.response.transactionBase64); f.setMode('failure-finalized');
  const failed = await recoverBuyerOrder(options(f, input)); closed(failed); assert.equal(failed.status, 'failed');
  const record = failureRecord(input, failed), restored = restoreFailureReport(input, record);
  assert.equal(restored.restored, true); assert.equal(restored.networkRequests, 0); assert.equal(restored.evidence.feeLamports, '10000');
  const terminal = closeAttempt(f, input, failed); validateReplacementSource(terminal);
  assert.throws(() => validateReplacementAcknowledgment(terminal, record));
  validateReplacementAcknowledgment(terminal, record, '10000');
  const changed = structuredClone(record); changed.proof.cluster = 'devnet'; assert.throws(() => restoreFailureReport(input, changed));
});
test('positive Mainnet response and prewallet discovery retain exact bytes and restore with no RPC', async () => {
  f.setMode('normal');
  const full = f.signedInput('mainnet-response-discovery'), input = missingResponse(full); f.receipt(full.response.transactionBase64);
  const report = await discoverBuyerResponse(options(f, input)); closed(report); assert.equal(report.status, 'response-recovered');
  assert.equal(report.result.status, 'verified'); assert.equal(report.result.proof.cluster, 'mainnet-beta'); assert.deepEqual(report.response, full.response);
  const restored = restoreResponseRecovery(input, responseRecoveryRecord(input, report));
  assert.equal(restored.restored, true); assert.equal(restored.networkRequests, 0);
  for (const field of ['cluster', 'genesisHash', 'result']) { const changed = structuredClone(report);
    if (field === 'cluster') changed.cluster = 'devnet'; else if (field === 'genesisHash') changed.genesisHash = GENESIS_HASHES.devnet;
    else changed.result.proof.cluster = 'devnet';
    assert.throws(() => validateResponseRecovery(changed, input)); }
  const prewallet = f.input('mainnet-prewallet-discovery'), signed = f.signedInput(prewallet.order.id); f.receipt(signed.response.transactionBase64);
  const recovered = await discoverPrewalletResult(options(f, prewallet)); closed(recovered); assert.equal(recovered.status, 'prewallet-recovered');
  assert.equal(recovered.result.proof.cluster, 'mainnet-beta');
  assert.equal(restorePrewalletRecovery(prewallet, prewalletRecoveryRecord(prewallet, recovered)).restored, true);
  const changed = structuredClone(recovered); changed.result.proof.cluster = 'devnet'; assert.throws(() => validatePrewalletRecovery(changed, prewallet));
});
test('standalone expiry cannot inherit Mainnet authority or accept an unsupported network', async () => {
  const input = f.signedInput('mainnet-expiry-direct-grant');
  let calls = 0; const call = () => { calls++; assert.fail('Unauthorized expiry read'); };
  const anchor = f.preparations.get(anchorKey(input.order)).anchor;
  for (const options of [{ cluster: 'mainnet-beta' }, { cluster: 'mainnet-beta', authorizeMainnet: 'true' },
    { cluster: 'devnet', authorizeMainnet: true }, { cluster: 'testnet', authorizeMainnet: true }])
    await assert.rejects(verifyExpiredTransaction({ transactionBase64: input.response.transactionBase64,
      anchor: { version: 1, blockhash: anchor.blockhash, lastValidBlockHeight: anchor.lastValidBlockHeight, slot: anchor.sourceSlot }, call, ...options }));
  assert.equal(calls, 0);
});
test('all Mainnet recovery and expiry readers require an explicit local read grant; a foreign genesis reads no state', async () => {
  unsignedHistory.set(false); f.setMode('normal');
  const full = f.signedInput('mainnet-read-grant'), missing = missingResponse(full), prewallet = f.input('mainnet-read-grant-prewallet');
  const routes = [[recoverBuyerOrder, full], [discoverBuyerResponse, missing], [discoverPrewalletResult, prewallet],
    [reviewBuyerExpiry, full], [reviewResponseExpiry, missing], [reviewPrewalletExpiry, prewallet]];
  for (const [run, input] of routes) {
    const calls = f.calls.length, result = await run(options(f, input, false));
    closed(result); assert.equal(result.status, 'unknown'); assert.equal(result.networkRequests, 0); assert.equal(f.calls.length, calls);
    assert.equal(result.proof, undefined); assert.equal(result.response, undefined); assert.equal(result.retryAuthorized ?? false, false);
  }
  f.setMode('genesis');
  for (const [run, input] of routes) {
    const before = f.calls.length, result = await run(options(f, input));
    closed(result); assert.equal(result.status, 'unknown'); assert.equal(result.proof, undefined);
    assert.deepEqual(f.calls.slice(before).map(call => call.method), ['getGenesisHash']);
  }
});
test('Mainnet signed, prewallet and missing-response expiry retain network-bound evidence without authorizing retry', async () => {
  unsignedHistory.set(false); f.setMode('expiry-clear');
  const full = f.signedInput('mainnet-signed-expiry'), signed = await reviewBuyerExpiry(options(f, full));
  closed(signed); assert.equal(signed.status, 'expired'); assert.equal(signed.proof.cluster, 'mainnet-beta'); assert.equal(signed.retryAuthorized, false);
  const saved = expiryRecord(full, signed); assert.equal(restoreExpiryReport(full, saved).restored, true);
  const badSigned = structuredClone(signed); badSigned.proof.cluster = 'devnet'; assert.throws(() => validateBuyerExpiryResult(badSigned, full));
  unsignedHistory.set(true);
  const prewallet = f.input('mainnet-unsigned-expiry'), unsigned = await reviewPrewalletExpiry(options(f, prewallet));
  closed(unsigned); assert.equal(unsigned.status, 'prewallet-expired'); assert.equal(unsigned.proof.signature, null); assert.equal(unsigned.retryAuthorized, false);
  assert.equal(restorePrewalletExpiry(prewallet, prewalletExpiryRecord(prewallet, unsigned)).restored, true);
  const badUnsigned = structuredClone(unsigned); badUnsigned.proof.cluster = 'devnet'; assert.throws(() => validatePrewalletExpiry(badUnsigned, prewallet));
  const missing = missingResponse(f.signedInput('mainnet-missing-expiry')), response = await reviewResponseExpiry(options(f, missing));
  closed(response); assert.equal(response.status, 'response-expired'); assert.equal(response.proof.signature, null);
  assert.equal(restoreResponseExpiry(missing, responseExpiryRecord(missing, response)).restored, true);
  const badResponse = structuredClone(response); badResponse.proof.cluster = 'devnet'; assert.throws(() => validateResponseExpiry(badResponse, missing));
  unsignedHistory.set(false);
  assert.equal(f.calls.some(call => call.method === 'sendTransaction'), false);
});
