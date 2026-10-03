// Explicit disposable fixture paths only. No live keys, wallet, endpoint or RPC.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { policy } from '../prepare.mjs';
import { createDeploymentSignerVault, openDeploymentSignerVault } from '../deployment/vault.mjs';
import { createDeploymentBundle } from '../deployment/vault-store.mjs';
import { compileDeploymentRpcPolicy } from '../deployment/compile-rpc-policy.mjs';
import { appendDeploymentEvent } from '../deployment/journal.mjs';
import { inspectPrivateReadiness, runPrivateReadiness } from '../private-readiness.mjs';

let temp,options,fixture,ownerPolicy,originalFetch,networkCalls=0,ownerBefore;
const owner=Keypair.fromSeed(new Uint8Array(32).fill(201));
const phrase=Buffer.from('disposable-private-readiness-TEST-only');
const ownerEntry=submission=>`import policy from './policy.json' with { type: 'json' };
import { makeGateway } from '../worker.mjs';
const { worker, DeploymentGate } = makeGateway(policy, { allowSubmission: ${submission} });
export { DeploymentGate };
export default worker;
`;
const buyerEntry="import config from './config.json' with {type:'json'};\nimport {makeBuyerGateway} from '../worker.mjs';\nconst {worker,BuyerCheckGate}=makeBuyerGateway(config);\nexport {BuyerCheckGate};\nexport default worker;\n";
before(async()=>{
  originalFetch=globalThis.fetch;globalThis.fetch=()=>{networkCalls++;throw Error('network forbidden');};
  ownerBefore=policy.owner;policy.owner=owner.publicKey.toBase58();
  temp=await mkdtemp(join(tmpdir(),'coolbears-private-readiness-'));
  options={bundleDirectory:join(temp,'bundle'),ownerGatewayDirectory:join(temp,'owner'),buyerGatewayDirectory:join(temp,'buyer')};
  fixture=await createDeploymentSignerVault({id:'private-readiness-fixture',cluster:'devnet',
    blockhash:new PublicKey(new Uint8Array(32).fill(17)).toBase58(),lastValidBlockHeight:2000,
    machineRentLamports:'5000000000',passphrase:phrase});
  await createDeploymentBundle({directory:options.bundleDirectory,...fixture});
  ownerPolicy=await compileDeploymentRpcPolicy(fixture.manifest,{allowSimulation:true});
  const machine=fixture.manifest.steps[2].expected;
  const config={version:1,cluster:'devnet',origin:'https://private-readiness.test',machine:machine.machine,collection:machine.collection,guard:machine.guard};
  for(const directory of [options.ownerGatewayDirectory,options.buyerGatewayDirectory])await mkdir(directory,{mode:0o700});
  for(const [directory,file,value]of [[options.ownerGatewayDirectory,'policy.json',JSON.stringify(ownerPolicy)],
    [options.ownerGatewayDirectory,'entry.mjs',ownerEntry(false)],
    [options.buyerGatewayDirectory,'config.json',JSON.stringify(config)],[options.buyerGatewayDirectory,'entry.mjs',buyerEntry]])
    await writeFile(join(directory,file),value,{mode:0o600});
});
after(async()=>{globalThis.fetch=originalFetch;policy.owner=ownerBefore;phrase.fill(0);if(temp)await rm(temp,{recursive:true,force:true});assert.equal(networkCalls,0);});
async function files(directory= temp,prefix=''){
  const saved={};
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const name=prefix+entry.name;
    if(entry.isSymbolicLink())saved[name]='retained-symlink';
    else if(entry.isDirectory())Object.assign(saved,await files(join(directory,entry.name),name+'/'));
    else saved[name]=(await readFile(join(directory,entry.name))).toString('base64');
  }
  return saved;
}
async function mutation(directory,file,transform,verify){
  const filename=join(directory,file),before=await readFile(filename);
  try{await writeFile(filename,transform(before));await verify();}finally{await writeFile(filename,before);}
}
const safe=report=>{
  const output=JSON.stringify(report);
  for(const text of [temp,phrase.toString(),'ciphertextBase64','saltBase64','ivBase64','tagBase64','secret-sentinel',
    fixture.vault.ciphertextBase64,fixture.manifest.steps[1].expected.asset])assert.ok(!output.includes(text));
  for(const key of ['readyToSign','readyToSubmit','salesOpen','deploymentPerformed'])assert.equal(report[key],false);
  for(const key of ['networkRequests','signaturesCreated','transactionsSent'])assert.equal(report[key],0);
  assert.ok(report.prerequisites.every(value=>value.status==='unverified'));
};

