**PR47:** [одна новая попытка после сохранённого доказательства истечения](../REPLACEMENT.md)
получает новый hash, отдельные записи и свежее согласие на расходы. Первая
подпись, claims и история сохраняются; третья попытка не разрешена. Продажи
закрыты, цена 0,2 SOL. Ниже — история предыдущих этапов.

**PR46:** [явная проверка истечения попытки покупателя](../EXPIRY_REVIEW.md) сохраняет
доказательство в SQLite и браузерном журнале. Старые claims не освобождаются;
новая подпись и повторная отправка этим этапом не разрешаются. Ниже — история этапов.

**PR45:** [согласие на расчёт и предел расходов](../COST_APPROVAL.md) сохраняется до вызова
кошелька; свежие расходы проверяются перед подписью и отправкой. Это предел
приложения по RPC/simulation, а не on-chain гарантия окончательного списания.
Старые evidence остаются доступны для recovery. Ниже — история этапов.

**PR44:** [подготовка с сохранённым исходным blockhash и полный бюджет первого NFT](../PREPARATION.md)
теперь обязательны для buyer check/send. Бюджет всего заказа остаётся прогнозом;
старые попытки без server anchor не получают разрешения на новую подпись/отправку.
Продажи закрыты, цена 0,2 SOL, отправка по умолчанию выключена. Ниже — история этапов.

**PR43:** добавлены [одноразовая отправка и finalized recovery](../SUBMISSION.md)
первого подписанного Devnet-item. Browser/SQLite claims записываются до I/O;
потеря ответа разрешает только проверку сети. Отправка по умолчанию выключена,
endpoint не опубликован, полный бюджет и production UI ещё не готовы.
Ниже сохранены описания прежних этапов.

# Closed Devnet buyer check gateway

PR42 adds a separate **candidate**, not a deployed endpoint. HTTPS POST
`/api/buyer/check` runs the existing exact prepared-order checker. Browser
`createBuyerCheckClient()` is a constructor dependency for
`createBuyerWalletClient({checkPrepared: ...})`. It takes no RPC URL or secret.
Sales stay closed, price 0.2 SOL. No signer, sender, retry authorization, public
purchase UI or modifications to the existing site/lab/private operator gateway.

## Fixed trust boundary

The Worker entry pins Devnet, one HTTPS origin and one machine/guard/collection.
The bounded canonical JSON request contains only version, fresh nonce, order,
asset claim and exact prepared request. It must be an unpaused revision-1 order,
first asset partial, with the approved owner as buyer. Ordinary buyers are
rejected before RPC. The full checker independently verifies genesis, full SDK
account/config-line state, closed guard/price, inventory, absence of all assets,
balance, known fee/base rent, exact simulation, and freshness after simulation.
It never refreshes the saved blockhash, changes bytes or creates signatures.

Only the checker's eight RPC methods can reach the fixed Helius Devnet origin.
The `BUYER_HELIUS_API_KEY` server secret is never sent to the browser. Request
headers/URLs/methods from the caller cannot select or configure upstream RPC.
Redirects are not followed. Provider error text is not returned or logged.

Origin checks are **not authentication**: a nonbrowser caller can spoof Origin
and replay an owner's unsigned request to consume the bounded global allowance.
This is a closed Devnet check candidate, not a complete public anti-abuse system.
The server checks a supplied order snapshot; it is not an authoritative custody
registry. The browser must recheck its current journal through the durable CAS
wallet claim after the HTTP response. Changing/pausing the order meanwhile
blocks the wallet even if the server correctly verified the earlier snapshot.

The response echoes a random per-call nonce and binds the exact request/order
hashes, bytes and a 20-second signing window. The browser rejects stale, altered
or unrelated responses. It uses a fixed same-origin HTTPS path, omits cookies
and Authorization, forbids redirects/caching and caps the complete fetch/body
wait at 35 seconds. There is no automatic retry or alternative RPC endpoint.

## Bounded durable accounting

One SQLite Durable Object `buyer-check-global-v1` handles every check. Identity
does not depend on caller, origin, deployment address or rotating credential.
Daily limits count checks/RPC calls/simulations, **not Helius credit units or the
account billing limit**. Defaults are 100 / 2000 / 100; configuration cannot
exceed 500 / 5000 / 500. Allowances are charged transactionally before I/O and
never refunded. UTC day rollover can reset counters; clock rollback cannot.
Persisted state corruption or storage failure blocks further work.

One whole check runs at a time, upstream calls are spaced by at least 200 ms,
and a persisted 45-second hold covers a lost process/response. Normal completion
releases that hold; uncertain transport retains it. Provider 429/503 also records
a bounded 1–300 second cooldown. Future callers may receive a longer retry time
from the hold. Restart and credential rotation retain charges and cooldown.
The request is capped at 64 KiB/4 seconds, response at 16 KiB, upstream response
at 4 MiB, each RPC at 12 seconds, and the checker at 30 seconds. Generic RPC,
JSON batches, unexpected fields and malformed/duplicate JSON keys are rejected.

## Offline preparation only

From the repository root, with an existing validated order and intended HTTPS
origin:

```sh
node operator/orders/gateway/prepare.mjs /absolute/path/order.json https://example.invalid
```

This writes a **new** ignored `private/` directory beside this README, mode 0700,
with pinned `config.json` and `entry.mjs` mode 0600. It refuses overwrite and
symlink order inputs, requires no password and performs no network calls.
The scope is only an offline candidate; this does not prove the deployment
exists. Do not use or change the completed two-item laboratory deployment.

`wrangler.jsonc` has its own Worker/SQLite binding, workers.dev and preview URLs
disabled, and deliberately no live route. A future reviewed deployment must
supply a separate server secret and exactly the pinned same-origin path. No
secret, private config, route or Worker was installed in this PR. Leave the lab
and private deployment endpoint, secrets, CORS and ledgers unchanged.

## Coverage and remaining work

Node tests cover protocol/transport boundaries, exact 1/50-item order checks,
concurrency, quota persistence, clock rollback, upstream errors, corruption and
offline preparation. The same checker now has a worker-compatible factory;
existing Node wrappers retain their prior shared-policy behavior.

`order-gateway.runtime.mjs` uses real workerd + SQLite across full restarts.
`order-gateway.browser.mjs` links native Chromium IndexedDB/CryptoKeys, real HTTPS
transport, workerd/SQLite and the exact checker through intercepted full SDK
account fixtures to a disposable Wallet Standard signer. The test certificate,
owner policy/key, persistence permission and RPC data are explicit fixtures.
There are no real wallets, physical phones, live RPC calls or network transactions.

Still required: actual private deployment setup, live read/simulation checks,
complete protocol/full-order cost disclosure, provenance/lifetime checks for the
original blockhash, buyer submission/finalized recovery and a reviewed purchase
UI. A passed report grants only this closed Devnet sign-only handoff. It remains
`readyToSubmit=false`, `salesOpen=false`, and the stored signed attempt stays
unknown until an independently verified recovery path exists.

Primary implementation references:
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- https://developers.cloudflare.com/workers/configuration/secrets/
- https://solana.com/docs/rpc/http/simulatetransaction
