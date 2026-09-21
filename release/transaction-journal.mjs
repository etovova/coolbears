// Durable transaction identity: a timeout never authorizes a replacement mint.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { base58 } from '@metaplex-foundation/umi/serializers';

export function transactionJournal({ umi, state, save, record = async () => {},
  now = Date.now, wait = delay, confirmationMs = 40000, pollMs = 2000 }) {
  const pending = new Map();
  async function status(signature) {
    const [result] = await umi.rpc.getSignatureStatuses([base58.serialize(signature)], { searchTransactionHistory: true });
    return result;
  }
  async function executeOnce(label, builder, verify) {
    let receipt = state.receipts[label];
    if (receipt) {
      const found = await status(receipt.signature);
      assert.ok(found && ['confirmed', 'finalized'].includes(found.commitment), `Saved ${label} is still unresolved; do not resend`);
      assert.equal(found.error, null, `Saved ${label} failed on-chain`);
    } else {
      const blockhash = await umi.rpc.getLatestBlockhash({ commitment: 'confirmed' });
      const signed = await builder.useLegacyVersion().setBlockhash(blockhash).buildAndSign(umi);
      const simulation = await umi.rpc.simulateTransaction(signed, { commitment: 'confirmed', verifySignatures: true });
      assert.equal(simulation.err, null, `${label} simulation failed`);
      receipt = { signature: base58.deserialize(signed.signatures[0])[0], ...blockhash,
        signedBytes: Buffer.from(umi.transactions.serialize(signed)).toString('base64'), status: 'saved-before-send' };
      state.receipts[label] = receipt; await save();
      const returned = await umi.rpc.sendTransaction(signed, { commitment: 'confirmed', preflightCommitment: 'confirmed', skipPreflight: false, maxRetries: 0 });
      assert.equal(base58.deserialize(returned)[0], receipt.signature);
      receipt.status = 'submitted'; await save();
      const deadline = now() + confirmationMs; let confirmed = false;
      while (now() < deadline) {
        const found = await status(receipt.signature);
        if (found) {
          assert.equal(found.error, null, `${label} failed on-chain`);
          if (['confirmed', 'finalized'].includes(found.commitment)) { confirmed = true; break; }
        }
        await wait(pollMs);
      }
      assert.ok(confirmed, `${label} confirmation pending; signature saved, do not resend`);
    }
    // Later steps intentionally change earlier state (guard, owner, metadata).
    // Historical verified receipts are not checked against an obsolete state.
    // The caller must validate the complete final state after the sequence.
    if (receipt.status !== 'verified') {
      await verify(); receipt.verifiedAt = new Date(now()).toISOString();
      receipt.status = 'verified'; await save();
    }
    await record(label, receipt);
    return receipt;
  }
  return function execute(label, builder, verify) {
    // Coalesce repeated clicks before signing, simulation or persistence can
    // yield. A saved receipt protects restarts; this protects in-flight calls.
    if (pending.has(label)) return pending.get(label);
    const task = Promise.resolve().then(() => executeOnce(label, builder, verify))
      .finally(() => pending.delete(label));
    pending.set(label, task);
    return task;
  };
}
