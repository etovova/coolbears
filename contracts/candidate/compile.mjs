// Isolated compiler process: print diagnostics without an Emscripten source dump.
import fs from 'node:fs';
import {compileFunc} from '@ton-community/func-js';
try {
  const source=process.argv[2];
  if(!['contracts/src/coolbears-collection-mint.fc','contracts/candidate/collection.fc'].includes(source))throw Error('Unexpected compiler source');
  const r=await compileFunc({targets:['collection.fc'],sources:{'stdlib.fc':fs.readFileSync('/tmp/token-contract/stdlib.fc','utf8'),'collection.fc':fs.readFileSync(source,'utf8')}});
  if(r.status!=='ok')throw Error(r.message);
  process.stdout.write(r.codeBoc+'\n');
} catch(e) {
  process.stderr.write('COMPILE_DIAGNOSTIC '+String(e?.message||e)+'\n');
  process.exitCode=1;
}
