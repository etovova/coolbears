// Fixed public Devnet source; no wallet, cluster, send or real reveal switches.
import { mkdir, writeFile } from 'node:fs/promises';
import { previewLifecycleCosts } from './preview.mjs';

const directory = new URL('../build/lifecycle-costs/', import.meta.url);
await mkdir(directory, { recursive: true });
const { report, snapshot } = await previewLifecycleCosts({ endpoint: 'https://api.devnet.solana.com',
  onProgress: progress => console.log('LIFECYCLE_PROGRESS ' + JSON.stringify(progress)) });
if (snapshot) await writeFile(new URL('program-snapshot.json', directory), JSON.stringify(snapshot), { flag: 'wx' });
await writeFile(new URL('report.json', directory), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log('COOLBEARS_LIFECYCLE_REPORT=' + JSON.stringify(report));
if (report.status !== 'isolated-lifecycle-passed-and-calibrated') process.exitCode = 2;
