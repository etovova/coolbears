// Offline preparation from an existing private journal. No key generation or RPC.
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { readDeploymentJournal } from '../journal.mjs';
import { compileDeploymentRpcPolicy } from '../compile-rpc-policy.mjs';
const [directory, simulation, ...extra] = process.argv.slice(2);
const destination = new URL('./private/', import.meta.url);
let created = false;
try {
  if (!directory || extra.length || (simulation !== undefined && simulation !== '--allow-simulation')) throw Error();
  const snapshot = await readDeploymentJournal(directory);
  const policy = await compileDeploymentRpcPolicy(snapshot.manifest, { allowSimulation: simulation === '--allow-simulation',
    recoverySignatures: snapshot.steps.flatMap(step => step.attempts).filter(attempt => attempt.signed).map(attempt => attempt.signed.signature) });
  const fresh = await readDeploymentJournal(directory);
  if (snapshot.manifestSha256 !== fresh.manifestSha256 || snapshot.headHash !== fresh.headHash || snapshot.revision !== fresh.revision) throw Error();
  await mkdir(destination, { mode: 0o700 }); created = true;
  await writeFile(new URL('policy.json', destination), JSON.stringify(policy), { flag: 'wx', mode: 0o600 });
  await writeFile(new URL('entry.mjs', destination), `import policy from './policy.json' with { type: 'json' };
import { makeGateway } from '../worker.mjs';
const { worker, DeploymentGate } = makeGateway(policy);
export { DeploymentGate };
export default worker;
`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: 'prepared-offline', messages: policy.messageIdentities.length,
    recoverySignatures: policy.recoverySignatures.length, allowSimulation: policy.allowSimulation,
    deployed: false, transactionsSent: 0, salesOpen: false }));
} catch {
  if (created) await rm(destination, { recursive: true, force: true });
  console.error('Gateway preparation stopped. Check the canonical journal and existing private output; nothing was deployed.');
  process.exitCode = 1;
}
