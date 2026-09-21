// Read fresh executable programs from Devnet for the separate local VM test.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { DEVNET_GENESIS } from './settings.mjs';
const endpoint = process.env.COOLBEARS_DEVNET_RPC || 'https://api.devnet.solana.com';
assert.equal(new URL(endpoint).protocol, 'https:');
const directory = new URL('../private/programs/', import.meta.url);
await mkdir(directory, { recursive: true });
async function rpc(method, params = []) {
  return await new Promise((resolve, reject) => {
    const child = spawn('curl', ['--silent', '--show-error', '--fail', '--max-time', '30',
      '--header', 'Content-Type: application/json', '--data-binary', '@-', endpoint]);
    const chunks = []; let size = 0;
    child.stdout.on('data', b => { size += b.length; if (size > 24_000_000) child.kill(); else chunks.push(b); });
    child.stderr.resume(); child.on('error', reject);
    child.on('close', code => {
      if (code) return reject(Error('Devnet program download failed'));
      try { const json = JSON.parse(Buffer.concat(chunks)); assert.ok(!json.error, 'Devnet RPC error'); resolve(json.result); }
      catch (error) { reject(error); }
    });
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
  });
}
assert.equal(await rpc('getGenesisHash'), DEVNET_GENESIS);
const ids = ['CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
  'CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J', 'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ'];
const options = { encoding: 'base64', commitment: 'finalized' };
const programs = await rpc('getMultipleAccounts', [ids, options]);
const addresses = programs.value.map(account => {
  assert.ok(account?.executable); assert.equal(account.owner, 'BPFLoaderUpgradeab1e11111111111111111111111');
  const bytes = Buffer.from(account.data[0], 'base64'); assert.equal(bytes.readUInt32LE(), 2);
  return base58.deserialize(bytes.subarray(4, 36))[0];
});
const data = await rpc('getMultipleAccounts', [addresses, options]);
const records = [];
for (let i = 0; i < ids.length; i++) {
  const account = data.value[i]; assert.equal(account.owner, 'BPFLoaderUpgradeab1e11111111111111111111111');
  const bytes = Buffer.from(account.data[0], 'base64'); assert.equal(bytes.readUInt32LE(), 3);
  const executable = bytes.subarray(45); assert.equal(executable.subarray(0, 4).toString('hex'), '7f454c46');
  await writeFile(new URL(`${ids[i]}.so`, directory), executable);
  records.push({ program: ids[i], programData: addresses[i], deploymentSlot: bytes.readBigUInt64LE(4).toString(),
    bytes: executable.length, sha256: createHash('sha256').update(executable).digest('hex') });
}
const report = { checkedAt: new Date().toISOString(), cluster: 'devnet', finalizedReadSlot: data.context.slot, programs: records };
await writeFile(new URL('./reports/programs.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
