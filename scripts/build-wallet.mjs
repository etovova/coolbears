import { build } from 'esbuild';
await build({ entryPoints: ['wallet/standard.mjs'], bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true, outfile: 'wallet-standard.js', legalComments: 'external' });
