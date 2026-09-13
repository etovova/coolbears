import fs from 'node:fs';
import path from 'node:path';

const supply = Number(process.env.SUPPLY || 10000);
const source = process.env.SOURCE || 'metadata/prereveal.json';
const outDir = process.env.OUT_DIR || 'build/prereveal-metadata';

if (!Number.isInteger(supply) || supply < 1) throw new Error('Invalid SUPPLY');
const template = JSON.parse(fs.readFileSync(source, 'utf8'));
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (let i = 0; i < supply; i++) {
  const item = {
    ...template,
    name: `CoolBears #${i} — Hidden Bear`
  };
  fs.writeFileSync(path.join(outDir, `${i}.json`), JSON.stringify(item));
}

const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.json'));
if (files.length !== supply) throw new Error(`Expected ${supply} files, got ${files.length}`);
console.log(`Generated ${files.length} pre-reveal metadata files in ${outDir}`);
