import { build } from 'esbuild';
await build({ entryPoints: ['solana/owner-client.mjs'], bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true, outfile: 'solana-test/sdk.js', legalComments: 'external' });
console.log('Devnet client built; homepage does not load this bundle.');

await build({ entryPoints: ['wallet/standard.mjs'], bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true, outfile: 'wallet-standard.js', legalComments: 'external' });

await build({ entryPoints: ['solana/upload-client.mjs'], bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true, outfile: 'solana-upload/sdk.js', legalComments: 'external' });
