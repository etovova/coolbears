// Offline pinning only. No credentials, network calls or deployment.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readOrderFile} from '../check.mjs';
import {policy} from '../../prepare.mjs';
import {createOrderModel,validateOrderStorageOptions} from '../journal-model.mjs';
import {validateBuyerGatewayConfig} from './worker.mjs';
import {networkProfile} from '../../deployment/network.mjs';
export async function prepareBuyerGateway(orderFile,origin,{directory=fileURLToPath(new URL('./private',import.meta.url)),storageOptions={},authorizeMainnet=false}={}){
  const model=createOrderModel(policy,storageOptions),order=model.validateOrder(await readOrderFile(orderFile));
  const network=networkProfile(order.cluster);
  if(typeof authorizeMainnet!=='boolean'||(network.cluster==='mainnet-beta')!==authorizeMainnet)throw Error('NETWORK_AUTHORIZATION');
  const hidden=storageOptions.storageMode==='hidden-settings';
  const config=validateBuyerGatewayConfig({version:hidden?2:1,cluster:order.cluster,origin,machine:order.machine,collection:order.collection,guard:order.guard,
    ...(hidden?{storageMode:order.storageMode,hiddenCommitmentSha256:order.hiddenCommitmentSha256}:{}),
    ...(network.cluster==='mainnet-beta'?{genesisHash:network.genesisHash}:{})});
  // Existing directory (including a symlink) is a hard stop, never overwritten.
  await mkdir(directory,{mode:0o700});
  await writeFile(join(directory,'config.json'),JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
  const gatewayOptions=authorizeMainnet?',{allowMainnet:true'+(hidden?',trustedHiddenCommitmentSha256:'+JSON.stringify(storageOptions.hiddenCommitmentSha256):'')+'}':'';
  await writeFile(join(directory,'entry.mjs'),"import config from './config.json' with {type:'json'};\nimport {makeBuyerGateway} from '../worker.mjs';\nconst {worker,BuyerCheckGate}=makeBuyerGateway(config"+gatewayOptions+");\nexport {BuyerCheckGate};\nexport default worker;\n",{flag:'wx',mode:0o600});
  return{status:'prepared-offline',cluster:network.cluster,salesOpen:false,deployed:false,transactionsSent:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{let args=process.argv.slice(2),storageOptions={},authorizeMainnet=false;
    if(args[0]==='--mainnet'){authorizeMainnet=true;args=args.slice(1);}
    if(args[0]==='--storage-profile'&&args.length===4){storageOptions=validateOrderStorageOptions(await readOrderFile(args[1]));args=args.slice(2);}
    if(args.length!==2)throw Error('USAGE');console.log(JSON.stringify(await prepareBuyerGateway(args[0],args[1],{storageOptions,authorizeMainnet})));}
  catch{console.error(JSON.stringify({status:'blocked',code:'PREPARATION_FAILED',deployed:false,transactionsSent:0}));process.exitCode=1;}
}
