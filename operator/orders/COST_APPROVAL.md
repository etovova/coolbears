**PR46:** [явная проверка истечения попытки покупателя](EXPIRY_REVIEW.md) сохраняет
доказательство в SQLite и браузерном журнале. Старые claims не освобождаются;
новая подпись и повторная отправка этим этапом не разрешаются. Ниже — история этапов.

# Buyer quote approval and application cost ceiling

PR45 extends PR44 in the closed Devnet candidate. No public purchase UI, endpoint,
real signer or deployment is activated. Price remains 0.2 SOL; sales stay closed.

## Flow and scope

1. Prepare the original blockhash and durable asset partial as in PREPARATION.md.
2. Call `client.quoteCost()`. It uses the trusted HTTPS checker, validates the
   complete first-item arithmetic and exact intent, and returns a cost quote.
   It creates no buyer signature or browser approval. The gateway commits and
   reads back its quote before returning a successful signing check.
3. A future reviewed UI must show the components, total, full-order projection
   and chosen maximum. Only the user's explicit action may call
   `client.signOnly({authorizeCost:true, quoteId, maxTotalLamports})`.
   Amounts are canonical decimal lamport strings, never floating-point SOL.
   The default chosen maximum should be the shown first-item total. A larger
   maximum is permitted only as an explicit caller choice, never automatically.
4. The client requires the exact quote previously obtained by this instance,
   checks its binding and five-minute approval window, obtains a fresh prepared
   check, then compares the new total against the approved maximum. It commits
   the approval together with its one-use wallet claim and unknown event in a
   strict IndexedDB transaction, reads back the result, and only then opens the
   wallet. The fresh check still has its separate 20-second window and blockhash
   requirements. A five-minute quote does not extend the transaction lifetime.
5. A later explicit send reads the persisted consent, validates its lifetime and
   commits the local send claim. The fixed send transport forwards that approval;
   recovery has no consent requirement and stays read-only.
6. The gateway requires a byte-equivalent quote in its own durable quote store,
   records the approved cap with its permanent send claim, and runs the exact
   signed check. It verifies the cap and consent lifetime again immediately
   before outbound send, after RPC spacing. An accepted response binds the quote
   ID, approved cap and last checked total; it still does not prove execution.

Quote identities cover the prepared request, immutable order identity, source
check slot, issuance/expiry times and canonical cost components. This approval
covers only the first transaction of that request. Quantity 1–50 is used for the
explicit projection, not permission to spend that projected total or to execute
later items. Later transactions and retries require separate fresh consent.

## What is durable

`buyer-cost:v1:<quoteId>` stores each successful trusted check's cost quote in the
existing gateway SQLite object. Quotations share the same bounded checks/RPC
allowance. No quote or unknown-attempt record is deleted on expiry/restart.

Browser schema remains version2. The existing `wallet-claimed` record now has
record version2 and a nested cost approval, atomically with the prior order and
history transition. There is no separate approval state that could commit while
its wallet claim rolls back. The signed response and send proof remain in their
existing records. Server send claims retain the approval used for that request.

Reading historical consent does not require it to be unexpired. Starting a new
wallet invocation or send does. v1 wallet claims remain readable and recoverable,
but cannot obtain a new send claim without consent. No approval is manufactured
for older signatures. Older strict clients reject new v2 claims instead of
silently ignoring the additional requirement; upgrade clients together before
any future deployment. Real stored state was not migrated or cleared here.

Quote-only browser restart loses the in-memory quote and therefore requires a
fresh explicit quote/approval. A lost acknowledgment after the wallet claim was
committed preserves both consent and consumed intent, without invoking the wallet.
An over-limit result before the wallet claim leaves the order unchanged. An
error after a send claim retains that claim; expiry, a higher cap or another
quote must never become an automatic resend. Finalized recovery is still usable.

## Trust boundary and limitations

This is an **application-level ceiling checked against a simulation and RPC
quote**, not an on-chain maximum-debit instruction. Fees or state can change
between check and execution. Failed-transaction fees and future items are not
covered by a successful simulated-total guarantee. Do not market this as an
absolute final-wallet-debit cap.

The browser's explicit-action field and saved approval are application evidence,
not cryptographic proof that a human saw or clicked an approval screen. The
server authenticates its own quote; it cannot authenticate a human gesture or
the chosen cap from HTTP fields alone. Trusted application code, the reviewed
future UI and wallet approval remain boundaries. A compromised client can alter
its own state, and anyone holding fully signed transaction bytes can broadcast
outside this gateway. No claim of preventing that is made.

The checked total includes the gross 0.2 SOL price even where the closed test
owner is also treasury. It is not a measured net debit in that special profile.
No real user's cost consent was requested or synthesized. Fixtures deliberately
supply their own approvals and are never part of the public site bundle.

## Validation and remaining work

Node tests exercise exact arithmetic/types, conflicting identities, expired
approvals, fabricated quotes, durable server issuance, costs above and within
an explicitly chosen cap, failed quote persistence, legacy recovery, and altered
HTTP cost acknowledgments. Prior isolated sender tests inject explicit trusted
fixture quotes; new tests use actual prepare/check issuance.

Real workerd/SQLite tests restart between quote and send and prove that cost
rejection cannot release a send claim. Chromium uses native IndexedDB/CryptoKeys,
actual HTTPS checks and disposable Wallet Standard keys. It covers cap rejection,
explicit consent, atomic claim-ack loss, quote-only browser restart and legacy
readability. All outbound RPC is intercepted; real wallets/phones/transactions
are not tested here. Full results are recorded in the PR and continuation.

Next: reviewed abandoned/expired-attempt recovery and later items, custody
recovery policy, complete purchase UI/cost disclosure, real private configuration
and live read/simulation checks. Generated submission remains disabled. Preserve
lab2/2, real journals/bundles/custody/SQLite/locks, site/DNS/protections, secrets,
RPC plan and original art. No merge, deployment or sales activation in this stage.

Primary sources checked 2026-09-23:
- https://solana.com/docs/rpc/http/getfeeformessage
- https://solana.com/docs/rpc/http/sendtransaction
