// Idempotent integration. No deployment, signatures or chain transactions.
import fs from 'node:fs';
const replace=(file,from,to)=>{let s=fs.readFileSync(file,'utf8');if(s.includes(to))return;if(!s.includes(from))throw Error('Expected source changed: '+file+' / '+from.slice(0,60));s=s.replace(from,to);fs.writeFileSync(file,s);};
replace('scripts/audit-prereveal-privacy.mjs',"if (!configText.includes('demoMode: true')) throw new Error('Production mint must remain gated before live mainnet verification');","await import('./validate-release-state.mjs');");
replace('scripts/audit-prereveal-privacy.mjs',"console.log('Production mint gate: CLOSED');","console.log('Production mint gate validated against release/launch-state.json');");
replace('scripts/validate-mint-policy.mjs',"assert.equal(c.demoMode, true, 'Prelaunch sale gate must remain closed');","await import('./validate-release-state.mjs');");
replace('scripts/validate-mint-policy.mjs',"console.log('CoolBears mint policy: package, metadata references and CLOSED gate OK');","console.log('CoolBears mint policy: package, metadata references and release gate OK');");
replace('scripts/test-owner-launch.mjs',"assert.equal(cfgContext.window.COOLBEARS_CONFIG.demoMode,true,'Sales must remain closed during preparation');","await import('./validate-release-state.mjs');");
// Domain-level wallet tests isolate the separately tested release guard.
replace('scripts/test-owner-launch.mjs',"setUp(p,h){d=p;wallet=","setUp(p,h){d=p;releaseAllows=async()=>true;wallet=");
replace('mainnet/owner/owner.js','async function send(action){',`async function releaseAllows(action){
  const {validateLaunch,canOperate,OWNER_FRIENDLY}=await import('../../release-guard.mjs');
  const response=await fetch('deployment.json',{cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('Пакет запуска недоступен');
  const raw=await response.arrayBuffer(),p=JSON.parse(new TextDecoder().decode(raw));
  if(p.stateInitBocBase64!==d.stateInitBocBase64)throw Error('Пакет изменился. Перезагрузи страницу');
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),x=>x.toString(16).padStart(2,'0')).join('');
  const responseState=await fetch('../../release/launch-state.json',{cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(!responseState.ok)throw Error('Разрешение запуска недоступно');
  const c={network:'mainnet',priceTon:7,supply:10000,royaltyPercent:7,maxPerTransaction:50,revealDate:'2027-01-01',mintPaymentPerNftTon:7.1,mintPaymentPerNftNano:7100000000,treasuryAddress:OWNER_FRIENDLY,royaltyAddress:OWNER_FRIENDLY,collectionAddress:p.collectionAddressMainnetNonBounceable,mintContractAddress:p.collectionAddressMainnetBounceable,collectionCodeHash:p.collectionCodeHash};
  const release=await responseState.json();c.demoMode=release.phase!=='live';
  return canOperate(action,validateLaunch(c,p,release,hash),state,isOwner());
}
async function send(action){`);
replace('mainnet/owner/owner.js',"await check();if(!allowed(action))throw Error('Операция недоступна для текущего состояния');","await check();if(!allowed(action))throw Error('Операция недоступна для текущего состояния');\n    if(!(await releaseAllows(action)))throw Error('Запуск заблокирован: пакет ещё не прошёл все этапы проверки');");
replace('mainnet/owner/index.html','owner.js?v=2','owner.js?v=release-guard-1');
replace('config.js',"liveMint.src = 'mint-live.js?v=1';","liveMint.src = 'mint-live.js?v=release-guard-1';");
replace('mint-live.js','async function mint(){',`async function approvedRelease(){
    const {validateLaunch}=await import('./release-guard.mjs');
    const [pr,sr]=await Promise.all([fetch('mainnet/owner/deployment.json',{cache:'no-store',signal:AbortSignal.timeout(15000)}),fetch('release/launch-state.json',{cache:'no-store',signal:AbortSignal.timeout(15000)})]);
    if(!pr.ok||!sr.ok)throw Error('Launch approval unavailable');
    const raw=await pr.arrayBuffer();const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),x=>x.toString(16).padStart(2,'0')).join('');
    const p=JSON.parse(new TextDecoder().decode(raw));
    if(!validateLaunch(cfg,p,await sr.json(),hash).sales)throw Error('Public mint has not been approved');
    return p;
  }
  async function mint(){`);
