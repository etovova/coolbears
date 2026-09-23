// No wallet/cluster/send switches: public Devnet reads + in-memory execution.
import { mkdir, writeFile } from 'node:fs/promises';
import { previewIsolatedDeployment } from './isolated-preview.mjs';

const directory = new URL('../build/isolated-deployment/', import.meta.url);
await mkdir(directory, { recursive: true });
const { report, snapshot } = await previewIsolatedDeployment({ endpoint: 'https://api.devnet.solana.com',
  onProgress: progress => console.log('ISOLATED_PROGRESS ' + JSON.stringify(progress)) });
if (snapshot) await writeFile(new URL('program-snapshot.json', directory), JSON.stringify(snapshot), { flag: 'wx' });
await writeFile(new URL('report.json', directory), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log('COOLBEARS_ISOLATED_REPORT=' + JSON.stringify(report));
if (report.status !== 'isolated-passed-and-calibrated') process.exitCode = 2;
