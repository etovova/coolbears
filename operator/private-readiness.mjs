// Offline inspection of explicit existing private inputs. No signing, unlock,
// preparation, network, deployment, cleanup or configuration writes.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join, parse, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readDeploymentBundle } from './deployment/vault-store.mjs';
import { compileDeploymentRpcPolicy } from './deployment/compile-rpc-policy.mjs';
import { createRequestValidator } from './deployment/request-policy.mjs';
import { sha256Json } from './deployment/journal.mjs';
import { validateBuyerGatewayConfig } from './orders/gateway/worker.mjs';

const LIMITS = Object.freeze({manifest:16*1024*1024, policy:2*1024*1024, small:16384,
  event:65536, events:20000, total:64*1024*1024});
const paths = ['bundleDirectory','ownerGatewayDirectory','buyerGatewayDirectory'];
const ownerEntry = submission => `import policy from './policy.json' with { type: 'json' };
import { makeGateway } from '../worker.mjs';
const { worker, DeploymentGate } = makeGateway(policy, { allowSubmission: ${submission} });
export { DeploymentGate };
export default worker;
`;
const buyerEntry = "import config from './config.json' with {type:'json'};\nimport {makeBuyerGateway} from '../worker.mjs';\nconst {worker,BuyerCheckGate}=makeBuyerGateway(config);\nexport {BuyerCheckGate};\nexport default worker;\n";
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (value, code='INVALID') => { if(!value)throw Object.assign(Error('Private readiness input is unavailable.'),{code}); };
const check = (status, code=null) => ({status,code});
const closed = () => ({readyToSign:false,readyToSubmit:false,salesOpen:false,deploymentPerformed:false,
  networkRequests:0,signaturesCreated:0,transactionsSent:0});
const prerequisites = () => [
  'deployment-keys-unlocked-and-verified', 'live-owner-and-buyer-endpoint-configuration',
  'live-secret-installation', 'live-rpc-path-and-unsigned-simulation',
  'real-wallet-and-phone-validation', 'deployment-and-on-chain-reconciliation',
].map(id=>({id,status:'unverified'}));
function report() {
  return {version:1,mode:'offline-private-readiness',status:'blocked',
    checks:{bundle:check('not-checked'),ownerGateway:check('not-checked'),buyerGateway:check('not-checked'),stability:check('not-checked')},
    binding:null,prerequisites:prerequisites(),...closed()};
}
function privateStat(stat,directory=false,limit=LIMITS.small){
  const uid=typeof process.geteuid==='function'?process.geteuid():process.getuid?.();
  need(uid!==undefined&&stat.uid===uid&&(stat.mode&0o7777)===(directory?0o700:0o600));
  need(directory?stat.isDirectory():stat.isFile());
  if(!directory)need(Number.isSafeInteger(stat.size)&&stat.size>=0&&stat.size<=limit,'LIMIT');
}
async function privateDirectory(directory){
  const absolute=resolve(directory),root=parse(absolute).root;let current=root;
  for(const part of absolute.slice(root.length).split(sep).filter(Boolean)){
    current=join(current,part);const stat=await lstat(current);need(stat.isDirectory()&&!stat.isSymbolicLink());
  }
  privateStat(await lstat(absolute),true);return absolute;
}
async function names(directory,maximum){
  const result=[];
  for await(const entry of await opendir(directory)){need(result.length<maximum,'LIMIT');result.push(entry.name);}
  return result.sort();
}
async function bundleBudget(directory){
  const root=await privateDirectory(directory);
  need(isDeepStrictEqual(await names(root,4),['READY.json','journal','vault.json']),'INCOMPLETE');
  await privateDirectory(join(root,'journal'));await privateDirectory(join(root,'journal/events'));
  need(isDeepStrictEqual(await names(join(root,'journal'),3),['events','manifest.json']),'INCOMPLETE');
  const events=await names(join(root,'journal/events'),LIMITS.events+1);
  need(events.length<=LIMITS.events&&events.every(name=>/^\d{8}\.json$/.test(name)),'LIMIT');
  const files=[['READY.json',LIMITS.small],['vault.json',LIMITS.small],['journal/manifest.json',LIMITS.manifest],
    ...events.map(name=>['journal/events/'+name,LIMITS.event])];
  let bytes=0;
  for(const [name,limit]of files){const stat=await lstat(join(root,name));privateStat(stat,false,limit);
    need(!stat.isSymbolicLink()&&(bytes+=stat.size)<=LIMITS.total,'LIMIT');}
  return root;
}
async function boundedFile(directory,name,limit){
  const filename=join(directory,name);let handle;
  try{
    handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before=await handle.stat();privateStat(before,false,limit);
    const chunks=[];let size=0;
    while(size<=limit){
      const bytes=Buffer.alloc(Math.min(65536,limit+1-size));
      const result=await handle.read(bytes,0,bytes.length,null);if(!result.bytesRead)break;
      size+=result.bytesRead;need(size<=limit,'LIMIT');chunks.push(bytes.subarray(0,result.bytesRead));
    }
    const after=await handle.stat(),named=await lstat(filename);privateStat(after,false,limit);privateStat(named,false,limit);
    need(!named.isSymbolicLink()&&before.dev===named.dev&&before.ino===named.ino&&before.size===size&&after.size===size
      &&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs,'CHANGED');
    return Buffer.concat(chunks,size);
  }finally{await handle?.close();}
}
const json=bytes=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
async function gatewayFiles(directory,owner){
  const root=await privateDirectory(directory);
  const configuration=await boundedFile(root,owner?'policy.json':'config.json',owner?LIMITS.policy:LIMITS.small);
  const entry=await boundedFile(root,'entry.mjs',LIMITS.small);
  return {root,configuration,entry,value:json(configuration)};
}
function inputCode(prefix,error){
  return prefix+({ENOENT:'_MISSING',LIMIT:'_LIMIT',INCOMPLETE:'_BUSY_OR_INCOMPLETE',CHANGED:'_CHANGED'}[error?.code]??'_INVALID');
}
function sameHead(a,b){return a.manifestSha256===b.manifestSha256&&a.headHash===b.headHash&&a.revision===b.revision;}

