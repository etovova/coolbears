import fs from 'node:fs';
import path from 'node:path';
import './audit-prereveal-privacy.mjs';
const files = JSON.parse(fs.readFileSync('scripts/public-files.json', 'utf8'));
const out = path.resolve('public-site');
fs.rmSync(out, { recursive: true, force: true });
for (const file of files) {
  if (path.isAbsolute(file) || file.split('/').some(p => p === '..' || p.startsWith('.')) || /^(collection|contracts|build|scripts)\//.test(file)) throw new Error(`Forbidden public path: ${file}`);
  const source = path.resolve(file);
  if (fs.realpathSync(source) !== source || !fs.statSync(source).isFile()) throw new Error(`Public file must be a regular, non-symlink file: ${file}`);
  const dest = path.join(out, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
}
console.log(`Staged ${files.length} explicitly listed public files; private/build/contract sources excluded.`);
