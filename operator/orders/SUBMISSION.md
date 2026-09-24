**PR50:** [восстановление потерянного ответа кошелька](RESPONSE_RECOVERY.md) находит точные
подписанные байты только вместе с окончательным результатом. Ответ и исход
сохраняются атомарно; отсутствие истории не разрешает повтор. Ниже — история этапов.

**PR49:** [новая попытка после подтверждённой ошибки](FAILED_REPLACEMENT.md) требует явного
подтверждения уплаченной комиссии и отдельного свежего согласия на расходы.
Первая подпись, комиссия и история сохраняются; третья попытка заблокирована.
Продажи закрыты, цена 0,2 SOL. Ниже — история предыдущих этапов.

**PR48:** [восстановление окончательной ошибки и списанной комиссии](FAILURE_RECOVERY.md)
сохраняет доказательство на сервере и в браузере. Старые подписи и claims
сохраняются; повтор после ошибки требует отдельного этапа. Продажи закрыты,
цена 0,2 SOL. Ниже — история предыдущих этапов.

**PR47:** [одна новая попытка после сохранённого доказательства истечения](REPLACEMENT.md)
получает новый hash, отдельные записи и свежее согласие на расходы. Первая
подпись, claims и история сохраняются; третья попытка не разрешена. Продажи
закрыты, цена 0,2 SOL. Ниже — история предыдущих этапов.

**PR46:** [явная проверка истечения попытки покупателя](EXPIRY_REVIEW.md) сохраняет
доказательство в SQLite и браузерном журнале. Старые claims не освобождаются;
новая подпись и повторная отправка этим этапом не разрешаются. Ниже — история этапов.

**PR45:** [согласие на расчёт и предел расходов](COST_APPROVAL.md) сохраняется до вызова
кошелька; свежие расходы проверяются перед подписью и отправкой. Это предел
приложения по RPC/simulation, а не on-chain гарантия окончательного списания.
Старые evidence остаются доступны для recovery. Ниже — история этапов.

**PR44:** [подготовка с сохранённым исходным blockhash и полный бюджет первого NFT](PREPARATION.md)
теперь обязательны для buyer check/send. Бюджет всего заказа остаётся прогнозом;
старые попытки без server anchor не получают разрешения на новую подпись/отправку.
Продажи закрыты, цена 0,2 SOL, отправка по умолчанию выключена. Ниже — история этапов.

# First-item submission and finalized recovery — closed Devnet

PR43 connects a saved buyer response to an explicit, single-use send and a
read-only recovery path. The generated gateway entry still disables submission.
Nothing is deployed, and no real signatures, RPC calls or transactions were
used for validation. Sales remain closed at 0.2 SOL.

## Separate intent before I/O

`createBuyerSender({storage,scope,transport})` has two operations:

- `sendOnce({authorizeDevnetSend:true})` requires a saved exact buyer response,
  an unpaused order, persistent browser storage and no prior submission claim.
- `recover()` only reads the saved signature and verifies its result. It never
  sends, signs, replaces a blockhash, clears a claim or authorizes a retry.

`claimBuyerSubmission` commits an unknown event plus an append-only send claim
in one strict IndexedDB transaction, then validates their read-back before any
HTTP send. Failed publication/read-back, a lost acknowledgment, a closed browser
or another tab never make a consumed intent available again. An abort before
commit rolls the entire local mutation back. The database remains schema v2;
existing keys/orders/events are preserved, older PR42 readers fail closed on the
new fifth signing record. This is still a first-item/first-attempt integration.

The fixed same-origin HTTPS client binds a fresh nonce, complete order digest,
revision, request and signed bytes. It omits credentials, rejects redirects,
caps request/response size and has a 35-second fetch/body deadline. It performs
no retry. A raw HTTP timeout/error does not mean the transaction was not sent.

## Server-side independent claim and signed check

The separate Worker accepts `/api/buyer/send` only when built with
`makeBuyerGateway(config,{allowSubmission:true})`. Its default and the offline
prepared entry remain false; a caller/environment variable cannot enable it.
There is no mainnet path, generic RPC method or client-provided upstream URL.

