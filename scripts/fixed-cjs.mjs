// Build-time CommonJS packaging. Original dependency bodies are carried inside
// ordinary static functions; the browser never uses eval, Function or Node require.
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
export function createFixedCjs({workspace,deps,bundleModule,routeFor,assets,bindings,bufferFile}){
  const factories=new Map(),external=new Map(),packageCache=new Map(),runtimeRoute='/public-mainnet/modules/cjs-runtime.mjs';
  const requireNative=createRequire(path.join(deps,'__fixed_packager__.cjs'));
  const read=file=>readFile(file,'utf8');
  async function packageFor(file){let directory=path.dirname(file);while(directory.startsWith(workspace)){if(packageCache.has(directory))return packageCache.get(directory);try{const value={root:directory,info:JSON.parse(await read(path.join(directory,'package.json')))};packageCache.set(directory,value);return value;}catch{}directory=path.dirname(directory);}return null;}
  async function isCommonJs(file,body){if(file.endsWith('.cjs'))return true;if(!file.endsWith('.js')||/^\s*(?:import|export)\b/m.test(body))return false;const value=await packageFor(file);return value?.info.type!=='module';}
  async function fileAt(base){for(const file of [base,base+'.js',base+'.json',path.join(base,'index.js')])try{if((await stat(file)).isFile())return file;}catch{}throw Error('COMMONJS_RESOLVE:'+base);}
  async function resolve(specifier,importer){
    const current=await packageFor(importer),browser=current?.info.browser;
    const local=specifier.startsWith('.')?'./'+path.relative(current.root,path.resolve(path.dirname(importer),specifier)).split(path.sep).join('/'):specifier;
    const mapped=browser&&typeof browser==='object'?(browser[specifier]??browser[local]??browser[local+'.js']):undefined;
    if(mapped===false)return{empty:true};if(typeof mapped==='string')return resolve(mapped,current.root+'/__browser_entry__.js');
    if(specifier==='@solana/web3.js'||specifier==='buffer')return{esmSpecifier:specifier};
    if(/^(?:node:|https?:|\/)/.test(specifier)||['crypto','stream','http','https','fs','path','url','util','os','zlib','net','tls','events','assert'].includes(specifier))throw Error('COMMONJS_NODE_OR_REMOTE:'+specifier+' '+importer);
    if(specifier.startsWith('.'))return{file:await fileAt(path.resolve(path.dirname(importer),specifier))};
    const parts=specifier.split('/'),name=parts[0].startsWith('@')?parts.splice(0,2).join('/'):parts.shift(),root=path.join(deps,name),info=JSON.parse(await read(path.join(root,'package.json')));
    let entry=info.exports?.[parts.length?'./'+parts.join('/') : '.'];if(typeof entry==='object')entry=entry.browser??entry.import??entry.default??entry.require;if(typeof entry==='object')entry=entry.import??entry.default??entry.require;
    if(!entry)entry=parts.join('/')||(typeof info.browser==='string'?info.browser:null)||info.module||info.main||'index.js';
    return{file:await fileAt(path.join(root,entry))};
  }
  const idFor=file=>hash(path.relative(workspace,file)).slice(0,24);
  async function collect(file){
    const id=idFor(file);if(factories.has(id))return id;
    const original=await read(file),record={file,original,map:{},body:original.replace(/^\/\/# sourceMappingURL=.*$/gm,'')};factories.set(id,record);
    if(file.endsWith('.json')){record.body='module.exports='+JSON.stringify(JSON.parse(original))+';';return id;}
    for(const match of original.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'').matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g)){
      const specifier=match[2];if(Object.hasOwn(record.map,specifier))continue;const target=await resolve(specifier,file);
      if(target.empty){record.map[specifier]={empty:true};continue;}
      if(target.esmSpecifier){const resolved=target.esmSpecifier==='buffer'?bufferFile:path.join(deps,'@solana/web3.js/lib/index.iife.min.js'),route=await bundleModule(resolved);if(!external.has(route))external.set(route,external.size);record.map[specifier]={external:route};continue;}
      const body=await read(target.file);if(await isCommonJs(target.file,body)||target.file.endsWith('.json'))record.map[specifier]={id:await collect(target.file)};
      else{const route=await bundleModule(target.file);if(!external.has(route))if(!external.has(route))external.set(route,external.size);record.map[specifier]={external:route};}
    }
    return id;
  }
  async function bridge(file,original){
    const id=await collect(file),route=routeFor(file),exports=requireNative(file),names=Object.keys(exports).filter(name=>/^[A-Za-z_$][\w$]*$/.test(name)&&name!=='default');
    const body=`import {getCommonJs} from '${runtimeRoute}';\nconst value=getCommonJs('${id}');\nexport default value;\n${names.length?'export const {'+names.join(',')+'}=value;':''}\n`;
    assets[route]=body;bindings.push({path:path.relative(workspace,file),originalBytes:Buffer.byteLength(original),originalSha256:hash(original),route,bytes:Buffer.byteLength(body),sha256:hash(body),transformation:'Static namespace bridge into fixed CommonJS dependency graph; original body bound in commonJsBindings.'});return route;
  }
  async function finish(){
    if(!factories.size)return[];const bufferRoute=await bundleModule(bufferFile);let body=`import {Buffer} from '${bufferRoute}';\n`;
    for(const [route,index]of external)body+=`import * as external${index} from '${route}';\n`;
    body+='const namespaces={'+[...external].map(([route,index])=>JSON.stringify(route)+':external'+index).join(',')+'};\nconst factories={\n';
    for(const[id,record]of factories)body+=JSON.stringify(id)+':(module,exports,require)=>{\n'+record.body+'\n},\n';
    body+='};\nconst maps='+JSON.stringify(Object.fromEntries([...factories].map(([id,record])=>[id,record.map])))+';\n';
    body+="const cache=new Map();export function getCommonJs(id){if(cache.has(id))return cache.get(id).exports;if(!Object.hasOwn(factories,id))throw Error('FIXED_MODULE');const module={exports:{}};cache.set(id,module);const require=name=>{const target=maps[id][name];if(!target)throw Error('FIXED_REQUIRE');if(target.empty)return{};return target.external?namespaces[target.external]:getCommonJs(target.id);};try{factories[id](module,module.exports,require);return module.exports;}catch(error){cache.delete(id);throw error;}}\n";
    assets[runtimeRoute]=body;return[...factories].map(([id,record])=>({id,path:path.relative(workspace,record.file),originalBytes:Buffer.byteLength(record.original),originalSha256:hash(record.original),factoryBodySha256:hash(record.body),literalRequires:Object.keys(record.map).length}));
  }
  return{isCommonJs,bridge,finish,runtimeRoute};
}
