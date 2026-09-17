// Real validator, mutated files in disposable directories. No network or signing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const files=['scripts/validate-mint-policy.mjs','scripts/validate-release-state.mjs','release-guard.mjs','release/launch-state.json','contracts/mint-policy.json','mainnet/owner/deployment.json','config.js'];
const base=Object.fromEntries(files.map(p=>[p,fs.readFileSync(p,'utf8')]));
base['config.js']=base['config.js'].replace(/demoMode:\s*(true|false)/,'demoMode: true');
base['release/launch-state.json']=JSON.stringify({...JSON.parse(base['release/launch-state.json']),phase:'hold',testnetVerified:false,privateStorageVerified:false,mainnetVerified:false,creatorNftVerified:false,publicMintApproved:false,automaticRevealArmed:false,evidence:{},packageSha256:null});
const cases=[
 ['valid closed configuration',null,null,true],
 ['wrong price','priceTon: 7,','priceTon: 70,',false],
 ['wrong supply','supply: 10000,','supply: 10001,',false],
 ['unauthorized opening','demoMode: true','demoMode: false',false],
 ['missing collection',/collectionAddress: '[^']*'/,"collectionAddress: ''",false],
 ['wrong mint destination',/mintContractAddress: '[^']*'/,"mintContractAddress: 'UQwrong'",false],
 ['wrong treasury',/treasuryAddress: '[^']*'/,"treasuryAddress: 'UQwrong'",false],
 ['wrong metadata root',/preRevealMetadataRootCid: '[^']*'/,"preRevealMetadataRootCid: 'bafbad'",false],
 ['wrong code hash',/collectionCodeHash: '[^']*'/,"collectionCodeHash: '0000'",false],
 ['missing demo flag','demoMode: true','otherFlag: true',false]
];
for(const [name,from,to,ok] of cases){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cb-policy-'));
 try{
  for(const [p,content] of Object.entries(base)){
   const destination=path.join(root,p);fs.mkdirSync(path.dirname(destination),{recursive:true});
   const changed=p==='config.js'&&from!==null?content.replace(from,to):content;
   if(p==='config.js'&&from!==null)assert.notEqual(changed,content,'Mutation did not apply');
   fs.writeFileSync(destination,changed);
  }
  const r=spawnSync(process.execPath,['scripts/validate-mint-policy.mjs'],{cwd:root,encoding:'utf8',timeout:5000});
  assert.equal(r.status===0,ok,`${name}: ${r.stderr}`);
  console.log('PASS',name);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
console.log('MINT_POLICY_REGRESSION_OK',cases.length);