replace('mint-live.js',"const count=n();const s=await checkLive();","await approvedRelease();\n      const count=n();const s=await checkLive();");
const pf='scripts/public-files.json',files=JSON.parse(fs.readFileSync(pf));for(const f of ['release-guard.mjs','release/launch-state.json'])if(!files.includes(f))files.push(f);fs.writeFileSync(pf,JSON.stringify(files.sort(),null,2)+'\n');
replace('scripts/test-release-guard.mjs',"const cfg=ctx.window.COOLBEARS_CONFIG,hold=JSON.parse(fs.readFileSync('release/launch-state.json','utf8'));","const cfg={...ctx.window.COOLBEARS_CONFIG,demoMode:true},hold={...JSON.parse(fs.readFileSync('release/launch-state.json','utf8')),phase:'hold',testnetVerified:false,privateStorageVerified:false,mainnetVerified:false,creatorNftVerified:false,publicMintApproved:false,automaticRevealArmed:false,packageSha256:null,evidence:{}};");
replace('scripts/test-mint-policy-config.mjs',"const files=['scripts/validate-mint-policy.mjs','contracts/mint-policy.json','mainnet/owner/deployment.json','config.js'];", "const files=['scripts/validate-mint-policy.mjs','scripts/validate-release-state.mjs','release-guard.mjs','release/launch-state.json','contracts/mint-policy.json','mainnet/owner/deployment.json','config.js'];");
replace('scripts/test-mint-policy-config.mjs',"const base=Object.fromEntries(files.map(p=>[p,fs.readFileSync(p,'utf8')]));", "const base=Object.fromEntries(files.map(p=>[p,fs.readFileSync(p,'utf8')]));\nbase['config.js']=base['config.js'].replace(/demoMode:\\s*(true|false)/,'demoMode: true');\nbase['release/launch-state.json']=JSON.stringify({...JSON.parse(base['release/launch-state.json']),phase:'hold',testnetVerified:false,privateStorageVerified:false,mainnetVerified:false,creatorNftVerified:false,publicMintApproved:false,automaticRevealArmed:false,evidence:{},packageSha256:null});");
fs.writeFileSync('.github/workflows/mainnet-client-check.yml', `name: Validate CoolBears mainnet clients
on:
  push:
    branches: [main]
    paths: ['mainnet/owner/**', 'mint-live.js', 'config.js', 'release-guard.mjs', 'release/**', 'scripts/**', '.github/workflows/mainnet-client-check.yml']
  workflow_dispatch:
permissions:
  contents: read
jobs:
  validate:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Syntax checks
        run: |
          node --check mainnet/owner/owner.js
          node --check mint-live.js
          node --check config.js
      - name: Validate package-bound release phase
        run: node scripts/validate-release-state.mjs
      - name: Validate mint policy and metadata references
        run: node scripts/validate-mint-policy.mjs
      - name: Test release permission boundaries
        run: node scripts/test-release-guard.mjs
      - name: Test wallet and creator-reserve logic offline
        run: node scripts/test-owner-launch.mjs
`);
replace('.github/workflows/activate-mainnet-site.yml','      - name: Install TON client', `      - name: Require an approved candidate before activation checks
        run: |
          node scripts/validate-release-state.mjs
          node --input-type=module -e "import fs from 'node:fs'; const s=JSON.parse(fs.readFileSync('release/launch-state.json')); if(s.phase!=='approved')throw Error('Release is not approved');"
      - name: Install TON client`);
replace('.github/workflows/activate-mainnet-site.yml',"          node --check config.js", `          node --input-type=module -e "import fs from 'node:fs'; const p='release/launch-state.json';const s=JSON.parse(fs.readFileSync(p));s.phase='live';fs.writeFileSync(p,JSON.stringify(s,null,2)+'\\n');"
          node scripts/validate-release-state.mjs
          node --check config.js`);
replace('.github/workflows/activate-mainnet-site.yml','git add config.js index.html','git add config.js index.html release/launch-state.json');
console.log('RELEASE_GUARDS_INSTALLED_NO_CHAIN_TRANSACTIONS');
