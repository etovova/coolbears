// Operator-only preparation/rehearsal module. Never include private inputs in the site.
import { createHash } from 'node:crypto';
import { publicKey } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { fetchAssetV1, fetchCollectionV1, updateV1, MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';
import { CID } from 'multiformats/cid';
import { assertDevnet, SITE } from './builders.mjs';
import { canDiscardPending } from './transactions.mjs';

const VERSION = 'solana-20260918';
const EARLIEST = Date.parse('2027-01-01T00:00:00Z'); // Lower bound, NOT a scheduled launch.
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const check = (ok, message) => { if (!ok) throw new Error(message); };

export function validateRevealMap(map, commitment) {
  check(commitment?.version === VERSION && commitment.algorithm === 'SHA-256' &&
    commitment.earliestRevealDate === '2027-01-01' && commitment.items === 10000,
  'Invalid reveal commitment');
  check(Array.isArray(map) && map.length === 10000 && hash(map) === commitment.hash,
    'Reveal map does not match saved commitment');
  let root;
  map.forEach((row, i) => {
    const id = String(i).padStart(4, '0');
    check(row.index === i && row.name === `CoolBears #${id}`, 'Invalid reveal index/name');
    const match = /^ipfs:\/\/([^/]+)\/metadata\/(\d{4})\.json$/.exec(row.uri);
    check(match && match[2] === id, 'Invalid reveal URI');
    const cid = CID.parse(match[1]).toString();
    root ??= cid;
    check(cid === root, 'Mixed reveal roots');
  });
  return structuredClone(map);
}

export function prepareReveal({ map, commitment, collection, authority, assignments }) {
  const rows = validateRevealMap(map, commitment);
  collection = publicKey(collection); authority = publicKey(authority);
  check(Array.isArray(assignments) && assignments.length > 0 && assignments.length <= 10000,
    'No valid minted-asset inventory');
  const indices = new Set(), addresses = new Set();
  const items = assignments.map(({ index, asset }) => {
    check(Number.isInteger(index) && index >= 0 && index < 10000 && !indices.has(index), 'Duplicate/invalid NFT index');
    asset = publicKey(asset);
    check(!addresses.has(asset) && asset !== collection, 'Duplicate/invalid NFT address');
    indices.add(index); addresses.add(asset);
    return { ...rows[index], asset };
  }).sort((a, b) => a.index - b.index);
  const plan = { version: VERSION, cluster: 'devnet', collection, authority, commitment: commitment.hash, items };
  return { ...plan, id: hash(plan) };
}

export function assertRevealTime(revealAt, chainTimeSeconds) {
  check(typeof revealAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(revealAt),
    'Explicit reveal time with UTC timezone is required');
  const at = Date.parse(revealAt);
  check(Number.isFinite(at) && new Date(at).toISOString() === revealAt.replace('Z', '.000Z') && at >= EARLIEST,
    'Reveal cannot be scheduled before 2027-01-01');
  check(Number.isSafeInteger(chainTimeSeconds) && chainTimeSeconds * 1000 >= at,
    'Reveal time has not arrived or chain time is unavailable');
}

export function inspectRevealItem(plan, item, collection, asset) {
  check(collection.header?.owner === MPL_CORE_PROGRAM_ID && asset.header?.owner === MPL_CORE_PROGRAM_ID,
    'Account is not owned by Metaplex Core');
  check(collection.publicKey === plan.collection && collection.updateAuthority === plan.authority,
    'Collection or update authority mismatch');
  check(asset.publicKey === item.asset && asset.updateAuthority?.type === 'Collection' &&
    asset.updateAuthority.address === plan.collection, 'NFT does not belong to expected collection');
  if (asset.name === item.name && asset.uri === item.uri) return 'complete';
  const id = String(item.index).padStart(4, '0');
  check(asset.name === `CoolBears #${id} — Hidden Bear` && asset.uri === `${SITE}/metadata/hidden/${id}.json`,
    'Unexpected NFT metadata; manual review required');
  return 'hidden';
}

// A new instance can resume from the journal. Always re-read on-chain accounts;
// a local "complete" record alone is never proof. No scheduler or mainnet sender.
export function createRevealSession(umi, inputPlan, journal, persist) {
  assertDevnet(umi);
  const plan = structuredClone(inputPlan);
  const { id, ...body } = plan;
  check(id === hash(body) && plan.cluster === 'devnet' && plan.version === VERSION, 'Invalid reveal plan');
  check(umi.identity.publicKey === plan.authority, 'Wrong signing wallet');
  check(journal.planId === plan.id && journal.cluster === 'devnet', 'Journal belongs to another reveal');
  check(typeof persist === 'function', 'Durable journal writer required');
  let busy = false;
  const read = async item => {
    const [collection, asset] = await Promise.all([
      fetchCollectionV1(umi, publicKey(plan.collection), { commitment: 'finalized' }),
      fetchAssetV1(umi, publicKey(item.asset), { commitment: 'finalized' })
    ]);
    return inspectRevealItem(plan, item, collection, asset);
  };
  const builder = item => updateV1(umi, {
    asset: publicKey(item.asset), collection: publicKey(plan.collection), authority: umi.identity,
    newName: item.name, newUri: item.uri
    // No owner, collection or authority change.
  });
  return {
    async preview() {
      const results = [];
      for (const item of plan.items) {
        const status = await read(item);
        const tx = builder(item);
        check(tx.fitsInOneTransaction(umi), 'Reveal transaction too large');
        results.push({ index: item.index, asset: item.asset, status, bytes: tx.getTransactionSize(umi) });
      }
      return results; // No final CID in ordinary preview output.
    },
    async run({ revealAt } = {}) {
      check(!busy, 'Reveal already running'); busy = true;
      try {
        assertDevnet(umi);
        check(umi.identity.publicKey === plan.authority, 'Wrong signing wallet');
        if (journal.pending) {
          const item = plan.items.find(row => row.asset === journal.pending.asset);
          check(item, 'Unknown pending asset');
          if (await read(item) === 'complete' || await canDiscardPending(umi.rpc, journal.pending)) {
            delete journal.pending; await persist(structuredClone(journal));
          } else throw new Error('Previous reveal is unresolved; retry is blocked');
        }
        for (const item of plan.items) {
          if (await read(item) === 'complete') continue;
          const slot = await umi.rpc.call('getSlot', [{ commitment: 'finalized' }]);
          const seconds = await umi.rpc.call('getBlockTime', [slot]);
          assertRevealTime(revealAt, seconds);
          const tx = builder(item);
          check(tx.fitsInOneTransaction(umi), 'Reveal transaction too large');
          const blockhash = await umi.rpc.getLatestBlockhash();
          const signed = await tx.setBlockhash(blockhash).buildAndSign(umi);
          check(signed.signatures[0]?.some(byte => byte !== 0), 'Missing transaction signature');
          const signature = base58.deserialize(signed.signatures[0])[0];
          journal.pending = { asset: item.asset, signature, lastValidBlockHeight: Number(blockhash.lastValidBlockHeight) };
          journal.transactions ||= [];
          journal.transactions.push({ asset: item.asset, signature });
          await persist(structuredClone(journal)); // Failure here prevents broadcast.
          await umi.rpc.sendTransaction(signed);
          const result = await umi.rpc.confirmTransaction(signed.signatures[0], {
            strategy: { type: 'blockhash', ...blockhash }, commitment: 'finalized'
          });
          check(!result.value.err, 'Reveal rejected by network; pending retained');
          check(await read(item) === 'complete', 'Finalized metadata not visible; pending retained');
          delete journal.pending; await persist(structuredClone(journal));
        }
        return { complete: plan.items.length };
      } finally { busy = false; }
    }
  };
}
