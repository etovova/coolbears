import { build } from 'esbuild';
await build({ entryPoints: ['manage/manage.mjs'], bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true,
  outfile: 'manage/manage.js', legalComments: 'external', external: ['../wallet-ui.mjs'] });
await build({ entryPoints: ['chain/runtime.mjs'], bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true,
  outfile: 'mint-client.js', legalComments: 'external' });
