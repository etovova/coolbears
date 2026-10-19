// Offline fixed ESM graph; no package install, bundler binary, owner rebuild or
// runtime package resolution. Native browser source bodies are unchanged.
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { createFixedCjs } from './fixed-cjs.mjs';
import { buildPublicLicenses } from './build-public-licenses.mjs';
const here = path.dirname(new URL(import.meta.url).pathname), workspace = path.resolve(here, '..'), output = path.join(workspace, 'public-mainnet');
const source = workspace, deps = path.join(source, 'operator/node_modules');
const hash = data => createHash('sha256').update(data).digest('hex'), assets = {}, bindings = [], pending = new Map();
const read = file => readFile(file, 'utf8');
const specialWeb3 = path.join(deps, '@solana/web3.js/lib/index.iife.min.js');
const specialBuffer = path.join(deps, 'buffer/index.js');
const specialWallet = path.join(output, 'vendor/wallet-standard-app.wallets.ts');
const packageFile = async (name, subpath) => { const root = path.join(deps, name), info = JSON.parse(await read(path.join(root, 'package.json')));
  let entry = info.exports?.[subpath ? `./${subpath}` : '.'];
  if (typeof entry === 'object') entry = entry.browser ?? entry.import ?? entry.default;
  if (typeof entry === 'object') entry = entry.import ?? entry.default;
  if (!entry) entry = subpath || (typeof info.browser === 'string' ? info.browser : null) || info.module || info.main || 'index.js';
  if (!path.extname(entry)) entry += '.js';
  if (name === '@noble/hashes' && subpath === 'crypto') entry = 'esm/crypto.js';
  return path.join(root, entry); };
