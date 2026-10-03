// Local packaging only. Does not configure, start or publish a gateway/site.
import {build} from 'esbuild';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {validateConsoleConfig} from './config.mjs';
async function main(){
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../../..');
const args=process.argv.slice(2);let input=null,output=path.join(root,'operator/build/private-buyer-console');
for(let n=0;n<args.length;n++){if(args[n]==='--config'&&args[n+1])input=path.resolve(args[++n]);
  else if(args[n]==='--out'&&args[n+1])output=path.resolve(args[++n]);else throw Error('Use --config private/file.json and optional --out directory');}
let config=null;if(input)config=validateConsoleConfig(JSON.parse(await readFile(input,'utf8')));
await mkdir(output,{recursive:true});
await build({absWorkingDir:root,entryPoints:[path.join(here,'app.mjs')],bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,
  outfile:path.join(output,'app.js'),legalComments:'external',logLevel:'silent',inject:[path.join(root,'scripts/browser-buffer.mjs')],
  plugins:[{name:'private-console-config',setup(plugin){plugin.onResolve({filter:/^private-console:config$/},()=>({path:'config',namespace:'private-console'}));
    plugin.onLoad({filter:/.*/,namespace:'private-console'},()=>({contents:'export default '+JSON.stringify(config)+';',loader:'js'}));}}]});
await copyFile(path.join(here,'index.html'),path.join(output,'index.html'));
await copyFile(path.join(here,'style.css'),path.join(output,'style.css'));
let legal='';try{legal=await readFile(path.join(output,'app.js.LEGAL.txt'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
await writeFile(path.join(output,'LEGAL.txt'),legal);
await writeFile(path.join(output,'_headers'),'/*\n  Cache-Control: no-store\n  Content-Security-Policy: default-src \'none\'; script-src \'self\'; style-src \'self\'; connect-src \'self\'; img-src \'self\' data:; base-uri \'none\'; form-action \'none\'; frame-ancestors \'none\'; worker-src \'none\'\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n');
console.log(JSON.stringify({status:config?'private-candidate-built':'blocked-candidate-built',output,cluster:'devnet',salesOpen:false,sendingEnabled:false}));
}
try{await main();}catch{process.stderr.write('PRIVATE_CONSOLE_BUILD_FAILED: check the private configuration and local build inputs.\n');process.exitCode=1;}
