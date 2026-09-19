// Read-only operator CLI. Input files must stay in private/ (never public-site).
import { readFile } from 'node:fs/promises';
import { createNoopSigner, signerIdentity } from '@metaplex-foundation/umi';
import { devnetUmi } from '../solana/builders.mjs';
import { prepareReveal, createRevealSession } from '../solana/reveal.mjs';

try {
  const paths = process.argv.slice(2);
  if (paths.length !== 3) throw Error('Expected map, commitment and inventory paths');
  const [map, commitment, inventory] = await Promise.all(paths.map(async path => JSON.parse(await readFile(path, 'utf8'))));
  const plan = prepareReveal({ ...inventory, map, commitment });
  const umi = devnetUmi().use(signerIdentity(createNoopSigner(plan.authority)));
  const session = createRevealSession(umi, plan, { planId: plan.id, cluster: 'devnet' }, () => {
    throw Error('Read-only preview cannot save or send');
  });
  const rows = await session.preview();
  console.log(JSON.stringify({ cluster: 'devnet', minted: rows.length,
    hidden: rows.filter(row => row.status === 'hidden').length,
    complete: rows.filter(row => row.status === 'complete').length,
    maximumTransactionBytes: Math.max(...rows.map(row => row.bytes)), sent: 0 }, null, 2));
} catch {
  // Avoid printing exception payloads that may contain a private URI or input.
  console.error('Reveal preview stopped. Check private inputs, authority and Devnet RPC. Nothing sent.');
  process.exitCode = 1;
}
