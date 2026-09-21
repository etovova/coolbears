import { build } from 'esbuild';
await build({ entryPoints: ['wallet/standard.mjs'], bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true, outfile: 'wallet-standard.js', legalComments: 'external' });
await build({ entryPoints: ['devnet/app.mjs'], bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], supported: { 'template-literal': false }, minify: true, outfile: 'devnet/app.js', legalComments: 'external', inject: ['scripts/browser-buffer.mjs'] });