test('existing encrypted bundle and prepared configs bind offline without modifying any bytes',async()=>{
  const before=await files(),result=await inspectPrivateReadiness(options);safe(result);
  assert.equal(result.status,'offline-bindings-verified');assert.ok(Object.values(result.checks).every(value=>value.status==='verified'));
  assert.equal(result.binding.cluster,'devnet');assert.equal(result.binding.journalRevision,0);
  assert.equal(result.binding.journalHead,result.binding.manifestSha256);
  for(const [key,value]of Object.entries(result.binding))if(key.endsWith('Sha256'))assert.match(value,/^[a-f0-9]{64}$/);
  assert.deepEqual(await files(),before);
});
test('missing exact paths and missing files yield concrete blocked reports without discovery or repair',async()=>{
  const missing=await inspectPrivateReadiness({});safe(missing);
  assert.deepEqual(Object.values(missing.checks).slice(0,3).map(value=>value.code),
    ['BUNDLE_PATH_REQUIRED','OWNER_GATEWAY_PATH_REQUIRED','BUYER_GATEWAY_PATH_REQUIRED']);
  const before=await files(),result=await inspectPrivateReadiness({...options,bundleDirectory:join(temp,'absent-secret-sentinel')});safe(result);
  assert.equal(result.checks.bundle.code,'BUNDLE_MISSING');assert.equal(result.binding,null);
  assert.equal(result.checks.ownerGateway.code,'BUNDLE_BINDING_REQUIRED');assert.deepEqual(await files(),before);
});
test('caller booleans, secret fields, malformed JSON and noncanonical entries never become verification',async()=>{
  const supplied=await inspectPrivateReadiness({...options,keysVerified:true,secret:'secret-sentinel'});safe(supplied);
  assert.equal(supplied.code,'ARGUMENTS_INVALID');
  for(const [directory,file,change,checkName]of [
    [options.ownerGatewayDirectory,'policy.json',()=>'{secret-sentinel','ownerGateway'],
    [options.ownerGatewayDirectory,'policy.json',bytes=>JSON.stringify({...JSON.parse(bytes),token:'secret-sentinel'}),'ownerGateway'],
    [options.buyerGatewayDirectory,'config.json',bytes=>JSON.stringify({...JSON.parse(bytes),passed:true}),'buyerGateway'],
    [options.buyerGatewayDirectory,'entry.mjs',()=>"throw Error('secret-sentinel');",'buyerGateway'],
  ])await mutation(directory,file,change,async()=>{
    const before=await files(),result=await inspectPrivateReadiness(options);safe(result);
    assert.equal(result.checks[checkName].status,'blocked');assert.equal(result.binding,null);assert.deepEqual(await files(),before);
  });
});
test('closed scope rejects owner submission and mismatched buyer account roles',async()=>{
  await mutation(options.ownerGatewayDirectory,'entry.mjs',()=>ownerEntry(true),async()=>{
    const result=await inspectPrivateReadiness(options);safe(result);assert.equal(result.checks.ownerGateway.code,'OWNER_SUBMISSION_ENABLED');
  });
  await mutation(options.buyerGatewayDirectory,'config.json',bytes=>{
    const config=JSON.parse(bytes);config.machine=Keypair.fromSeed(new Uint8Array(32).fill(202)).publicKey.toBase58();return JSON.stringify(config);
  },async()=>{
    const result=await inspectPrivateReadiness(options);safe(result);assert.equal(result.checks.buyerGateway.code,'BUYER_SCOPE_MISMATCH');
  });
});
test('unsafe modes, symlinks, oversized config and pending journal data are blocked and retained',async()=>{
  const config=join(options.buyerGatewayDirectory,'config.json');await chmod(config,0o644);
  try{assert.equal((await inspectPrivateReadiness(options)).checks.buyerGateway.code,'BUYER_GATEWAY_INVALID');}finally{await chmod(config,0o600);}
  const link=join(temp,'buyer-link');await symlink(options.buyerGatewayDirectory,link);
  assert.equal((await inspectPrivateReadiness({...options,buyerGatewayDirectory:link})).checks.buyerGateway.code,'BUYER_GATEWAY_INVALID');
  await mutation(options.buyerGatewayDirectory,'config.json',()=>Buffer.alloc(16385,32),async()=>{
    const result=await inspectPrivateReadiness(options);safe(result);assert.equal(result.checks.buyerGateway.code,'BUYER_GATEWAY_LIMIT');
  });
  const pending=join(options.bundleDirectory,'journal','.writer-lock');await mkdir(pending,{mode:0o700});
  try{const result=await inspectPrivateReadiness(options);safe(result);assert.equal(result.checks.bundle.code,'BUNDLE_BUSY_OR_INCOMPLETE');
    assert.deepEqual(await readdir(pending),[]);}finally{await rm(pending,{recursive:true});}
});
test('stale owner recovery policy is detected against newly retained signed journal evidence',async()=>{
  const signer=await openDeploymentSignerVault({...fixture,passphrase:phrase}),step=fixture.manifest.steps[0];let request;
  try{request=signer.partialSign({stepId:step.id,transactionBase64:step.transactionBase64,lastValidBlockHeight:step.lastValidBlockHeight,attempt:1});}
  finally{signer.dispose();}
  const journal=join(options.bundleDirectory,'journal');
  await appendDeploymentEvent(journal,{type:'prepare',stepId:step.id,request,retry:false},{expectedRevision:0});
  const tx=VersionedTransaction.deserialize(Buffer.from(request.transactionBase64,'base64'));tx.sign([owner]);
  const snapshot=await appendDeploymentEvent(journal,{type:'signed',stepId:step.id,attempt:1,transactionBase64:Buffer.from(tx.serialize()).toString('base64')},{expectedRevision:1});
  const before=await files(),stale=await inspectPrivateReadiness(options);safe(stale);
  assert.equal(stale.checks.ownerGateway.code,'OWNER_POLICY_STALE_OR_MISMATCHED');assert.deepEqual(await files(),before);
  const current=await compileDeploymentRpcPolicy(fixture.manifest,{allowSimulation:true,recoverySignatures:[snapshot.steps[0].attempts[0].signed.signature]});
  await writeFile(join(options.ownerGatewayDirectory,'policy.json'),JSON.stringify(current));
  const updatedBefore=await files(),updated=await inspectPrivateReadiness(options);safe(updated);
  assert.equal(updated.status,'offline-bindings-verified');assert.equal(updated.binding.journalRevision,2);assert.equal(updated.binding.journalHead,snapshot.headHash);
  assert.deepEqual(await files(),updatedBefore);
});
test('CLI reports only safe JSON and treats successful offline inspection as no live validation',async()=>{
  let text='';const output={write:value=>{text+=value;}};
  assert.equal(await runPrivateReadiness(['inspect',...Object.values(options)],{output}),0);
  const result=JSON.parse(text);safe(result);assert.equal(result.status,'offline-bindings-verified');
  text='';assert.equal(await runPrivateReadiness(['inspect','secret-sentinel'],{output}),1);
  const blocked=JSON.parse(text);safe(blocked);assert.equal(blocked.code,'ARGUMENTS_INVALID');
});
