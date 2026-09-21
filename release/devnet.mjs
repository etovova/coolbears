// Isolated integration lab using official Metaplex builders. Never uses the
// production owner as signer, opens production guards, or reveals private art.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createSignerFromKeypair, generateSigner, signerIdentity, publicKey, some } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { mplCore, fetchCollection, fetchAsset, update, transfer } from '@metaplex-foundation/mpl-core';
import { mplCandyMachine, fetchCandyMachine, fetchCandyGuard, findCandyGuardPda, mintV1, updateCandyGuard } from '@metaplex-foundation/mpl-core-candy-machine';
import { setComputeUnitLimit } from '@metaplex-foundation/mpl-toolbox';
import { DEVNET_GENESIS, CLOSED_UNTIL, policy, closedGuards, collectionBuilder, assetBuilder, machineBuilder } from './settings.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const privateDir = path.join(root, 'private');
await fs.mkdir(privateDir, { recursive: true });
const statePath = path.join(privateDir, 'devnet-state.json');
const reportPath = new URL('./reports/devnet.json', import.meta.url);
let state = { version: 1, receipts: {}, signers: {}, checks: [] };
try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
state.checks ||= [];
async function save() {
  const temporary = statePath + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temporary, statePath);
}
const report = { checkedAt: new Date().toISOString(), scope: 'real Devnet only', status: 'running', checks: [], transactions: [] };
async function saveReport() {
  await fs.mkdir(new URL('./reports/', import.meta.url), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}

// One endpoint, a hard deadline for the complete response, no automatic retry.
async function boundedFetch(url, init) {
  // Hosted test environments may route HTTPS through a proxy. curl honors
  // that environment. This adapter is for the Node lab only, never the UI.
  if (process.env.COOLBEARS_LAB_CURL === '1') {
    return await new Promise((resolve, reject) => {
      const child = spawn('curl', ['--silent', '--show-error', '--max-time', '25',
        '--header', 'Content-Type: application/json', '--data-binary', '@-',
        '--write-out', '\n%{http_code}', String(url)], { stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks = []; let length = 0;
      child.stdout.on('data', chunk => { length += chunk.length; if (length > 20_000_000) child.kill(); else chunks.push(chunk); });
      child.stderr.resume(); child.on('error', reject);
      child.on('close', code => {
        if (code !== 0) return reject(Error('Lab RPC request did not complete'));
        const output = Buffer.concat(chunks).toString(); const split = output.lastIndexOf('\n');
        resolve(new Response(output.slice(0, split), { status: Number(output.slice(split + 1)) }));
      });
      child.stdin.on('error', reject); child.stdin.end(init.body);
    });
  }
  const controller = new AbortController(); let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { ...init, signal: controller.signal });
        const body = await response.text();
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('RPC deadline exceeded')); }, 25000); }),
    ]);
  } finally { clearTimeout(timer); }
}
const endpoint = process.env.COOLBEARS_DEVNET_RPC || 'https://api.devnet.solana.com';
assert.equal(new URL(endpoint).protocol, 'https:', 'Devnet HTTPS RPC required');
const umi = createUmi(endpoint, { commitment: 'confirmed', fetch: boundedFetch, disableRetryOnRateLimit: true }).use(mplCore()).use(mplCandyMachine());
const payerKey = umi.eddsa.createKeypairFromSecretKey(Uint8Array.from(JSON.parse(await fs.readFile(path.join(privateDir, 'devnet-lab.json'), 'utf8'))));
const payer = createSignerFromKeypair(umi, payerKey);
assert.notEqual(payer.publicKey, policy.owner, 'This lab must never use the production owner');
umi.use(signerIdentity(payer));
report.testPayer = payer.publicKey;
if (state.payer) assert.equal(state.payer, payer.publicKey, 'State belongs to another test payer');
state.payer = payer.publicKey; await save();

