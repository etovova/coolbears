import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const hash=value=>createHash('sha256').update(value).digest('hex');
const sourceOnly=process.argv.includes('--source-only');
const graph=JSON.parse(await readFile('public-mainnet/browser-assets.PRIVATE.json','utf8'));
const binding=JSON.parse(await readFile('public-mainnet/browser-assets-binding.SAFE.json','utf8'));
const rootPackage=JSON.parse(await readFile('package.json','utf8')),operatorPackage=JSON.parse(await readFile('operator/package.json','utf8'));
const operatorLock=JSON.parse(await readFile('operator/package-lock.json','utf8'));
const licenses=JSON.parse(await readFile('build/public-mainnet/public-browser-license-binding.SAFE.json','utf8'));
for(const row of licenses.entries){if(row.name==='@wallet-standard/app')continue;const info=JSON.parse(await readFile(`operator/node_modules/${row.name}/package.json`,'utf8'));assert.equal(info.version,operatorLock.packages[`node_modules/${row.name}`].version,row.name);if(rootPackage.dependencies?.[row.name]&&operatorPackage.dependencies?.[row.name])assert.equal(rootPackage.dependencies[row.name],operatorPackage.dependencies[row.name],`Shared SDK version: ${row.name}`);}
const base=JSON.parse(await readFile('scripts/public-base-files.json','utf8'));
const files=JSON.parse(await readFile('scripts/public-files.json','utf8'));
const generated=['public-mainnet/site-entry.mjs','public-mainnet/style.css','public-mainnet/LEGAL.txt',...Object.keys(graph.browserAssets).sort().map(route=>route.slice(1))];
assert.equal(base.length,34);assert.equal(new Set(base).size,34);
for(const file of ['assets/brand/logo-20261003.png','assets/brand/hero-20261003.png','assets/brand/gallery-20261003.png'])assert.ok(base.includes(file));
assert.deepEqual(files,[...base,...generated]);assert.equal(new Set(files).size,files.length);
assert.equal(Object.keys(graph.browserAssets).length,binding.assetCount);
assert.equal((await readFile('public-mainnet/site-entry.mjs','utf8')),graph.browserAsset);
const allowed=new Set(generated);
for(const file of files)assert.ok(!file.includes('..')&&!file.startsWith('/')&&!/PRIVATE|SAFE\.json|site-entry\.source|vendor\//.test(file),file);
for(const row of binding.sourceBindings){const original=await readFile(row.path);assert.equal(original.length,row.originalBytes,row.path);assert.equal(hash(original),row.originalSha256,row.path);}
for(const [route,body]of Object.entries(graph.browserAssets)){const file=route.slice(1);assert.ok(allowed.has(file));assert.equal(await readFile(file,'utf8'),body,file);}
for(const file of generated){const bytes=await readFile(file);assert.ok(bytes.length,file);if(!sourceOnly)assert.ok(bytes.equals(await readFile(`public-site/${file}`)),`Staged public asset differs: ${file}`);
 if(process.env.CI==='true'||process.argv.includes('--check-committed')){const committed=execFileSync('git',['show',`HEAD:${file}`],{maxBuffer:10*1024*1024});assert.ok(bytes.equals(committed),`Run build:public-mainnet and commit generated asset: ${file}`);}}
if(process.env.CI==='true'||process.argv.includes('--check-committed'))assert.ok((await readFile('scripts/public-files.json')).equals(execFileSync('git',['show','HEAD:scripts/public-files.json'])),'Commit the generated public allowlist');
console.log(JSON.stringify({publicModules:binding.assetCount,publicAssets:generated.length,baseAssets:base.length,sourceOnly,privateDiagnosticsPublished:false}));