Before simulation or submission, SQLite permanently consumes a key bound to
Devnet, machine, guard, collection, buyer and asset. It deliberately excludes
order ID, nonce and blockhash: rebuilding a caller's journal cannot evade it.
Restart, UTC quota rollover or key rotation cannot erase it. Corrupt/existing
records block sends. This claim is never released, even after preflight fails
or a request was definitely not sent. A future explicit retry review is separate.

The exact fully signed bytes are verified locally, simulated with sigVerify=true
and replaceRecentBlockhash=false, and checked against current full accounts,
closed guard, inventory, balance, known fee/base rent and current hash validity.
The send retains skipPreflight=false, confirmed commitment and maxRetries=0.
The RPC transport allows only the exact saved bytes and one send invocation;
its returned signature must match those bytes. The stored permanent claim is
checked again before outbound submission, within a monotonic freshness bound.
The existing global check/RPC/simulation counters, spacing and crash/cooldown
holds also apply. No hidden provider retries or public RPC fallback are added.

A returned `accepted` means only that the provider acknowledged these bytes.
It does not make the order verified. The browser retains unknown and its exact
signed bytes; acceptance acknowledgment is not needed for later recovery.
Automatic repetition is disallowed even after a failed simulation, missing
receipt or known execution failure. A temporary 45-second uncertainty hold may
also defer recovery after a lost upstream reply; the permanent send claim has
no expiry.

## Finalized verification

`/api/buyer/recover` is a bounded read-only route. It is available with submission
disabled and accepts only the pinned closed Devnet owner scope and exact saved
fully signed transaction. A supplied snapshot is not an authoritative registry.

The server checks Devnet genesis, queries the exact signature with historical
search and finalized base64 getTransaction, and verifies the entire returned
wire transaction, every signature, matching slot and consistent success/finality.
It then fetches the asset at finalized commitment at or after that slot, decodes
it with the pinned Core SDK, and verifies program, owner, collection and approved
hidden name/URI. A receipt alone or an existing asset alone is insufficient.
Missing/pending/failed/contradictory receipts, wrong bytes/accounts/metadata and
old account context leave the result unknown, with no retry authorization.

The browser checks report bindings and atomically appends the normalized verified
proof with the order transition. CAS rejects a changed order after the HTTP
request. Proof-write failure leaves unknown; losing the acknowledgment after a
successful write is recovered from existing history without a duplicate event
or network request. Recovery may preserve a paused order while recording facts.
It does not unpause, advance to another item or open a wallet.

The normalized proof is trusted adapter input, not an on-chain cryptographic
certificate. Trust still includes the bound RPC and same-origin application.
No hostile same-origin script or dishonest RPC guarantee is claimed. Current
account ownership/metadata must match this closed profile; a subsequently
transferred/updated asset may require a future separate recovery policy.

## Limits and validation

This is a closed Devnet implementation candidate. Complete protocol/full-order
cost disclosure, original blockhash provenance/lifetime, explicit failed/expired
retry review, remaining items, production anti-abuse/authentication, actual
private configuration, UI and physical-wallet checks are still needed. Do not
use it as production purchase readiness. `readyToSubmit` and `salesOpen` remain
false in reports and saved state. No changes to the completed 2/2 lab, real
journals/custody/SQLite, site/DNS/protections, RPC secrets, Helius plan or originals.

Node tests exercise independent signature validation, signed simulation, exact
send flags, permanent claims/replay/concurrency, malformed/pending/failed/wrong
receipts, account identity, bounded HTTP and local acknowledgment loss.
`order-submission.runtime.mjs` uses real workerd and SQLite across restarts.
`order-submission.browser.mjs` links native IndexedDB/CryptoKeys, HTTPS, workerd,
intercepted RPC and a disposable Wallet Standard signer; it tests lost replies,
atomic write failures, stale proofs, two tabs and full process restarts.
RPC data, owner policy/key, TLS certificate and storage permission are fixtures;
no live RPC, real wallet, phone or network transaction is claimed.

Primary references checked for this stage:
- https://solana.com/docs/rpc/http/sendtransaction
- https://solana.com/docs/rpc/http/gettransaction
- https://www.metaplex.com/docs/smart-contracts/core/fetch
