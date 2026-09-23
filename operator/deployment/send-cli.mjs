// Private operator entry point. No credentials or transaction bytes in output.
import { pathToFileURL } from 'node:url';
import { sendDeploymentStep, resumeDeploymentStep, reviewFailedDeploymentStep } from './sender.mjs';
import { createGatewayFetch } from './gateway/client.mjs';

export async function runDeploymentSenderCli(argv, { env = process.env, fetchImpl,
  write = text => process.stdout.write(text) } = {}) {
  const [mode, directory, stepId, flag, ...extra] = argv;
  if (!['send-one', 'resume', 'review-failure'].includes(mode) || !directory || !stepId || extra.length
    || flag !== ({ 'send-one': '--devnet-send', 'review-failure': '--authorize-retry' })[mode]) {
    write('Usage: send-cli.mjs send-one <bundle> <step> --devnet-send OR resume <bundle> <step> OR review-failure <bundle> <step> --authorize-retry\n');
    return 1;
  }
  try {
    const endpoint = env.COOLBEARS_RPC_URL;
    // Both commands require the separate private gateway, never the lab endpoint.
    const gatewayFetch = createGatewayFetch({ endpoint, token: env.COOLBEARS_OPERATOR_RPC_TOKEN, fetchImpl });
    const run = { 'send-one': sendDeploymentStep, resume: resumeDeploymentStep, 'review-failure': reviewFailedDeploymentStep }[mode];
    const report = await run({ directory, stepId, authorizeDevnetSend: mode === 'send-one',
      authorizeRetryReview: mode === 'review-failure', endpoint, fetchImpl: gatewayFetch });
    write(JSON.stringify(report, null, 2) + '\n');
    return ['accepted', 'verified', 'already-recorded', 'failed'].includes(report.status) ? 0 : 1;
  } catch {
    write('Private sender configuration is invalid. No operation was started.\n'); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runDeploymentSenderCli(process.argv.slice(2));
