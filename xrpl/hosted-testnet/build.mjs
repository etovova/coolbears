import {build} from 'esbuild';
// The test checkout and its Xaman adapter must go live together on the existing app.js route.
const browser=await build({entryPoints:['../web/app.js'],bundle:true,write:false,format:'esm',target:'es2022',
  external:['./rarity.mjs','./translations.mjs']});
const defaults={bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,outdir:'build',legalComments:'eof'};
await build({...defaults,entryPoints:['issuer.mjs']});
await build({...defaults,entryPoints:['storefront.mjs'],plugins:[{
  name:'served-browser-module',setup(build) {
    build.onResolve({filter:/^\.\.\/web\/app\.js$/}, () => ({path:new URL('../web/app.js',import.meta.url).pathname,namespace:'text'}));
    build.onLoad({filter:/.*/,namespace:'text'}, () => ({contents:browser.outputFiles[0].text,loader:'text'}));
  }
}]});
