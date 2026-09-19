// Node-only operator store. Keep this directory private and outside public assets.
import { mkdir, readFile, open, rename, unlink, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export function fileUploadStore(directory) {
  const root=resolve(directory);
  const filename=key=>join(root,createHash('sha256').update(key).digest('hex'));
  return {
    async read(key) {
      try { return JSON.parse(await readFile(filename(key)+'.json','utf8')); }
      catch(e) { if(e.code==='ENOENT')return null; throw e; }
    },
    async write(key,value) {
      await mkdir(root,{recursive:true,mode:0o700});
      const path=filename(key)+'.json', temp=path+'.'+randomUUID()+'.tmp';
      let handle;
      try {
        handle=await open(temp,'wx',0o600);
        await handle.writeFile(JSON.stringify(value,null,2));
        await handle.sync(); await handle.close(); handle=null;
        await rename(temp,path);
        const dir=await open(root,'r');
        try { await dir.sync(); } finally { await dir.close(); }
      } finally { if(handle)await handle.close(); await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;}); }
    },
    async withLock(key,fn) {
      await mkdir(root,{recursive:true,mode:0o700});
      const lock=filename(key)+'.lock';
      try { await mkdir(lock,{mode:0o700}); }
      catch(e) { if(e.code==='EEXIST')throw Error('Upload already locked. After a crash, verify no uploader is running before removing the stale lock directory.'); throw e; }
      try { return await fn(); } finally { await rmdir(lock); }
    }
  };
}
