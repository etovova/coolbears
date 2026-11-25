"""Build the Worker entry module, embedding the small public pages and wallet SDK."""
import json
import sys
from pathlib import Path
base=Path(__file__).resolve().parent
public={name:(base/path).read_text() for name,path in {
    "home.html":"web/index.html","xaman.mjs":"web/xaman.mjs","app.js":"web/app.js","rarity.mjs":"web/rarity.mjs","site.css":"web/site.css",
    "wallet.js":"vendor/gemwallet.js","crossmark.js":"vendor/crossmark.js","translations.mjs":"web/translations.mjs","privacy.html":"web/privacy.html","terms.html":"web/terms.html"}.items()}
print("import {handle} from './worker.mjs';")
print("const pages="+json.dumps(public,ensure_ascii=False)+";")
print("""const brand='https://raw.githubusercontent.com/etovova/coolbears/4e6bb2764b02772da79dfe2752ca09d33889a114/assets/';
const originals={'cover.gif':'collection/gif.gif','logo.png':'collection/logo.png','hero.png':'brand/hero-20261003.png','gallery.png':'brand/gallery-20261003.png','brand-logo.png':'brand/logo-20261003.png'};
export default {fetch(request,env){
  const binding=env.ASSETS;
  const assets={async fetch(req){
    const name=new URL(req.url).pathname.slice('/internal/'.length);
    if(Object.hasOwn(pages,name))return new Response(pages[name]);
    if(binding && (!Object.hasOwn(originals,name) || name==='logo.png'||name==='cover.gif'))return binding.fetch(req);
    if(Object.hasOwn(originals,name))return fetch(brand+originals[name],{cf:{cacheTtl:86400,cacheEverything:true}});
    return new Response(null,{status:404});
  }};
  return handle(request,{...env,ASSETS:assets});
}};""")
