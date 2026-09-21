import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transaction, VersionedTransaction, SystemProgram, PublicKey } from '@solana/web3.js';
const preload = fileURLToPath(new URL('../cli-transport.mjs', import.meta.url));
const payer = new PublicKey('BjstMSoKGXKyDNgR6VegPkHbxBmdY7LHu8FXbrBmvqyF');
const other = new PublicKey('FNytKprG3JukM81svBhCrgHAEHht3oUgpXZFUkUbCW6y');
function bytes(feePayer = payer) {
  const legacy = new Transaction({ feePayer, recentBlockhash: SystemProgram.programId.toBase58() }).add(SystemProgram.transfer({ fromPubkey: feePayer, toPubkey: other, lamports: 1 }));
  const tx = new VersionedTransaction(legacy.compileMessage()); tx.signatures[0].fill(1);
  return Buffer.from(tx.serialize()).toString('base64');
}
const send = data => `await fetch(process.env.COOLBEARS_RPC_URL, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'sendTransaction',params:[${JSON.stringify(data)},{encoding:'base64'}]})});`;
async function fixture(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'coolbears-cli-transport-'));
  await writeFile(path.join(dir, 'curl'), `#!/usr/bin/env node
const fs=require('node:fs');let body='';process.stdin.on('data',x=>body+=x);process.stdin.on('end',()=>{const b=JSON.parse(body);fs.appendFileSync(process.env.MOCK_CALLS,b.method+'\\n');if(b.method==='sendTransaction'&&!fs.existsSync(process.env.COOLBEARS_LAB_OPERATION+'/signed-transaction.json'))process.exit(90);let result=b.method==='getGenesisHash'?(process.env.MOCK_GENESIS||'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'):b.method==='simulateTransaction'?{value:{err:null,logs:[],unitsConsumed:1}}:'recorded-signature';process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:b.id,result})+'\\n200');});`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, COOLBEARS_RPC_URL: 'https://rpc.example.invalid', MOCK_CALLS: path.join(dir, 'calls'), COOLBEARS_LAB_OPERATION: path.join(dir, 'operation') };
  try { await run({ dir, env, invoke: (script, overrides = {}) => spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e', script], { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15000 }) }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
test('the default transport refuses submissions without accessing RPC', async () => fixture(async ({ invoke, dir }) => {
  const result = invoke(send(bytes()), { COOLBEARS_LAB_OPERATION: '' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /READ_ONLY_TRANSPORT/);
  await assert.rejects(readFile(path.join(dir, 'calls')), { code: 'ENOENT' });
}));
test('wrong cluster and an existing operation stop before signing or submission', async () => fixture(async ({ invoke, env, dir }) => {
  const wrong = invoke('', { MOCK_GENESIS: 'mainnet' });
  assert.notEqual(wrong.status, 0); assert.match(wrong.stderr, /DEVNET_ONLY/);
  const before = await readFile(path.join(dir, 'calls'), 'utf8');
  const repeat = invoke(send(bytes()));
  assert.notEqual(repeat.status, 0); assert.match(repeat.stderr, /EEXIST/);
  assert.equal(await readFile(path.join(dir, 'calls'), 'utf8'), before);
}));
test('an owner-wallet transaction cannot be submitted by the lab transport', async () => fixture(async ({ invoke, dir }) => {
  const result = invoke(send(bytes(other)));
  assert.notEqual(result.status, 0); assert.match(result.stderr, /LAB_PAYER_ONLY/);
  assert.equal(await readFile(path.join(dir, 'calls'), 'utf8'), 'getGenesisHash\n');
}));
test('signed bytes are stored before forwarding, and a second send is refused', async () => fixture(async ({ invoke, dir }) => {
  const result = invoke(send(bytes()) + send(bytes()));
  assert.notEqual(result.status, 0); assert.match(result.stderr, /ONE_TRANSACTION_PER_OPERATION/);
  assert.equal(await readFile(path.join(dir, 'calls'), 'utf8'), 'getGenesisHash\nsimulateTransaction\nsendTransaction\n');
  const record = JSON.parse(await readFile(path.join(dir, 'operation/signed-transaction.json'), 'utf8'));
  assert.equal(record.base64, bytes()); assert.equal(record.accounts[0], payer.toBase58());
}));
