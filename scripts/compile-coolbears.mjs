import fs from 'node:fs';
import { compileFunc } from '@ton-community/func-js';

const stdlibPath = process.env.FUNC_STDLIB || '/tmp/token-contract/stdlib.fc';
const contractPath = 'contracts/src/coolbears-collection-mint.fc';

const sources = {
  'stdlib.fc': fs.readFileSync(stdlibPath, 'utf8'),
  'coolbears-collection-mint.fc': fs.readFileSync(contractPath, 'utf8'),
};

const result = await compileFunc({
  targets: ['coolbears-collection-mint.fc'],
  sources,
});

if (result.status === 'error') {
  console.error(result.message);
  process.exit(1);
}

fs.mkdirSync('build/contracts', { recursive: true });
fs.writeFileSync('build/contracts/coolbears-collection-mint.fif', result.fiftCode);
fs.writeFileSync('build/contracts/coolbears-collection-mint.cell.boc.base64', result.codeBoc);
console.log('CoolBears FunC compile: OK');
