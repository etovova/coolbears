// Offline pinning only. No credentials, network calls or deployment.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readOrderFile} from '../check.mjs';
import {validateOrder} from '../journal.mjs';
import {validateBuyerGatewayConfig} from './worker.mjs';
export async function prepareBuyerGateway(orderFile,origin,{directory=fileURLToPath(new URL('./private',import.meta.url))}={}){
  const order=validateOrder(await readOrderFile(orderFile));
  const config=validateBuyerGatewayConfig({version:1,cluster:order.cluster,origin,machine:order.machine,collection:order.collection,guard:order.guard});
  // Existing directory (including a symlink) is a hard stop, never overwritten.
  await mkdir(directory,{mode:0o700});
  await writeFile(join(directory,'config.json'),JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
  await writeFile(join(directory,'entry.mjs'),"import config from './config.json' with {type:'json'};\nimport {makeBuyerGateway} from '../worker.mjs';\nconst {worker,BuyerCheckGate}=makeBuyerGateway(config);\nexport {BuyerCheckGate};\nexport default worker;\n",{flag:'wx',mode:0o600});
  return{status:'prepared-offline',cluster:'devnet',salesOpen:false,deployed:false,transactionsSent:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{if(process.argv.length!==4)throw Error('USAGE');console.log(JSON.stringify(await prepareBuyerGateway(process.argv[2],process.argv[3])));}
  catch{console.error(JSON.stringify({status:'blocked',code:'PREPARATION_FAILED',deployed:false,transactionsSent:0}));process.exitCode=1;}
}
