// Private operator entry point. No credentials or transaction bytes in output.
import { pathToFileURL } from 'node:url';
import { sendDeploymentStep, resumeDeploymentStep, reviewFailedDeploymentStep, reviewExpiredDeploymentStep } from './sender.mjs';
import { createGatewayFetch } from './gateway/client.mjs';

export async function runDeploymentSenderCli(argv, { env = process.env, fetchImpl,
  write = text => process.stdout.write(text) } = {}) {
  const [mode, directory, stepId, ...flags] = argv;
  const sendMode = mode === 'send-one', reviewMode = ['review-failure', 'review-expiry'].includes(mode);
  const validFlags = sendMode ? flags.length === 1 && ['--devnet-send', '--mainnet-send'].includes(flags[0])
    : reviewMode ? flags[0] === '--authorize-retry' && (flags.length === 1 || flags.length === 2 && flags[1] === '--mainnet')
      : mode === 'resume' && (flags.length === 0 || flags.length === 1 && flags[0] === '--mainnet');
  if (!directory || !stepId || !validFlags) {
    write('Usage: send-cli.mjs send-one <bundle> <step> --devnet-send|--mainnet-send OR resume <bundle> <step> [--mainnet] OR review-failure|review-expiry <bundle> <step> --authorize-retry [--mainnet]\n');
    return 1;
  }
  try {
    const endpoint = env.COOLBEARS_RPC_URL;
    // Both commands require the separate private gateway, never the lab endpoint.
    const gatewayFetch = createGatewayFetch({ endpoint, token: env.COOLBEARS_OPERATOR_RPC_TOKEN, fetchImpl });
    const run = { 'send-one': sendDeploymentStep, resume: resumeDeploymentStep,
      'review-failure': reviewFailedDeploymentStep, 'review-expiry': reviewExpiredDeploymentStep }[mode];
    const report = await run({ directory, stepId, authorizeDevnetSend: sendMode && flags[0] === '--devnet-send',
      authorizeMainnetSend: sendMode && flags[0] === '--mainnet-send',
      authorizeMainnet: reviewMode ? flags[1] === '--mainnet' : mode === 'resume' && flags[0] === '--mainnet',
      authorizeRetryReview: reviewMode, endpoint, fetchImpl: gatewayFetch,
      trustedHiddenCommitmentSha256: env.COOLBEARS_HIDDEN_COMMITMENT_SHA256 });
    write(JSON.stringify(report, null, 2) + '\n');
    return ['accepted', 'verified', 'already-recorded', 'failed', 'expired'].includes(report.status) ? 0 : 1;
  } catch {
    write('Private sender configuration is invalid. No operation was started.\n'); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runDeploymentSenderCli(process.argv.slice(2));
