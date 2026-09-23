// Local offline custody only: inspect public metadata or create/unlock three
// encrypted deployment keys. This command never signs or accesses the network.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { createDeploymentSignerVault, openDeploymentSignerVault } from './vault.mjs';
import { createDeploymentBundle, readDeploymentBundle } from './vault-store.mjs';
import { nextDeploymentAction } from './journal.mjs';
import { readPassphrase, samePassphrase } from './passphrase.mjs';

const MESSAGES = Object.freeze({
  ARGUMENTS: 'Usage: custody.mjs init <bundle-directory> <public-options.json> | inspect <bundle-directory> | verify <bundle-directory>.',
  OPTIONS: 'The public options file must be a bounded regular JSON file with the required public fields.',
  PASSPHRASE: 'Passphrase entry was cancelled, unavailable, invalid or did not match.',
  CREATE: 'The offline deployment bundle could not be created. Existing files were not replaced.',
  INSPECT: 'The deployment bundle could not be inspected.',
  VERIFY: 'The deployment keys could not be unlocked and verified.',
  OUTPUT: 'The public custody report could not be written.',
});
const failure = code => Object.assign(Error(MESSAGES[code]), { code: `DEPLOYMENT_CUSTODY_${code}` });
const address = value => {
  try { return typeof value === 'string' && new PublicKey(value).toBase58() === value; } catch { return false; }
};

async function publicOptions(filename) {
  let handle;
  const bytes = Buffer.alloc(4097);
  try {
    // NONBLOCK prevents a named pipe from hanging before fstat can reject it.
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096) throw failure('OPTIONS');
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > 4096) throw failure('OPTIONS');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)));
    const names = ['id', 'cluster', 'blockhash', 'lastValidBlockHeight', 'machineRentLamports'];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== names.length
      || !names.every(key => Object.hasOwn(value, key)) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id)
      || !['devnet', 'mainnet-beta'].includes(value.cluster) || !address(value.blockhash)
      || !Number.isSafeInteger(value.lastValidBlockHeight) || value.lastValidBlockHeight < 1
      || typeof value.machineRentLamports !== 'string' || !/^[1-9]\d{0,19}$/.test(value.machineRentLamports)
      || BigInt(value.machineRentLamports) > (1n << 64n) - 1n) throw failure('OPTIONS');
    return value;
  } catch { throw failure('OPTIONS'); }
  finally { bytes.fill(0); await handle?.close(); }
}

function publicReport(command, snapshot) {
  const manifest = snapshot.manifest;
  const [collection, asset, machine] = manifest.steps.slice(0, 3).map(step => step.expected);
  const roles = {
    collection: collection.collection, reservedAsset: asset.asset, machine: machine.machine, guard: machine.guard,
    collectionUpdateAuthority: collection.updateAuthority, reservedAssetOwner: asset.owner,
    candyMachineAuthority: machine.authority, candyGuardAuthority: machine.guardAuthority,
  };
  if (!address(manifest.owner) || !Object.values(roles).every(address)) throw failure('INSPECT');
  return {
    ok: true, command, mode: 'offline-custody', id: manifest.id, cluster: manifest.cluster, owner: manifest.owner, roles,
    manifestSha256: snapshot.manifestSha256, journalRevision: snapshot.revision, journalHead: snapshot.headHash,
    action: nextDeploymentAction(snapshot), ...(command === 'verify' ? { localKeysVerified: true } : {}),
    readyToSubmit: false, salesOpen: false, networkRequests: 0, signaturesCreated: 0, transactionsSent: 0,
  };
}

export async function runCustody(args, { input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}) {
  let stage = 'ARGUMENTS', passphrase, confirmation;
  try {
    if (!Array.isArray(args) || !args.every(value => typeof value === 'string' && value.length > 0 && value.length <= 4096)
      || !['init', 'inspect', 'verify'].includes(args[0]) || args.length !== (args[0] === 'init' ? 3 : 2)
      || args.slice(1).some(value => value.startsWith('-')) || typeof output?.write !== 'function'
      || typeof errorOutput?.write !== 'function') throw failure('ARGUMENTS');
    const [command, directory, optionsFile] = args;
    let bundle;
    if (command === 'init') {
      stage = 'OPTIONS'; const options = await publicOptions(optionsFile);
      stage = 'PASSPHRASE';
      passphrase = await readPassphrase({ input, output: errorOutput });
      confirmation = await readPassphrase({ input, output: errorOutput, confirmation: true });
      if (!samePassphrase(passphrase, confirmation)) throw failure('PASSPHRASE');
      confirmation.fill(0);
      stage = 'CREATE';
      const created = await createDeploymentSignerVault({ ...options, passphrase });
      passphrase.fill(0);
      bundle = await createDeploymentBundle({ directory, ...created });
    } else {
      stage = 'INSPECT'; bundle = await readDeploymentBundle(directory);
      if (command === 'verify') {
        stage = 'PASSPHRASE'; passphrase = await readPassphrase({ input, output: errorOutput });
        stage = 'VERIFY';
        let unlocked;
        try { unlocked = await openDeploymentSignerVault({ vault: bundle.vault, manifest: bundle.snapshot.manifest, passphrase }); }
        finally { unlocked?.dispose(); passphrase.fill(0); }
      }
    }
    const report = publicReport(command, bundle.snapshot);
    stage = 'OUTPUT'; output.write(JSON.stringify(report) + '\n');
    return 0;
  } catch {
    try { errorOutput.write(JSON.stringify({ ok: false, code: `DEPLOYMENT_CUSTODY_${stage}`, message: MESSAGES[stage] }) + '\n'); } catch { /* Do not print raw errors through another channel. */ }
    return 1;
  } finally { passphrase?.fill(0); confirmation?.fill(0); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCustody(process.argv.slice(2));
}