export async function inspectPrivateReadiness(input={}){
  const result=report();let options;
  try{
    need(input&&Object.getPrototypeOf(input)===Object.prototype&&Reflect.ownKeys(input).every(key=>paths.includes(key)));
    options=Object.fromEntries(paths.map(key=>{
      const descriptor=Object.getOwnPropertyDescriptor(input,key);need(!descriptor||Object.hasOwn(descriptor,'value'));
      const value=descriptor?.value;need(value===undefined||(typeof value==='string'&&value.length>0&&value.length<=4096&&!value.includes('\0')));
      return [key,value];
    }));
  }catch{result.code='ARGUMENTS_INVALID';return result;}
  let bundle,owner,buyer;
  if(!options.bundleDirectory)result.checks.bundle=check('blocked','BUNDLE_PATH_REQUIRED');
  else try{
    const root=await bundleBudget(options.bundleDirectory);bundle=await readDeploymentBundle(root);
    need(bundle.snapshot.manifest.cluster==='devnet');result.checks.bundle=check('verified');
  }catch(error){result.checks.bundle=check('blocked',inputCode('BUNDLE',error));}
  if(!options.ownerGatewayDirectory)result.checks.ownerGateway=check('blocked','OWNER_GATEWAY_PATH_REQUIRED');
  else try{
    owner=await gatewayFiles(options.ownerGatewayDirectory,true);createRequestValidator(owner.value);
    need(owner.entry.toString()!==ownerEntry(true),'SUBMISSION_ENABLED');
    need(owner.entry.toString()===ownerEntry(false));
    if(!bundle)result.checks.ownerGateway=check('blocked','BUNDLE_BINDING_REQUIRED');
    else{
      const recoverySignatures=bundle.snapshot.steps.flatMap(step=>step.attempts).filter(attempt=>attempt.signed).map(attempt=>attempt.signed.signature);
      const expected=await compileDeploymentRpcPolicy(bundle.snapshot.manifest,{allowSimulation:owner.value.allowSimulation,recoverySignatures});
      need(isDeepStrictEqual(owner.value,expected),'BINDING');result.checks.ownerGateway=check('verified');
    }
  }catch(error){result.checks.ownerGateway=check('blocked',error.code==='BINDING'?'OWNER_POLICY_STALE_OR_MISMATCHED'
    :error.code==='SUBMISSION_ENABLED'?'OWNER_SUBMISSION_ENABLED':inputCode('OWNER_GATEWAY',error));}
  if(!options.buyerGatewayDirectory)result.checks.buyerGateway=check('blocked','BUYER_GATEWAY_PATH_REQUIRED');
  else try{
    buyer=await gatewayFiles(options.buyerGatewayDirectory,false);buyer.value=validateBuyerGatewayConfig(buyer.value);
    need(buyer.entry.toString()===buyerEntry);
    if(!bundle)result.checks.buyerGateway=check('blocked','BUNDLE_BINDING_REQUIRED');
    else{
      const expected=bundle.snapshot.manifest.steps[2].expected;
      need(['machine','collection','guard'].every(field=>buyer.value[field]===expected[field]),'BINDING');
      result.checks.buyerGateway=check('verified');
    }
  }catch(error){result.checks.buyerGateway=check('blocked',error.code==='BINDING'?'BUYER_SCOPE_MISMATCH':inputCode('BUYER_GATEWAY',error));}
  if(['bundle','ownerGateway','buyerGateway'].some(key=>result.checks[key].status!=='verified'))return result;
  try{
    // The original head is an observation of this run, not an invented record
    // of when either historical preparation command produced its files.
    await bundleBudget(options.bundleDirectory);
    const fresh=await readDeploymentBundle(options.bundleDirectory);
    need(sameHead(bundle.snapshot,fresh.snapshot)&&sha256Json(bundle.vault)===sha256Json(fresh.vault));
    for(const [saved,isOwner]of [[owner,true],[buyer,false]]){
      const current=await gatewayFiles(saved.root,isOwner);
      need(saved.configuration.equals(current.configuration)&&saved.entry.equals(current.entry));
    }
    const snapshot=bundle.snapshot;
    const binding={cluster:'devnet',manifestSha256:snapshot.manifestSha256,journalRevision:snapshot.revision,journalHead:snapshot.headHash,
      ownerPolicySha256:digest(owner.configuration),ownerEntrySha256:digest(owner.entry),
      buyerConfigSha256:digest(buyer.configuration),buyerEntrySha256:digest(buyer.entry)};
    result.binding={...binding,inspectionSha256:sha256Json(binding)};
    result.checks.stability=check('verified');result.status='offline-bindings-verified';
  }catch{result.checks.stability=check('blocked','INPUTS_CHANGED_OR_UNAVAILABLE');}
  return result;
}

export async function runPrivateReadiness(args,{output=process.stdout}={}){
  let result;
  if(!Array.isArray(args)||args.length!==4||args[0]!=='inspect'||!args.every(value=>typeof value==='string'&&!value.startsWith('-'))){
    result=report();result.code='ARGUMENTS_INVALID';
  }else result=await inspectPrivateReadiness(Object.fromEntries(paths.map((key,index)=>[key,args[index+1]])));
  try{output.write(JSON.stringify(result)+'\n');}catch{return 1;}
  return result.status==='offline-bindings-verified'?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode=await runPrivateReadiness(process.argv.slice(2));
