#!/usr/bin/env python3
"""Reproduce the approved description revision from the verified branded release."""
import json, os, runpy, zipfile
from pathlib import Path
H=runpy.run_path(str(Path(__file__).with_name('build-final-branding-local.py')))

def patch(release, metadata_only=False):
    proof=json.loads(Path('release/description-correction/preparation.json').read_text())
    mp=release/'manifest.PRIVATE.json';cp=release/'collection.json'
    mb=mp.read_bytes();assert H['sha'](mb)==proof['sourceManifestSha256']
    m=json.loads(mb);old=cp.read_bytes();col=json.loads(old)
    col['description']=json.loads(Path('metadata/collection.json').read_text())['description']
    assert {k for k in col if col[k]!=json.loads(old)[k]}=={'description'}
    cb=H['jb'](col);assert H['sha'](cb)==proof['collectionJsonSha256']
    archives=list(release.glob('*metadata_PRIVATE.zip'));assert len(archives)==1
    archive=archives[0];metas=[]
    with zipfile.ZipFile(archive) as z:
        assert z.read('collection.json')==old
        for r in m['records']:
            b=z.read('metadata/%04d.json'%r['id'])
            assert H['sha'](b)==r['metadataSha256'] and H['text'](H['cid'](b,0x55))==r['metadataCid']
            metas.append(b)
    assert len(metas)==10000
    ic,isz,_=H['directory']([('%04d.png'%r['id'],H['dec'](r['imageCid']),H['file_size'](r['imageBytes'])) for r in m['records']])
    mc,msz,_=H['directory']([('%04d.json'%r['id'],H['dec'](r['metadataCid']),len(b)) for r,b in zip(m['records'],metas)])
    oldroot,_,_=H['directory']([('collection.json',H['cid'](old,0x55),len(old)),('images',ic,isz),('metadata',mc,msz)])
    assert H['text'](oldroot)==m['bundleCid']
    root,_,_=H['directory']([('collection.json',H['cid'](cb,0x55),len(cb)),('images',ic,isz),('metadata',mc,msz)])
    new={**m,'bundleCid':H['text'](root),'collectionMetadataIpfs':'ipfs://'+H['text'](root)+'/collection.json','metadataRootIpfs':'ipfs://'+H['text'](root)+'/metadata/','descriptionRevision':'approved-description-1'}
    new_mb=H['jb'](new);assert H['sha'](new_mb)==proof['manifestSha256']
    if not metadata_only:
        runpy.run_path(str(Path(__file__).with_name('patch-stored-description.py')))['patch_car'](release/'CoolBears_v3_final.car')
    temporary=archive.with_suffix('.description.zip')
    with zipfile.ZipFile(temporary,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for r,b in zip(m['records'],metas):z.writestr('metadata/%04d.json'%r['id'],b)
        z.writestr('collection.json',cb);z.writestr('manifest.PRIVATE.json',new_mb)
    os.replace(temporary,archive);mp.write_bytes(new_mb);cp.write_bytes(cb)
    return {'carSha256':proof['carSha256'],'carBytes':proof['carBytes'],'manifestSha256':H['sha'](new_mb),'metadataOnly':metadata_only,'unchangedNfts':10000}