async function getSigner(label) {
  if (!state.signers[label]) {
    state.signers[label] = Array.from(generateSigner(umi).secretKey); await save();
  }
  return createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(Uint8Array.from(state.signers[label])));
}
async function status(signature) {
  const [result] = await umi.rpc.getSignatureStatuses([base58.serialize(signature)], { searchTransactionHistory: true });
  return result;
}
async function execute(label, builder, verify) {
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
    const deadline = Date.now() + 40000; let confirmed = false;
    while (Date.now() < deadline) {
      const found = await status(receipt.signature);
      if (found) {
        assert.equal(found.error, null, `${label} failed on-chain`);
        if (['confirmed', 'finalized'].includes(found.commitment)) { confirmed = true; break; }
      }
      await delay(2000);
    }
    assert.ok(confirmed, `${label} confirmation pending; signature saved, do not resend`);
  }
  // Later steps intentionally change earlier account state (guard, owner, name).
  // A verified historical receipt is checked on-chain, not against obsolete state.
  if (receipt.status !== 'verified') {
    await verify(); receipt.verifiedAt = new Date().toISOString();
    receipt.status = 'verified'; await save();
  }
  report.transactions.push({ step: label, signature: receipt.signature, accountStateVerified: true });
  report.checks.push(label); await saveReport(); console.log(`Verified Devnet: ${label}`);
}

