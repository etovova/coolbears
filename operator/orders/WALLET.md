**PR45:** [согласие на расчёт и предел расходов](COST_APPROVAL.md) сохраняется до вызова
кошелька; свежие расходы проверяются перед подписью и отправкой. Это предел
приложения по RPC/simulation, а не on-chain гарантия окончательного списания.
Старые evidence остаются доступны для recovery. Ниже — история этапов.

**PR44:** [подготовка с сохранённым исходным blockhash и полный бюджет первого NFT](PREPARATION.md)
теперь обязательны для buyer check/send. Бюджет всего заказа остаётся прогнозом;
старые попытки без server anchor не получают разрешения на новую подпись/отправку.
Продажи закрыты, цена 0,2 SOL, отправка по умолчанию выключена. Ниже — история этапов.

**PR43:** добавлены [одноразовая отправка и finalized recovery](SUBMISSION.md)
первого подписанного Devnet-item. Browser/SQLite claims записываются до I/O;
потеря ответа разрешает только проверку сети. Отправка по умолчанию выключена,
endpoint не опубликован, полный бюджет и production UI ещё не готовы.
Ниже сохранены описания прежних этапов.

# Buyer sign-only handoff — closed Devnet

The first existing asset partial of a new order can pass to a Wallet Standard
wallet exactly once. This is a library integration, not a deployed purchase UI
or public endpoint. Sales remain closed at 0.2 SOL. Nothing here broadcasts.

## Trusted fresh check

`checkPreparedOrder` in `preflight.mjs` checks a revision-1, unpaused, first-item
asset partial against the canonical SDK message and saved claim. It runs the
existing bounded RPC transport, genesis, finalized machine/guard/collection,
all asset absence, inventory, balance, fee/rent, exact unsigned simulation and
post-simulation freshness/order checks. It never requests a new blockhash or
replans an existing attempt. The original partial bytes are simulated with
sigVerify=false and replaceRecentBlockhash=false; their asset signature is
verified locally before RPC. Ordinary buyers still receive SALES_CLOSED.

A passed `closed-devnet-sign-only-check` report grants only sign-only handoff
for the exact request, order digest/revision and 20-second window. This internal
report has readyToSign=true; readyToSubmit and salesOpen remain false. The older
fresh-order preview still returns readyToSign=false. The client verifies all
bindings plus wall-clock and monotonic deadlines before calling the wallet.

The fee/rent quote is still a known minimum, not a complete protocol/full-order
budget. Stored lastValidBlockHeight is input metadata; current isBlockhashValid
and height are rechecked, but metadata does not independently prove its original
RPC origin or guarantee a future expiry window. This is closed-profile Devnet
signing only. A live purchase integration still needs complete cost disclosure,
submission checks and deployment of the separate buyer gateway. No public purchase readiness
is inferred from this result.

The client's `checkPrepared` constructor dependency must be a trusted adapter
that actually executes this check against the configured RPC. Do not implement
it as an echo of a caller's booleans or accept reports from URLs/UI/localStorage.
PR42 adds the fixed same-origin HTTPS adapter in `gateway/client.mjs` and a
separate closed Devnet check Worker; see [gateway boundaries](gateway/README.md).
Its integrated browser test runs the real transport/checker in local workerd
with intercepted RPC, not live Devnet. Earlier wallet-only tests retain their
explicitly named checker fixture. No endpoint has been deployed.

## Durable invocation and response

`createBuyerWalletClient` accepts a selected Wallet Standard wallet supporting
solana:devnet, version 0 and solana:signTransaction. Its account address and raw
public key must match the original buyer, and the account must advertise the
chain and feature. It calls only signTransaction, once, with the exact partial.
There is no signAndSendTransaction fallback or implicit wallet selection.

Before calling the wallet, `claimBuyerWallet` atomically appends an unknown event
and wallet claim in the existing IndexedDB signing store, then reads them back.
Revision advances from 1 to 2. Every later invocation is blocked, including after
an explicit rejection, timeout, closing a tab or failure after the claim commit.
Web Locks/CAS prevent competing claims. Locks cover storage operations only;
the consumed durable claim protects the asynchronous wallet interval.

The wallet result must preserve the message and asset signature and carry a
strict valid signature from the original buyer. `saveBuyerResponse` atomically
appends the verified bytes and signature event, then verifies their read-back.
A callback, even one after a timeout or account change, is evidence only: the
order stays unknown, readyToSubmit=false. Finalized recovery and a separately
authorized sender remain future work.

Saving the identical response again is idempotent, without a duplicate journal
event. A different claim or response is rejected. Failure before commit leaves
only the consumed claim. The client keeps verified bytes in memory so `recover`
can retry their persistence without invoking the wallet. If commit succeeds but
its acknowledgment is lost, recovery/reload returns the saved bytes. If both
browser process and unsaved response are lost, the attempt remains unknown.

Every read validates the signing records and their exact journal events, and
re-verifies the saved transaction against the historical order before its
signature event. Corruption blocks reads/writes; nothing is cleared or replaced.
The database remains schema v2; two append-only record phases extend its signing
store. Earlier PR40 readers fail closed on these new records. Existing PR39/40
orders/keys/events are preserved. Generic `append` is still only a model primitive,
not an authenticated chain or wallet adapter.

## Browser storage and lifecycle

`navigator.storage.persisted()` must be true before checking and again before
wallet invocation. No plaintext fallback and no automatic permission request.
A future UI can explicitly call `requestPersistence` after explaining storage
loss. A denied/unsupported/hung persistence API blocks signing. Persistent
storage reduces eviction risk; it does not protect against deletion by the user,
device/profile/origin loss, XSS, or replace a custody backup. Missing orders do
not trigger automatic recreation.

Connect has a 15-second bound; the checker has a 35-second client wait plus its
30-second execution budget. Wallet response wait defaults to 120 seconds and
can be configured up to 180 seconds. Timing out does not cancel a wallet prompt
or grant a retry. A late result is still validated and saved once if the context
survives. `dispose` blocks new calls and account selection; it does not discard
valid response evidence from an invocation already made.

## Validation and sources

`order-preflight.test.mjs`: prepared-byte checks through the real bounded RPC
transport, closed guard, stale order/network/hash, no refresh and report binding.
`order-wallet.browser.mjs`: real IndexedDB/CryptoKeys, fake Wallet Standard and
trusted-check/persistence-permission fixtures. Covers full restart, atomic claim
and response failure, lost acknowledgment, wrong account, timeout/late response,
account change, two tabs, closing a tab and corrupted saved bytes. No real wallets,
phones, persistent-storage permission grant, live RPC or network transactions.

- Wallet Standard: https://github.com/wallet-standard/wallet-standard
- Solana wallet features: https://github.com/solana-labs/wallet-standard
- Phantom signing: https://docs.phantom.com/solana/sending-a-transaction
- Storage persistence: https://storage.spec.whatwg.org/
