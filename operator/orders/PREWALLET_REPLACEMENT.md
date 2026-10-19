# Reviewed replacement after recovered prewallet failure

PR52 can preserve an exact finalized failed transaction and its charged fee even
when the local journal has no wallet claim. That historical evidence can now
support one separately reviewed replacement, without inventing a past wallet
invocation or cost approval. Unknown, incomplete-history and verified outcomes
cannot use this path. The original signed bytes remain permanently unsendable.

`prewalletRecovery.prepareReplacement({authorizeReplacement:true,
acknowledgedFeeLamports})` reads a validated terminal record through
`storage.readPrewalletReplacement(scope)`. The acknowledgment must exactly equal
the already charged fee. It then uses the existing `replace` transport. This
operation prepares a candidate only: it neither signs nor sends, and changes no
browser rows. A future interface must present the paid fee and ask for explicit
review; the adapter supplies no implicit consent.

The gateway requires its exact retained prewallet claim hash, response, final
proof and fee/balance evidence. Ordinary failure/expiry/discovery/send records
cannot substitute for or contradict that provenance. It rereads finalized asset
absence at the proper account floor, then obtains a different blockhash with a
newer context and lifetime. A transactional comparison against the retained
source precedes a version-3 replacement record. That record binds the complete
original prewallet evidence, normalized fee identity, candidate and acknowledgment
into its digest. No ordinary first-attempt failure record or send claim is added.

The same candidate restores after lost reply, SQLite restart and credential
rotation without another RPC call. Wrong/missing acknowledgment still fails,
including cached restoration. A second checker requires version-3 provenance to
match the retained original record and rejects conflicting old terminal/send
records. The canonical original SDK claim is independently reconstructed when
validating the replacement; corrupted claim hashes or observed bytes fail closed.

Browser preparation remains a separate explicit
`prepareReplacementSigning(...,{authorizeReplacementSigning:true,
acknowledgedFeeLamports})` step. It preserves all first-attempt rows, compares the
candidate against the current revision and fee record, and commits the second
native claim before signing. A prewallet terminal state can legitimately have
revision 2; its second claim therefore starts at revision 3. No dummy pause,
wallet or signature events pad the journal. Higher-layer replacement provenance
and full event replay still gate this lower revision. Aborted claim writes cause
no signature; retained native-result recovery handles a failed ready write.

The historical failure validator verifies the actual terminal order and exact
signatures/fee evidence directly. Ordinary active-response validation remains
unchanged, as do version-1 expiry and version-2 paid-failure replacement records.
This avoids fabricating active history solely to validate a historical fee.

The new second attempt uses the existing fresh checker, cost quote, explicit
wallet cost approval and single-use send protocol. Two failed attempts preserve
both charged fees; no third attempt is enabled. Pause/resume rebinds the cached
candidate while stale candidates fail without signing. Later items, truly missing
native/unsigned retirement, custody recovery and purchase UI remain separate work.

Validation includes five new Node cases, four real workerd/SQLite cases and six
Chromium scenarios using real IndexedDB/WebCrypto with disposable fixtures. The
runtime sends two intercepted fixture transactions; real transactions are zero.
Local Chromium is unavailable, so completed CI must establish browser success.
No phone, real wallet or live-Devnet validation is claimed.

Primary source checked: https://solana.com/docs/core/transactions — atomic
instruction execution does not refund the transaction fee on failure.
Trusted same-origin gateway/storage remain the evidence boundary; normalized
records are not independent chain certificates. Sales closed, price 0.2 SOL,
generated sender disabled. No merge, deployment, real signature or network send.
