#!/usr/bin/env python3
"""Patch only approved collection branding in a freshly rebuilt, exact old CAR.

Never uploads. Requires the old complete CAR SHA before modifying the generated
file. Its size and offsets stay identical; only header/root/collection blocks
change. All original image and item-metadata blocks remain byte-identical.
"""
import argparse, hashlib, io, json, os, runpy, zipfile
from pathlib import Path

H=runpy.run_path(str(Path(__file__).with_name('build-final-branding-local.py')))
sha,jb,cid,dec,text,directory,header,vu,file_size=[H[k] for k in ('sha','jb','cid','dec','text','directory','header','vu','file_size')]

def var(f):
    n=s=0
    for _ in range(10):
        b=f.read(1)
        if not b:raise EOFError()
        n|=(b[0]&127)<<s
        if b[0]<128:return n
        s+=7
    raise ValueError('OVERLONG_VARINT')

def patch(release):
    car=release/'CoolBears_v3_final.car';mp=release/'manifest.PRIVATE.json';cp=release/'collection.json'
    assert car.stat().st_size==H['OLD_BYTES'] and H['file_sha'](car)==H['OLD_CAR'],'SOURCE_CAR_MISMATCH'
    mb=mp.read_bytes();assert sha(mb)==H['OLD_MANIFEST'];m=json.loads(mb)
    old_cb=cp.read_bytes();col=json.loads(old_cb)
    assets=json.loads(Path('release/prereveal-assets.json').read_text())
    for key in ('logo','banner'):
        b=Path(assets[key]['source']).read_bytes()
        assert sha(b)==assets[key]['sha256'] and text(cid(b,0x55))==assets[key]['cid']
    col['image']='ipfs://'+assets['logo']['cid'];col['cover_image']='ipfs://'+assets['banner']['cid'];new_cb=jb(col)
    assert len(old_cb)==len(new_cb) and {k for k in col if col[k]!=json.loads(old_cb)[k]}=={'image','cover_image'}
    candidates=[p for p in release.glob('*metadata_PRIVATE.zip')]
    assert len(candidates)==1,'EXACT_METADATA_ARCHIVE_REQUIRED'
    meta_zip=candidates[0];metas=[]
    with zipfile.ZipFile(meta_zip) as z:
        assert z.read('collection.json')==old_cb
        for r in m['records']:
            b=z.read('metadata/%04d.json'%r['id']);assert sha(b)==r['metadataSha256'] and text(cid(b,0x55))==r['metadataCid'];metas.append(b)
    assert len(metas)==10000
    ic,isz,_=directory([('%04d.png'%r['id'],dec(r['imageCid']),file_size(r['imageBytes'])) for r in m['records']])
    mc,msz,_=directory([('%04d.json'%r['id'],dec(r['metadataCid']),len(b)) for r,b in zip(m['records'],metas)])
    old_root,_,old_raw=directory([('collection.json',cid(old_cb,0x55),len(old_cb)),('images',ic,isz),('metadata',mc,msz)])
    new_root,_,new_raw=directory([('collection.json',cid(new_cb,0x55),len(new_cb)),('images',ic,isz),('metadata',mc,msz)])
    assert text(old_root)==m['bundleCid'] and len(old_raw)==len(new_raw)
    replacements={cid(old_cb,0x55):(cid(new_cb,0x55),new_cb),old_root:(new_root,new_raw)}
    offsets=[];blocks=0
    with car.open('rb') as f:
        assert f.read(var(f))==header(old_root)
        while f.tell()<car.stat().st_size:
            size=var(f);offset=f.tell();c=f.read(36);b=f.read(size-36)
            assert size>=36 and len(b)==size-36 and cid(b,c[1])==c
            if c in replacements:
                nc,nb=replacements[c];assert len(nb)==len(b);offsets.append((offset,nc+nb))
            blocks+=1
    assert len(offsets)==2 and all(offset//(256*1024*1024)==47 for offset,_ in offsets)
    with car.open('r+b') as f:
        f.write(vu(len(header(new_root)))+header(new_root))
        for offset,b in offsets:f.seek(offset);f.write(b)
        f.flush();os.fsync(f.fileno())
    new_m={**m,'bundleCid':text(new_root),'collectionMetadataIpfs':'ipfs://'+text(new_root)+'/collection.json','metadataRootIpfs':'ipfs://'+text(new_root)+'/metadata/','brandingRevision':H['REVISION']}
    new_mb=jb(new_m);mp.write_bytes(new_mb);cp.write_bytes(new_cb)
    temporary=meta_zip.with_suffix('.branding.zip')
    with zipfile.ZipFile(temporary,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for r,b in zip(m['records'],metas):z.writestr('metadata/%04d.json'%r['id'],b)
        z.writestr('collection.json',new_cb);z.writestr('manifest.PRIVATE.json',new_mb)
    os.replace(temporary,meta_zip)
    with car.open('rb') as f:
        assert f.read(var(f))==header(new_root)
        for offset,b in offsets:f.seek(offset);assert f.read(len(b))==b
    result={'schema':1,'status':'FINAL_BRANDING_PATCHED_AND_VERIFIED','brandingRevision':H['REVISION'],'sourceCarSha256':H['OLD_CAR'],'sourceManifestSha256':H['OLD_MANIFEST'],'carSha256':H['file_sha'](car),'carBytes':car.stat().st_size,'manifestSha256':sha(new_mb),'collectionJsonSha256':sha(new_cb),'unchangedPngFiles':10000,'unchangedMetadataFiles':10000,'sourceCarBlocksVerified':blocks,'changedPartNumbers':[1,48],'unchangedMiddleParts':46,'uploadsPerformed':False,'transactionsSent':0}
    (release/'branding-proof.json').write_bytes(jb(result));print(json.dumps(result),flush=True)
    return result

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--release',type=Path,required=True)
    patch(parser.parse_args().release)
