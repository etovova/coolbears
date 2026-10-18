import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
export async function buildPublicLicenses({workspace,sourceBindings,commonJsBindings}){
  const names=new Set(['buffer','base64-js','ieee754']);
  for(const record of [...sourceBindings,...commonJsBindings])if(record.path.startsWith('operator/node_modules/')){
    const pieces=record.path.slice('operator/node_modules/'.length).split('/');names.add(pieces[0].startsWith('@')?pieces.slice(0,2).join('/'):pieces[0]);}
  const apachePath=path.join(workspace,'public-mainnet/vendor/wallet-standard-app.LICENSE'),apache=await readFile(apachePath),parts=[],entries=[];
  for(const name of [...names].sort()){
    const packageRoot=path.join(workspace,'operator/node_modules',name),packagePath=path.join(packageRoot,'package.json'),packageBytes=await readFile(packagePath),info=JSON.parse(packageBytes);
    let license,licensePath;for(const filename of ['LICENSE','LICENSE.txt','LICENSE.md','LICENCE','LICENCE.txt','LICENCE.md','license','license.txt','license.md','LICENSE-MIT'])try{licensePath=path.join(packageRoot,filename);license=await readFile(licensePath);break;}catch{}
    const reusedApache=!license&&info.license==='Apache-2.0';if(reusedApache){license=apache;licensePath=apachePath;}if(!license)throw Error('MISSING_PACKAGE_LICENSE:'+name);
    const attribution=`\n===== ${name} ${info.version} =====\n${info.author?`Author: ${typeof info.author==='string'?info.author:JSON.stringify(info.author)}\n`:''}${info.repository?`Repository: ${typeof info.repository==='string'?info.repository:info.repository.url}\n`:''}`;
    parts.push(Buffer.from(attribution),license,Buffer.from('\n'));
    entries.push({name,version:info.version,license:info.license,packagePath:path.relative(workspace,packagePath),packageBytes:packageBytes.length,packageSha256:hash(packageBytes),
      licensePath:path.relative(workspace,licensePath),licenseBytes:license.length,licenseSha256:hash(license),
      ...(reusedApache?{licenseTextSource:'Canonical Apache-2.0 text retained from the official Wallet Standard license; this npm package declares Apache-2.0 but excludes a separate license file from its published files. Original source notices are preserved in the fixed graph.'}:{})});
  }
  parts.push(Buffer.from('\n===== @wallet-standard/app 1.1.1 =====\n'),apache,Buffer.from('\n'));
  entries.push({name:'@wallet-standard/app',version:'1.1.1',license:'Apache-2.0',licensePath:path.relative(workspace,apachePath),licenseBytes:apache.length,licenseSha256:hash(apache),officialSourceBlob:'d645695673349e3947e8e5ae42332d0ac3164cd7'});
  const bytes=Buffer.concat(parts),output=path.join(workspace,'public-mainnet/LEGAL.txt');await writeFile(output,bytes,{mode:0o600});
  const proof={version:1,packageCount:entries.length,artifact:'public-mainnet/LEGAL.txt',bytes:bytes.length,sha256:hash(bytes),entries,
    coverage:'All contributing fixed ESM/CommonJS package roots plus embedded Buffer dependencies and the official Wallet Standard source.',npmInstallations:0};
  const reportDirectory=path.join(workspace,'build/public-mainnet');await mkdir(reportDirectory,{recursive:true});
  await writeFile(path.join(reportDirectory,'public-browser-license-binding.SAFE.json'),JSON.stringify(proof,null,2)+'\n',{mode:0o600});return proof;
}
