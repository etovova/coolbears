// CLI 0.4.3 eagerly opens USB even for read-only and file-key commands.
// Delay ONLY the optional hardware import; do not replace any signer or RPC.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const target = new URL('../node_modules/@metaplex-foundation/cli/dist/lib/Context.js', import.meta.url);
const source = await readFile(target, 'utf8');
const originalHash = 'eb331bc290b22068ffce5122e3332e455d74166c45958b66c4ab29272a39e502';
const importLine = "import { createSignerFromLedgerPath } from './LedgerSigner.js';\n";
const before = "    if (path.startsWith('usb://ledger')) {\n        return createSignerFromLedgerPath(path);";
const after = "    if (path.startsWith('usb://ledger')) {\n        const { createSignerFromLedgerPath } = await import('./LedgerSigner.js');\n        return createSignerFromLedgerPath(path);";
const hash = text => createHash('sha256').update(text).digest('hex');
const original = source.includes(importLine) ? source : source.replace(after, before).replace("import { createSignerFromFile } from './FileSigner.js';\n", "import { createSignerFromFile } from './FileSigner.js';\n" + importLine);
if (hash(original) !== originalHash) throw Error('Unrecognized CLI source; compatibility change was not applied.');
const patched = original.replace(importLine, '').replace(before, after);
if (source !== patched) await writeFile(target, patched);
console.log(JSON.stringify({ cliVersion: '0.4.3', change: 'lazy-ledger-import', originalSha256: originalHash, patchedSha256: hash(patched) }));
