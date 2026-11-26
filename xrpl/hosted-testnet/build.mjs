import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
// The test checkout and its Xaman adapter must go live together on the existing app.js route.
const browser=await build({entryPoints:['../web/app.js'],bundle:true,write:false,format:'esm',target:'es2022',
  external:['./rarity.mjs','./translations.mjs','/xrpl/walletconnect-sdk.mjs']});
const defaults={bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,outdir:'build',legalComments:'eof'};
await build({...defaults,entryPoints:['walletconnect-sdk.mjs'],outfile:'build/walletconnect-sdk.mjs',outdir:undefined,define:{'process.env.NODE_ENV':'"production"'},
  banner:{js:'/*! Portions © 2025 Reown, Inc. All Rights Reserved\n'+(await readFile('node_modules/@walletconnect/sign-client/LICENSE.md','utf8')).replaceAll('*/','* /')+'\n*/'}});
await build({...defaults,entryPoints:['issuer.mjs']});
await build({...defaults,entryPoints:['storefront.mjs'],plugins:[{
  name:'served-browser-module',setup(build) {
    build.onResolve({filter:/^\.\.\/web\/app\.js$/}, () => ({path:new URL('../web/app.js',import.meta.url).pathname,namespace:'text'}));
    build.onLoad({filter:/.*/,namespace:'text'}, () => ({contents:browser.outputFiles[0].text,loader:'text'}));
  }
}]});