try {
  assert.equal(await umi.rpc.getGenesisHash(), DEVNET_GENESIS, 'Only Devnet is allowed');
  report.checks.push('Devnet genesis');
  const programs = await umi.rpc.getAccounts([
    publicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'),
    publicKey('CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J'),
    publicKey('CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ'),
  ]);
  assert.ok(programs.every(a => a.exists && a.executable), 'Programs must be executable');
  report.checks.push('three executable Metaplex programs');
  const balance = await umi.rpc.getBalance(payer.publicKey, { commitment: 'finalized' });
  report.balanceLamports = balance.basisPoints.toString();
  if (balance.basisPoints < 600000000n && !state.receipts['paid-mint']) {
    report.status = 'awaiting_test_sol'; await saveReport();
    console.log(JSON.stringify(report, null, 2)); process.exitCode = 2;
  } else {
    const collection = await getSigner('collection'); const asset = await getSigner('asset');
    const machine = await getSigner('machine'); const treasury = await getSigner('treasury');
    const minted = await getSigner('minted'); const recipient = await getSigner('recipient');
    report.collection = collection.publicKey; report.machine = machine.publicKey;
    const collectionState = () => fetchCollection(umi, collection.publicKey);
    await execute('collection', collectionBuilder(umi, collection, { name: 'CoolBears SDK Devnet Test', owner: payer.publicKey }), async () => {
      const value = await collectionState(); assert.equal(value.updateAuthority, payer.publicKey);
      assert.equal(value.royalties.basisPoints, 700);
    });
    await execute('standalone-item', assetBuilder(umi, asset, collection.publicKey, {
      owner: payer.publicKey, name: 'SDK test item', uri: `${policy.website}/metadata/0000.json`,
    }), async () => { const value = await fetchAsset(umi, asset.publicKey); assert.equal(value.owner, payer.publicKey); });
    await execute('closed-machine', await machineBuilder(umi, machine, collection.publicKey, {
      owner: payer.publicKey, treasury: treasury.publicKey, commitment: new Uint8Array(32).fill(7),
      uri: `${policy.website}/metadata/0000.json`, name: 'SDK test #$ID+1$',
    }), async () => {
      const value = await fetchCandyMachine(umi, machine.publicKey); assert.equal(value.data.itemsAvailable, 9999n);
      assert.equal(value.collectionMint, collection.publicKey);
    });
    const guard = findCandyGuardPda(umi, { base: machine.publicKey })[0];
    const mint = () => setComputeUnitLimit(umi, { units: 400000 }).add(mintV1(umi, {
      candyMachine: machine.publicKey, candyGuard: guard, collection: collection.publicKey,
      asset: minted, mintArgs: { solPayment: some({ destination: treasury.publicKey }) },
    }));
    if (!state.receipts['open-lab-only']) {
      const closedBuilder = await mint().useLegacyVersion().setLatestBlockhash(umi);
      const closedTx = await closedBuilder.buildAndSign(umi);
      const simulation = await umi.rpc.simulateTransaction(closedTx, { commitment: 'confirmed', verifySignatures: true });
      assert.ok(simulation.err && simulation.logs?.some(l => /MintNotLive|Mint not live/i.test(l)), 'Closed mint must reject with the start-date guard');
      if (!state.checks.includes('closed mint rejected by start-date guard')) {
        state.checks.push('closed mint rejected by start-date guard'); await save();
      }
    }
    // This changes only the separately named lab collection controlled by the
    // disposable test signer. Production owner/configuration are never touched.
    await execute('open-lab-only', updateCandyGuard(umi, { candyGuard: guard,
      guards: { solPayment: closedGuards(treasury.publicKey).solPayment }, groups: [],
    }), async () => { const value = await fetchCandyGuard(umi, guard); assert.equal(value.guards.startDate.__option, 'None'); });
    if (!state.beforePayment) { state.beforePayment = (await umi.rpc.getBalance(treasury.publicKey)).basisPoints.toString(); await save(); }
    await execute('paid-mint', mint(), async () => {
      const value = await fetchAsset(umi, minted.publicKey); assert.equal(value.owner, payer.publicKey);
      const balance = await umi.rpc.getBalance(treasury.publicKey);
      assert.equal(balance.basisPoints - BigInt(state.beforePayment), 500000000n);
    });
    await execute('close-lab', updateCandyGuard(umi, { candyGuard: guard, guards: closedGuards(treasury.publicKey), groups: [] }), async () => {
      const value = await fetchCandyGuard(umi, guard); assert.equal(value.guards.startDate.value.date, CLOSED_UNTIL);
    });
    await execute('transfer', transfer(umi, { asset: await fetchAsset(umi, minted.publicKey), collection: await collectionState(), newOwner: recipient.publicKey }), async () => {
      assert.equal((await fetchAsset(umi, minted.publicKey)).owner, recipient.publicKey);
    });
    // A synthetic lab-only metadata update exercises the future reveal operation.
    // It publishes no private art, trait, rank or production reveal URI.
    await execute('lab-metadata-update', update(umi, { asset: await fetchAsset(umi, asset.publicKey), collection: await collectionState(), name: 'SDK updated test item' }), async () => {
      assert.equal((await fetchAsset(umi, asset.publicKey)).name, 'SDK updated test item');
    });
    // Validate the final state on every run, including a fully completed restart.
    const finalCollection = await collectionState();
    assert.equal(finalCollection.royalties.basisPoints, 700);
    assert.equal(finalCollection.numMinted, 2);
    const finalMachine = await fetchCandyMachine(umi, machine.publicKey);
    assert.equal(finalMachine.itemsRedeemed, 1n);
    assert.equal(finalMachine.data.itemsAvailable, 9999n);
    assert.equal((await fetchCandyGuard(umi, guard)).guards.startDate.value.date, CLOSED_UNTIL);
    assert.equal((await fetchAsset(umi, minted.publicKey)).owner, recipient.publicKey);
    assert.equal((await fetchAsset(umi, asset.publicKey)).name, 'SDK updated test item');
    assert.equal((await umi.rpc.getBalance(treasury.publicKey)).basisPoints - BigInt(state.beforePayment), 500000000n);
    report.checks.push(...state.checks, 'final account state after all steps');
    report.status = 'passed'; await saveReport(); console.log(JSON.stringify(report, null, 2));
  }
} catch (error) {
  report.status = 'stopped';
  report.reason = String(error.message).replace(/https?:\/\/\S+/g, '[RPC]').slice(0, 350);
  await saveReport(); console.error(JSON.stringify(report, null, 2)); process.exitCode = 1;
}
