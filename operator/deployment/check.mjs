// Explicit endpoint; read-only report. No journal append or transaction sender.
import { preflightDeploymentStep, reconcileDeploymentStep } from './read.mjs';
const [mode, directory, stepId, ...extra] = process.argv.slice(2);
if (!['preflight', 'reconcile'].includes(mode) || !directory || !stepId || extra.length) {
  console.error('Usage: node operator/deployment/check.mjs <preflight|reconcile> <journal-directory> <step-id>');
  process.exitCode = 1;
} else {
  const run = mode === 'preflight' ? preflightDeploymentStep : reconcileDeploymentStep;
  const report = await run({ directory, stepId, endpoint: process.env.COOLBEARS_RPC_URL });
  console.log(JSON.stringify(report, null, 2));
  if (['blocked', 'unknown'].includes(report.status)) process.exitCode = 1;
}
