#!/usr/bin/env python3
"""Offline-only branding rebuild from the verified corrected private recovery.

Streams the unchanged images into a new CAR and simultaneously reproduces the
previous CAR hash. Only collection.image/cover_image and the root change.
No final CIDs, traits, keys or reveal preimages are printed.
"""
import argparse, base64, collections, hashlib, io, json, multiprocessing as mp
import os, time, zipfile
from pathlib import Path
from PIL import Image

RECOVERY_SHA = 'f4379bad3240e4f7778585be13c075ab537b117119c4866b414912532a388dd7'
OLD_MANIFEST = '4d6dd18bf5050a9244862997e4a51ae9ba2026e656279745e7d4fee05213ce96'
OLD_CAR = '287406498c91a1791880bef7919a58c61e55a7dfd884aeb57c22a8ab49115b84'
OLD_BYTES = 12779698835
REVISION = 'final-collection-branding-1'
CHUNK = 262144
ORDER = ('Background','Body','Clothes','Mouth','Eyes','Head','Ears')
CACHE = {}

def sha(b): return hashlib.sha256(b).hexdigest()
def file_sha(p):
    with open(p,'rb') as f: return hashlib.file_digest(f,'sha256').hexdigest()
def jb(o): return (json.dumps(o,ensure_ascii=False,indent=2)+'\n').encode()
def vu(n):
    b=bytearray()
    while n>127: b.append((n&127)|128);n>>=7
    b.append(n);return bytes(b)
def pv(i,n): return vu(i<<3)+vu(n)
def pb(i,b): return vu((i<<3)|2)+vu(len(b))+b
def cid(b,codec): return b'\x01'+vu(codec)+b'\x12\x20'+hashlib.sha256(b).digest()
def text(c): return 'b'+base64.b32encode(c).decode().lower().rstrip('=')
def dec(c): return base64.b32decode(c[1:].upper()+'='*((8-(len(c)-1)%8)%8))
def node(data,links):
    return b''.join(pb(2,pb(1,c)+pb(2,n.encode())+pv(3,s)) for n,c,s in links)+pb(1,data)
def directory(entries):
    b=node(pv(1,1),sorted(entries,key=lambda e:e[0].encode()))
    return cid(b,0x70),len(b)+sum(e[2] for e in entries),b
def header(root): return b'\xa2\x65roots\x81\xd8\x2a\x58\x25\x00'+root+b'\x67version\x01'
def file_size(n):
    if n<=CHUNK: return n
    sizes=[min(CHUNK,n-i) for i in range(0,n,CHUNK)]
    return n+len(node(pv(1,2)+pv(3,n)+b''.join(pv(4,s) for s in sizes),[('',bytes(36),s) for s in sizes]))
def norm(s): return ''.join(c for c in s.lower() if c.isalnum())

class Car:
    def __init__(self,path,new_root,old_root):
        self.f=open(path,'xb');self.seen=set();self.old=hashlib.sha256();self.new=hashlib.sha256()
        self.offsets=[];self.write(vu(len(header(new_root)))+header(new_root),vu(len(header(old_root)))+header(old_root))
    def write(self,b,old=None):
        self.f.write(b);self.new.update(b);self.old.update(b if old is None else old)
    def block(self,b,codec,old=None):
        c=cid(b,codec)
        if c not in self.seen:
            encoded=vu(len(c)+len(b))+c+b
            ob=b if old is None else old;oc=cid(ob,codec)
            original=vu(len(oc)+len(ob))+oc+ob
            assert len(original)==len(encoded),'Branding must preserve CAR offsets'
            self.offsets.append((self.f.tell()+len(vu(len(c)+len(b))),c,len(b)))
            self.write(encoded,original);self.seen.add(c)
        return c,len(b)
    def file(self,b):
        leaves=[self.block(b[i:i+CHUNK],0x55) for i in range(0,len(b),CHUNK)] or [self.block(b'',0x55)]
        if len(leaves)==1:return leaves[0]
        raw=node(pv(1,2)+pv(3,len(b))+b''.join(pv(4,n) for c,n in leaves),[('',c,n) for c,n in leaves])
        c,n=self.block(raw,0x70);return c,n+sum(x[1] for x in leaves)
    def finish(self):
        self.f.flush();os.fsync(self.f.fileno());self.f.close()

