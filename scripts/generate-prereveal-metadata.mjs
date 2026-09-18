import fs from 'node:fs';
import path from 'node:path';
import './audit-prereveal-privacy.mjs';
import {validateHiddenMetadata} from './prereveal-policy.mjs';

const supply = Number(process.env.SUPPLY || 10000);
const source = process.env.SOURCE || 'metadata/prereveal.json';
const outDir = process.env.OUT_DIR || 'build/prereveal-metadata';

if (!Number.isInteger(supply) || supply < 1 || supply > 10000) throw new Error('Invalid SUPPLY');
const template = JSON.parse(fs.readFileSync(source, 'utf8'));
const canonical = JSON.parse(fs.readFileSync('metadata/prereveal.json', 'utf8'));
if (JSON.stringify(template) !== JSON.stringify(canonical)) throw new Error('Only the audited hidden template may be published');
// Refuse arbitrary output deletion, including symlinked or user-owned folders.
const resolved=path.resolve(outDir),build=path.resolve('build');
if(path.dirname(resolved)!==build||path.basename(resolved)!=='prereveal-metadata')throw Error('Output must be build/prereveal-metadata');
if(fs.existsSync(build)&&fs.realpathSync(build)!==build)throw Error('Symlinked build directory');
if(fs.existsSync(resolved)&&fs.realpathSync(resolved)!==resolved)throw Error('Symlinked metadata directory');
fs.mkdirSync(resolved, { recursive: true });
for(const f of fs.readdirSync(resolved)){
  if(!/^\d{4}\.json$/.test(f)||!fs.lstatSync(path.join(resolved,f)).isFile())throw Error('Unexpected output entry: '+f);
}

for (let i = 0; i < supply; i++) {
  const tokenId = String(i).padStart(4, '0');
  const item = {
    ...template,
    name: `CoolBears #${tokenId} — Hidden Bear`
  };
  validateHiddenMetadata(item,i);
  fs.writeFileSync(path.join(outDir, `${tokenId}.json`), JSON.stringify(item));
}

const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.json')).sort();
if (files.length !== supply) throw new Error(`Expected ${supply} files, got ${files.length}`);
if (files[0] !== '0000.json') throw new Error(`Unexpected first filename: ${files[0]}`);
if (files[files.length - 1] !== `${String(supply - 1).padStart(4, '0')}.json`) {
  throw new Error(`Unexpected last filename: ${files[files.length - 1]}`);
}
console.log(`Generated ${files.length} pre-reveal metadata files in ${outDir}: ${files[0]} ... ${files[files.length - 1]}`);
