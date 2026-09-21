import { Connection, PublicKey } from '@solana/web3.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PROGRAMS } from '../chain/spec.mjs';
const expected = {
  core: '5680d2371204033f55cdcf0c08d393ed737d99cfe35d83f65befe80f7537484a',
  machine: '744fd03055950cbc496e844260e537f0e1a06c758df2726403aee726f212182c',
  guard: '376d2a57c501560cf78d36dc81d60ee864f7e2007e7d4c9a3785356f5b5975ee',
};
const rpc = new Connection(process.env.SOLANA_DEVNET_RPC || 'https://api.devnet.solana.com', { commitment: 'finalized', disableRetryOnRateLimit: true });
if (await rpc.getGenesisHash() !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1') throw Error('Devnet RPC required');
await mkdir('private/programs', { recursive: true });
for (const [name, address] of Object.entries(PROGRAMS)) {
  const program = await rpc.getAccountInfo(new PublicKey(address));
  if (!program?.executable || program.data.length !== 36) throw Error('Unexpected program account');
  const data = await rpc.getAccountInfo(new PublicKey(program.data.subarray(4, 36)));
  const bytes = data.data.subarray(45);
  if (createHash('sha256').update(bytes).digest('hex') !== expected[name]) throw Error(`Metaplex ${name} changed; review new program before updating the test snapshot`);
  await writeFile(`private/programs/${name}.so`, bytes);
  console.log(`Verified ${name} program`);
}