def load_layers(source):
    with zipfile.ZipFile(io.BytesIO(source)) as z:
        names=[n for n in z.namelist() if '/CoolBears Files/' in n and n.lower().endswith('.png')]
        assert len(names)==454
        for name in names:
            parts=Path(name.split('/CoolBears Files/',1)[1]).parts
            cat,value=parts[0],Path(parts[-1]).stem.strip()
            assert cat in ORDER and len(parts) in (2,3)
            with Image.open(io.BytesIO(z.read(name))) as im:
                im.load();assert im.size==(2000,2000) and im.format=='PNG';im=im.convert('RGBA')
            key=(cat,norm(parts[1]),value) if cat=='Mouth' else (cat,value)
            assert key not in CACHE
            box=im.getchannel('A').getbbox();CACHE[key]=(box,im.crop(box) if box else None)
    print('SOURCE_LAYERS_VERIFIED 454',flush=True)

def render(task):
    index,attrs=task;im=CACHE[('Background',attrs['Background'])][1].copy()
    for cat in ORDER[1:]:
        key=(cat,norm(attrs['Body']),attrs[cat]) if cat=='Mouth' else (cat,attrs[cat])
        box,tile=CACHE[key]
        if tile is not None:im.alpha_composite(tile,dest=(box[0],box[1]))
    im=im.convert('RGB');pixels=im.tobytes();out=io.BytesIO();im.save(out,format='PNG',compress_level=1);data=out.getvalue()
    with Image.open(io.BytesIO(data)) as test:
        test.load();assert test.size==(2000,2000) and test.mode=='RGB' and test.tobytes()==pixels
    return index,data,sha(pixels)

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--recovery',type=Path,required=True);ap.add_argument('--output',type=Path,required=True);ap.add_argument('--workers',type=int,default=6);a=ap.parse_args()
    assert file_sha(a.recovery)==RECOVERY_SHA
    assert not a.output.exists(),'Refusing to overwrite a previous build'
    a.output.mkdir(parents=True,mode=0o700)
    assets=json.loads(Path('release/prereveal-assets.json').read_text())
    for k in ('logo','banner'):
        b=Path(assets[k]['source']).read_bytes();assert sha(b)==assets[k]['sha256'] and text(cid(b,0x55))==assets[k]['cid']
    with zipfile.ZipFile(a.recovery) as z:
        final=z.read('final_metadata_PRIVATE.zip')
        with zipfile.ZipFile(io.BytesIO(z.read('original_private_recovery.zip'))) as original:source=original.read('SourceLayers.zip')
    with zipfile.ZipFile(io.BytesIO(final)) as z:
        mb=z.read('manifest.PRIVATE.json');assert sha(mb)==OLD_MANIFEST;m=json.loads(mb)
        old_cb=z.read('collection.json');col=json.loads(old_cb);col['image']='ipfs://'+assets['logo']['cid'];col['cover_image']='ipfs://'+assets['banner']['cid'];new_cb=jb(col)
        assert len(old_cb)==len(new_cb)
        assert {k for k in col if col[k]!=json.loads(old_cb)[k]}=={'image','cover_image'}
        records=m['records'];assert len(records)==10000 and [r['id'] for r in records]==list(range(10000))
        metas=[];tasks=[]
        for r in records:
            b=z.read('metadata/%04d.json'%r['id']);meta=json.loads(b)
            assert sha(b)==r['metadataSha256'] and text(cid(b,0x55))==r['metadataCid'] and len(b)<=CHUNK
            assert meta['image']=='ipfs://'+r['imageCid'];metas.append(b)
            tasks.append((r['id'],{t['trait_type']:t['value'] for t in meta['attributes']}))
    ic,isz,iraw=directory([('%04d.png'%r['id'],dec(r['imageCid']),file_size(r['imageBytes'])) for r in records])
    mc,msz,mraw=directory([('%04d.json'%r['id'],dec(r['metadataCid']),len(b)) for r,b in zip(records,metas)])
    oldroot,_,oldraw=directory([('collection.json',cid(old_cb,0x55),len(old_cb)),('images',ic,isz),('metadata',mc,msz)])
    newroot,_,newraw=directory([('collection.json',cid(new_cb,0x55),len(new_cb)),('images',ic,isz),('metadata',mc,msz)])
    assert text(oldroot)==m['bundleCid']
    new_m={**m,'bundleCid':text(newroot),'collectionMetadataIpfs':'ipfs://'+text(newroot)+'/collection.json','metadataRootIpfs':'ipfs://'+text(newroot)+'/metadata/','brandingRevision':REVISION}
    new_mb=jb(new_m);(a.output/'manifest.PRIVATE.json').write_bytes(new_mb);(a.output/'collection.json').write_bytes(new_cb)
    with zipfile.ZipFile(a.output/'final_metadata_PRIVATE.zip','x',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for r,b in zip(records,metas):z.writestr('metadata/%04d.json'%r['id'],b)
        z.writestr('collection.json',new_cb);z.writestr('manifest.PRIVATE.json',new_mb)
    load_layers(source);del source
    car_path=a.output/'CoolBears_v3_final.car';car=Car(car_path,newroot,oldroot);start=time.monotonic()
    with mp.get_context('fork').Pool(a.workers) as pool:
        for index,b,pixel in pool.imap(render,tasks,chunksize=1):
            r=records[index]
            assert sha(b)==r['pngSha256'] and pixel==r['pixelSha256'] and len(b)==r['imageBytes'],'NFT bytes changed'
            c,n=car.file(b);assert text(c)==r['imageCid'] and n==file_size(len(b))
            c,n=car.file(metas[index]);assert text(c)==r['metadataCid']
            if (index+1)%200==0:print('UNCHANGED_NFT_VERIFIED',index+1,'/10000',round(time.monotonic()-start,1),'s',flush=True)
    car.block(iraw,0x70);car.block(mraw,0x70);car.block(new_cb,0x55,old_cb);car.block(newraw,0x70,oldraw);car.finish()
    assert car.old.hexdigest()==OLD_CAR and car_path.stat().st_size==OLD_BYTES,'Original CAR not exactly reproduced'
    new_sha=car.new.hexdigest();assert file_sha(car_path)==new_sha
    # Independently reread every block from disk, including its CID and payload.
    with car_path.open('rb') as f:
        assert f.read(len(vu(len(header(newroot)))+header(newroot)))==vu(len(header(newroot)))+header(newroot)
        for offset,c,size in car.offsets:
            f.seek(offset);assert f.read(36)==c;b=f.read(size);assert len(b)==size and cid(b,c[1])==c
    summary={'schema':1,'status':'FINAL_BRANDING_REBUILT_OFFLINE','brandingRevision':REVISION,'sourceRecoverySha256':RECOVERY_SHA,'sourceManifestSha256':OLD_MANIFEST,'sourceCarSha256':OLD_CAR,'previousCarExactlyReproduced':True,'manifestSha256':sha(new_mb),'carSha256':new_sha,'carBytes':car_path.stat().st_size,'collectionJsonSha256':sha(new_cb),'unchangedPngFiles':10000,'unchangedMetadataFiles':10000,'allPngDecoded':True,'allCarBlocksVerified':len(car.offsets),'approvedLogoSha256':assets['logo']['sha256'],'approvedBannerSha256':assets['banner']['sha256'],'transactionsSent':0,'uploadsPerformed':False,'elapsedSeconds':round(time.monotonic()-start,2)}
    (a.output/'branding-proof.json').write_bytes(jb(summary));print(json.dumps(summary),flush=True)

if __name__=='__main__':main()
