import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
const root = new URL('../../../', import.meta.url), destination = new URL('./build/', import.meta.url);
await mkdir(destination, { recursive: true });
await build({ entryPoints: [new URL('./app.mjs', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'browser',
  target: ['es2022'], minify: true, outfile: new URL('app.js', destination).pathname, legalComments: 'external',
  inject: [new URL('scripts/browser-buffer.mjs', root).pathname] });
for (const name of ['index.html', 'style.css']) await copyFile(new URL(name, import.meta.url), new URL(name, destination));
console.log('Private owner console built. No site deployment or network requests.');
