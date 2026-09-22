import { walletErrorDetails, publicSubmission } from './diagnostics.mjs';
import { validateSignedTransaction } from './signed-transaction.mjs';
import { sendSignedTransaction } from './sender.mjs';

const now = () => new Date().toISOString();
const error = (code, message) => Object.assign(new Error(message), { code });
const inactive = () => error('SUBMISSION_INACTIVE', 'Отправка остановлена: кошелёк, способ отправки или сохранённая операция изменились.');
const journalError = () => error('SUBMISSION_JOURNAL', 'Не удалось сохранить результат подписи. Отправка через RPC не продолжается.');
const timeoutError = () => error('WALLET_TIMEOUT', 'Кошелёк не ответил вовремя. Поздняя подпись будет сохранена без автоматической отправки.');

// readSaved and persist are synchronous journal operations, as in app.mjs.
// The late-response handlers below only validate and save evidence. All network
// submission stays in the foreground after the signing deadline has settled.
export async function signAndSubmit({ prepared, wallet, endpoint, isActive, checkFresh, readSaved, persist,
  send = sendSignedTransaction, validate = validateSignedTransaction, timeoutMs = 60000 }) {
  if (!(prepared?.bytes instanceof Uint8Array) || !prepared.operation || typeof wallet?.sign !== 'function' ||
      typeof endpoint !== 'string' || ![isActive, checkFresh, readSaved, persist, send, validate].every(value => typeof value === 'function') ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw error('SUBMISSION_CONFIG', 'Не удалось подготовить безопасную отправку.');
  const baseline = prepared.bytes.slice();
  const operation = { ...prepared.operation };
  const selectedEndpoint = endpoint;
  const sameOperation = saved => saved && ['asset', 'owner', 'machine', 'collection', 'blockhash', 'lastValidBlockHeight']
    .every(key => saved[key] === operation[key]);
  const current = () => {
    let saved;
    try { saved = readSaved(); } catch { throw journalError(); }
    return sameOperation(saved) ? saved : null;
  };
  const save = update => {
    const saved = current();
    if (!saved) return false;
    try { persist(update(saved)); } catch { throw journalError(); }
    return true;
  };
  const active = () => {
    try { return Boolean(isActive()) && Boolean(current()); }
    catch { return false; }
  };
  const guard = expectedSignature => {
    const saved = current();
    if (!active() || !saved || saved.stage === 'verified' || ['sending', 'unknown', 'accepted'].includes(saved.submission?.state)) throw inactive();
    if (expectedSignature && (saved.signature !== expectedSignature || saved.stage !== 'unknown' || saved.submission?.state !== 'not-sent')) throw inactive();
    return saved;
  };
  const initial = guard();
  if (initial.stage !== 'wallet-pending' || initial.signature) throw inactive();

  let timer;
  let expired = false;
  const started = performance.now();
  const markTimeout = () => {
    expired = true;
    save(saved => ({ ...saved, stage: saved.stage === 'verified' ? 'verified' : 'unknown',
      walletAttempt: { ...saved.walletAttempt, timeoutAt: saved.walletAttempt?.timeoutAt || now() },
    }));
  };
  const walletFailure = (failure, invalidResponse = false) => {
    const details = invalidResponse ? { errorCategory: 'invalid-response' } : walletErrorDetails(failure);
    const rejected = details.errorCategory === 'user-rejected';
    save(saved => ({ ...saved,
      stage: saved.stage === 'verified' ? 'verified' : rejected && !saved.signature ? 'cancelled' : 'unknown',
      walletAttempt: { ...saved.walletAttempt, outcome: rejected ? 'rejected' : 'error', responseAt: now(), ...details },
    }));
    return error(rejected ? 4001 : invalidResponse ? 'SIGNED_TRANSACTION_INVALID' : 'WALLET_SIGN_FAILED',
      rejected ? 'Подпись отменена в кошельке.' : invalidResponse ? 'Подписанная транзакция не прошла проверку. Отправка остановлена.' : 'Кошелёк не выполнил подпись. Отправка через RPC не начиналась.');
  };
  const signed = Promise.resolve().then(() => wallet.sign(baseline.slice())).then(signedBytes => {
    const withinDeadline = !expired && performance.now() - started < timeoutMs;
    let verified;
    try { verified = validate(baseline, signedBytes, operation); }
    catch (failure) { throw walletFailure(failure, true); }
    const saved = current();
    if (saved?.signature && saved.signature !== verified.signature) throw error('SUBMISSION_SIGNATURE_CONFLICT', 'Сохранённая подпись не совпадает с ответом кошелька. Отправка остановлена.');
    const stored = save(value => ({ ...value, signature: verified.signature,
      stage: value.stage === 'verified' ? 'verified' : 'unknown',
      walletAttempt: { ...value.walletAttempt, outcome: 'signed', responseAt: now() },
      submission: value.submission || { route: 'custom-rpc', state: 'not-sent', updatedAt: now() },
    }));
    return { ...verified, withinDeadline, stored };
  }, failure => { throw walletFailure(failure); });
  // Promise.race observes late rejections too; no detached signing rejection or
  // late wallet reply can enter the send branch after this function has failed.
  let verified;
  try {
    verified = await Promise.race([signed, new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { markTimeout(); } catch { /* Original pre-prompt journal remains the recovery record. */ }
        reject(timeoutError());
      }, timeoutMs);
    })]);
    if (!verified.withinDeadline || expired) { markTimeout(); throw timeoutError(); }
  } finally { clearTimeout(timer); }

  if (!verified.stored) throw inactive();
  guard(verified.signature);
  // This read has its own bounded Devnet check. The wallet deadline is finished;
  // slow freshness reads cannot trigger another prompt or a background send.
  try {
    if (await checkFresh() === false) throw inactive();
  } catch { throw error('SUBMISSION_FRESHNESS', 'Не удалось подтвердить Devnet и срок подписанной транзакции. Отправка не начиналась.'); }
  guard(verified.signature);
  save(saved => ({ ...saved, stage: saved.stage === 'verified' ? 'verified' : 'unknown',
    submission: { route: 'custom-rpc', state: 'sending', updatedAt: now() },
  }));
  // Journal persistence can invoke UI callbacks. Re-check immediately before
  // the only write request; no await separates this check from send().
  const sending = current();
  if (!active() || sending?.stage !== 'unknown' || sending.signature !== verified.signature || sending.submission?.state !== 'sending') {
    save(saved => ({ ...saved, submission: { route: 'custom-rpc', state: 'unknown', updatedAt: now(), errorCategory: 'ABORTED' } }));
    throw inactive();
  }
  try {
    const signature = await send(selectedEndpoint, verified.bytes, verified.signature);
    if (signature !== verified.signature) throw Object.assign(new Error('Invalid response'), { code: 'INVALID_RESPONSE' });
    save(saved => ({ ...saved, stage: saved.stage === 'verified' ? 'verified' : 'submitted',
      submission: { route: 'custom-rpc', state: 'accepted', updatedAt: now() },
    }));
    return signature;
  } catch (failure) {
    const submission = publicSubmission({ route: 'custom-rpc', state: 'unknown', updatedAt: now(),
      errorCategory: failure?.code, httpStatus: failure?.status, errorCode: failure?.rpcCode,
    });
    save(saved => ({ ...saved, stage: saved.stage === 'verified' ? 'verified' : 'unknown', submission }));
    throw error('SUBMISSION_UNKNOWN', 'Ответ RPC об отправке не подтверждён. Подпись сохранена; проверь результат этой операции.');
  }
}
