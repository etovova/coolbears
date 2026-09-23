// Explicit endpoint; read-only report. No journal append or transaction sender.
import { preflightDeploymentStep, reconcileDeploymentStep } from './read.mjs';
import { quoteDeploymentBudget } from './budget.mjs';
import { simulateDeploymentStep } from './simulation.mjs';
const [mode, directory, stepId, ...extra] = process.argv.slice(2);
if (!['preflight', 'reconcile', 'budget', 'simulate-unsigned', 'simulate-signed'].includes(mode)
  || !directory || (mode === 'budget' ? stepId !== undefined : !stepId) || extra.length) {
  console.error('Usage: node operator/deployment/check.mjs budget <journal-directory> OR <preflight|reconcile|simulate-unsigned|simulate-signed> <journal-directory> <step-id>');
  process.exitCode = 1;
} else {
  const run = mode === 'budget' ? quoteDeploymentBudget : mode.startsWith('simulate-') ? simulateDeploymentStep
    : mode === 'preflight' ? preflightDeploymentStep : reconcileDeploymentStep;
  const report = await run({ directory, stepId, mode: mode.slice('simulate-'.length), endpoint: process.env.COOLBEARS_RPC_URL });
  console.log(JSON.stringify(report, null, 2));
  if (['blocked', 'unknown'].includes(report.status)) process.exitCode = 1;
}
