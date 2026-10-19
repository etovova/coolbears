// Explicit public Devnet check; no credentials or owner wallet are needed.
import { mkdir, writeFile } from 'node:fs/promises';
import { previewDevnetDeployment } from './preview.mjs';

const report = await previewDevnetDeployment({
  endpoint: 'https://api.devnet.solana.com',
  onProgress: progress => console.log('PREVIEW_PROGRESS ' + JSON.stringify(progress)),
});
await mkdir('build', { recursive: true });
await writeFile('build/devnet-cost-preview.json', JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log('COOLBEARS_DEVNET_PREVIEW=' + JSON.stringify(report));
if (report.status !== 'preview-estimated') process.exitCode = 2;
