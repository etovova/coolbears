import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const bytes=await readFile(new URL('../app.js',import.meta.url)),source=bytes.toString();
async function fixture(failed=false){
 const nodes=new Map(),langs=[];function node(id){return{id,value:id==='qty'?'1':'',textContent:'',dataset:{},hidden:false,disabled:false,attributes:{},listeners:new Map(),classList:{toggle(){},remove(){}},addEventListener(name,fn){this.listeners.set(name,fn);},setAttribute(name,value){this.attributes[name]=value;},removeAttribute(name){delete this.attributes[name];}};}
 for(const id of ['qty','total','unitPrice','walletBtn','mintBtn','mintNote','marketplaceTop','backTop','minted','minus','plus'])nodes.set('#'+id,node(id));for(const lang of ['en','ru','zh']){const n=node(lang);n.dataset.lang=lang;langs.push(n);}
 const document={documentElement:{},body:{append(){}},createElement:()=>node('created'),querySelector:key=>nodes.get(key)??null,querySelectorAll:key=>key==='.bear-lang'?langs:[]};
 let connectCalls=0,renderCalls=0,legacyImports=0,resolveConnect,mounted=false;const connectPending=new Promise(resolve=>{resolveConnect=resolve;});
 const ctx=vm.createContext({document,window:{COOLBEARS_CONFIG:{priceSol:0.2,maxPerOrder:50},scrollY:0,addEventListener(){},scrollTo(){}},localStorage:{getItem:()=>null,setItem(){}},setTimeout,clearTimeout,console});
 const script=new vm.Script(source,{importModuleDynamically:async specifier=>{if(specifier!=='./public-mainnet/site-entry.mjs'){legacyImports++;throw Error('UNEXPECTED_LEGACY_IMPORT');}if(failed)throw Error('MODULE_UNAVAILABLE');
  const module=new vm.SyntheticModule(['mount'],function(){this.setExport('mount',options=>{mounted=true;assert.equal(options.language(),'en');return{render(){renderCalls++;nodes.get('#mintBtn').disabled=false;},async connect(){connectCalls++;await connectPending;options.onWalletChange('11111111111111111111111111111112');}};});},{context:ctx});await module.link(()=>{});await module.evaluate();return module;}});
 script.runInContext(ctx);await new Promise(resolve=>setImmediate(resolve));return{nodes,langs,stats:()=>({connectCalls,renderCalls,legacyImports,mounted}),resolveConnect};
}
const cases=[];
const f=await fixture();assert.equal(f.stats().mounted,true);assert.equal(f.nodes.get('#mintBtn').disabled,false);const before=f.stats().renderCalls;f.langs[1].listeners.get('click')();assert.equal(f.stats().renderCalls,before+1);assert.equal(f.nodes.get('#mintBtn').disabled,false);cases.push({name:'language-render-delegates-to-validated-public-view-without-forcing-old-closed-control',passed:true});
const first=f.nodes.get('#walletBtn').listeners.get('click')(),second=f.nodes.get('#walletBtn').listeners.get('click')();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.stats().connectCalls,1);f.resolveConnect();await Promise.all([first,second]);assert.equal(f.stats().legacyImports,0);cases.push({name:'one-explicit-wallet-open-delegates-once-and-never-loads-old-sign-and-send-adapter',passed:true});
const blocked=await fixture(true);assert.equal(blocked.nodes.get('#mintBtn').disabled,true);await blocked.nodes.get('#walletBtn').listeners.get('click')();assert.equal(blocked.stats().connectCalls,0);assert.equal(blocked.stats().legacyImports,0);cases.push({name:'missing-public-module-fails-closed-and-retains-page-controls',passed:true});
const proof={version:1,passed:true,checksPassed:cases.length,checksFailed:0,cases,app:{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},actualWalletCalls:0,actualRpcRequests:0,
 limitations:['Actual root application bridge executed in Node VM with a small DOM and a trusted synthetic public-mount module. The full production module graph and public view are tested separately.','This test does not attest real browser rendering, wallets, deployed readiness or actual chain state.']};await writeFile(new URL('../build/public-mainnet/public-main-bridge-validation.SAFE.json',import.meta.url),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify({passed:true,checks:cases.length}));
