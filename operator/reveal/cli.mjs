#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPrivateRevealBytes, readPrivateRevealManifest, saveRevealCommitment, stagePrivateReveal } from './store.mjs';
const usage = 'Use commitment MANIFEST NEW_PRIVATE_DIRECTORY, or stage MANIFEST EXPECTED_HASH ARTWORK_DIRECTORY NEW_PRIVATE_DIRECTORY --reveal --accept-cache-refresh.';
export async function runRevealCli(args, { output = process.stdout, error = process.stderr, now = () => new Date().toISOString() } = {}) {
  try {
    const [command, input, ...rest] = args;
    if (command === 'commitment' && rest.length === 1) {
      const report = await saveRevealCommitment(rest[0], await readPrivateRevealManifest(input));
      output.write(JSON.stringify(report) + '\n'); return 0;
    }
    if (command === 'stage' && rest.length === 5 && rest[3] === '--reveal' && rest[4] === '--accept-cache-refresh') {
      const [expectedCommitmentSha256, artworkDirectory, destination] = rest;
      const manifest = await readPrivateRevealManifest(input);
      const report = await stagePrivateReveal(destination, manifest, {
        expectedCommitmentSha256, now: now(), revealAuthorized: true, marketplaceRefreshAcknowledged: true,
        readArtwork: sourceIndex => readPrivateRevealBytes(path.join(artworkDirectory, `${String(sourceIndex).padStart(4, '0')}.png`), 32 * 1024 * 1024),
      });
      output.write(JSON.stringify(report) + '\n'); return 0;
    }
    error.write(usage + '\n'); return 1;
  } catch (exception) {
    // Never echo JSON fields, local paths, attributes, CID, ranks or file errors.
    const code = /^REVEAL_[A-Z_]+$/.test(exception?.code) ? exception.code : 'REVEAL_FAILED';
    error.write(code + '\n'); return 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runRevealCli(process.argv.slice(2));
