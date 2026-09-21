import { build } from 'esbuild';
import { resolve } from 'node:path';
await build({ entryPoints: ['wallet/standard.mjs'], bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true, outfile: 'wallet-standard.js', legalComments: 'external' });
await build({ entryPoints: ['release/phantom-page.mjs'], bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true, outfile: 'phantom-check/app.js', inject: ['release/browser-buffer.mjs'], alias: { '@solana/web3.js': resolve('release/node_modules/@solana/web3.js'), buffer: resolve('release/node_modules/buffer') }, legalComments: 'external' });
