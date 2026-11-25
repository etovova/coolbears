import {build} from 'esbuild';
const defaults={bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,outdir:'build',legalComments:'eof'};
await build({...defaults,entryPoints:['issuer.mjs']});
await build({...defaults,entryPoints:['storefront.mjs'],plugins:[{
  name:'served-browser-module',setup(build) {
    build.onResolve({filter:/^\.\.\/web\/app\.js$/}, () => ({path:new URL('../web/app.js',import.meta.url).pathname,namespace:'text'}));
    build.onLoad({filter:/.*/,namespace:'text'}, async args => ({contents:await (await import('node:fs/promises')).readFile(args.path,'utf8'),loader:'text'}));
  }
}]});