async function resolve(specifier, importer) {
  if (specifier === '@wallet-standard/app') return specialWallet;
  if (specifier === '@solana/web3.js') return specialWeb3;
  if (specifier === 'buffer') return specialBuffer;
  if (specifier.startsWith('.')) return path.resolve(path.dirname(importer), specifier);
  if (/^(?:node:|https?:|\/)/.test(specifier)) throw Error(`EXTERNAL_IMPORT:${specifier}`);
  const parts = specifier.split('/'), name = parts[0].startsWith('@') ? parts.splice(0,2).join('/') : parts.shift();
  try{return await packageFile(name, parts.join('/'));}catch(error){error.message+=' importer='+importer+' specifier='+specifier;throw error;}
}
const routeFor = file => `/public-mainnet/modules/${hash(path.relative(workspace, file)).slice(0,20)}.mjs`;
const cjs=createFixedCjs({workspace,deps,bundleModule,routeFor,assets,bindings,bufferFile:specialBuffer});
async function bundleModule(file) {
  if (pending.has(file)) return pending.get(file);
  const route = routeFor(file); pending.set(file, route);
  const original = await read(file); let body = original;
  if(file!==specialBuffer&&!file.endsWith('/node-fetch/browser.js')&&file!==specialWeb3&&await cjs.isCommonJs(file,original))return cjs.bridge(file,original);
  if (file.endsWith('.json')) body = 'export default ' + JSON.stringify(JSON.parse(original)) + ';\n';
  else if (file === specialWallet) body = '// Wallet Standard app 1.1.1, Apache-2.0. Type annotations stripped by Node24 only.\n' + stripTypeScriptTypes(body, { mode: 'strip' });
  else if (file.endsWith('/node-fetch/browser.js')) body = 'const module={exports:{}}; let exports=module.exports;\n'+original+'\nexport default module.exports;export const {Headers,Request,Response}=module.exports;\n';
  else if (file === specialWeb3) body += '\nexport const {PublicKey,VersionedTransaction,TransactionInstruction,Keypair,Message,MessageV0,AddressLookupTableAccount,SIGNATURE_LENGTH_IN_BYTES,Transaction,Connection} = solanaWeb3;\n';
  else if (file === specialBuffer) {
    const base64 = await read(path.join(deps, 'base64-js/index.js')), ieee = await read(path.join(deps, 'ieee754/index.js'));
    body = `// Existing Buffer6.0.3 CommonJS modules wrapped without source changes.\nconst modules = {};\nmodules['base64-js'] = (() => { const exports = {};\n${base64}\nreturn exports; })();\nmodules.ieee754 = (() => { const exports = {};\n${ieee}\nreturn exports; })();\nconst require = name => { if (!Object.hasOwn(modules,name)) throw Error('MODULE'); return modules[name]; }; const exports = {};\n${original}\nexport { Buffer };\n`;
  } else {
    const matches = [...body.matchAll(/\b(?:import|export)\s*(?:[^;'"]*?\s*from\s*)?(['"])([^'"\n]+)\1/g)];
    const replacements = new Map();
    for (const match of matches) { const imported = await resolve(match[2], file); replacements.set(match[2], await bundleModule(imported)); }
    for (const [from,to] of replacements) { const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); body = body.replace(new RegExp(`((?:from\\s*|import\\s*)['"])${escaped}(['"])`, 'g'), `$1${to}$2`); }
    body = body.replace(/\s+with\s*\{\s*type\s*:\s*['"]json['"]\s*\}/g, '');
    if (file.includes('/operator/') && /\bBuffer\b/.test(original) && !/import[^;\n]*\bBuffer\b/.test(original)) body = `import { Buffer } from '${await bundleModule(specialBuffer)}';\n` + body;
  }
  // No source-map requests or remote dependencies are served.
  body = body.replace(/^\/\/# sourceMappingURL=.*$/gm, '');
  assets[route] = body; bindings.push({ path: path.relative(workspace,file), originalBytes: Buffer.byteLength(original), originalSha256: hash(original), route, bytes: Buffer.byteLength(body), sha256: hash(body) });
  return route;
}
const appRoute = await bundleModule(path.join(output, 'site-entry.source.mjs'));
const commonJsBindings=await cjs.finish();
const browserAsset = `export {mount} from '${appRoute}';\n`;
await writeFile(path.join(output,'browser-assets.PRIVATE.json'), JSON.stringify({ browserAsset, browserAssets: assets })+'\n', { mode:0o600 });
await writeFile(path.join(output,'browser-assets-binding.SAFE.json'), JSON.stringify({ version:1, build:'offline-fixed-esm-import-graph', installedPackages:0, ownerBuildRequired:false, externalModuleImports:0,
  walletStandard: { version:'1.1.1', repository:'wallet-standard/wallet-standard', sourceBlob:'3c1bc406732e78ed53ff02907f914ef87bec4a1a', packageBlob:'7109235b819504b6238907fab78d6d64046fc51e', license:'Apache-2.0', licenseBlob:'d645695673349e3947e8e5ae42332d0ac3164cd7', transformation:'Node24 stripTypeScriptTypes mode strip; no behavior edits', npmTarballByteIdentityClaimed:false },
  limitations:['This build reuses installed dependencies and the prior reviewed official Wallet Standard source; no dependency commands or network requests were performed. A prior Resume build npm install was rejected by automatic review and was not retried.', 'Graph is packaged as fixed same-origin ESM routes, not an esbuild bundle. JSON imports are compiled as fixed default-export modules; Buffer is injected only where referenced in unchanged operator source bodies.', 'Real Windows Chrome/Phantom behavior is not attested by offline tests.'],
  appRoute, assetCount:Object.keys(assets).length, sourceBindings:bindings, commonJsBindings },null,2)+'\n', {mode:0o600});
await writeFile(path.join(output,'site-entry.mjs'), browserAsset, {mode:0o600});
await writeFile(path.join(output,'site-entry.built.mjs'), browserAsset, {mode:0o600});
for (const [route,body] of Object.entries(assets)) { const target=path.join(workspace,route.slice(1)); await mkdir(path.dirname(target),{recursive:true}); await writeFile(target,body,{mode:0o600}); }
// Remove only obsolete generated routes, never hand-written site sources.
for (const name of await readdir(path.join(output,'modules'))) if (/^[a-f0-9]{20}\.mjs$/.test(name) && !Object.hasOwn(assets,`/public-mainnet/modules/${name}`)) await unlink(path.join(output,'modules',name));
const baseFiles=JSON.parse(await read(path.join(workspace,'scripts/public-base-files.json')));
if (baseFiles.length!==34 || new Set(baseFiles).size!==34 || baseFiles.some(file=>file.startsWith('public-mainnet/'))) throw Error('INVALID_PUBLIC_BASE');
const publicFiles=[...baseFiles,'public-mainnet/site-entry.mjs','public-mainnet/style.css','public-mainnet/LEGAL.txt',...Object.keys(assets).sort().map(route=>route.slice(1))];
await writeFile(path.join(workspace,'scripts/public-files.json'),JSON.stringify(publicFiles,null,2)+'\n');
const license=await buildPublicLicenses({workspace,sourceBindings:bindings,commonJsBindings});
console.log(JSON.stringify({licensePackages:license.packageCount,assetCount:Object.keys(assets).length,assetBytes:Buffer.byteLength(JSON.stringify(assets)),appRoute}));
