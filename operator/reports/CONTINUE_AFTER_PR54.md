# Continue after PR54: reviewed replacement after unsigned expiry

Base is completed PR54, d9a6835f9d4ae79c2433761afe913b645b997fe3. Its full CI
36048655536 passed; do not rerun or wait for PR52/53/54.

This change adds the next separate stage: explicit reviewed replacement after
the first canonical native claim was retired by prewallet expiry. A dedicated
unsigned route retains the actual proof and null buyer signature. Version 4
binds one new candidate to that first claim. Browser history, the optional old
partial and original keys remain intact. The second native claim must commit
and be read back before signing; fresh wallet cost consent remains required.

See operator/orders/PREWALLET_EXPIRY_REPLACEMENT.md for the evidence boundary,
durability rules and limitations. A second claim is the last supported attempt;
no third attempt or automatic retry is added.

This report is written before commit/CI. Completed results belong in the draft
PR description and current CoolBears_Collection(1).md checkpoint. Local bundle
compilation does not establish Chromium success. Only completed CI at the exact
saved head can establish the full browser result.

Still unfinished: actual wallet invocation with lost response and no positive
proof; missing unsigned claim/custody; later items/full-order consent; reviewed
purchase UI; private setup and read/simulation gates. Trust Wallet was checked
as a compatibility candidate, not implemented or tested with a real wallet.
Do not add its name as a claim of tested support.

Constraints: sales closed, 0.2 SOL, generated sender disabled. No merge,
deployment, real wallet signing or blockchain sends. Do not repeat Lab2/2.
Do not clear actual journals, custody, bundles, SQLite or locks. Preserve RPC
secrets/CORS/ledger/Helius, website/DNS/protection and all original collection
art. All automated tests use disposable fixture keys and intercepted RPC.
