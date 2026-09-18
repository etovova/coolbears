#!/usr/bin/env python3
"""Rebrand the exact privately restored CAR without rerendering any NFT.
Only the root header, collection JSON block and root directory block change.
Public candidate SHA/manifest/CAR bindings must be checked by the caller.
"""
import argparse, io, json, os, runpy
from pathlib import Path
H=runpy.run_path(str(Path(__file__).with_name('build-final-branding-local.py')))
R=runpy.run_path(str(Path(__file__).with_name('rebrand-final-car.py')))
var=R['var'];cid=H['cid'];text=H['text'];jb=H['jb'];vu=H['vu'];header=H['header']
def fields(b):
    f=io.BytesIO(b);out=[]
    while f.tell()<len(b):
        k=var(f);i,w=k>>3,k&7
        if w==0:v=var(f)
        elif w==2:
            n=var(f);v=f.read(n);assert len(v)==n
        else:raise ValueError('BAD_PROTOBUF')
        out.append((i,v))
    return out
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--car',type=Path,required=True);a=ap.parse_args()
    assert a.car.name=='branding-migration.car'
    assert a.car.stat().st_size==H['OLD_BYTES'] and H['file_sha'](a.car)==H['OLD_CAR']
    p=json.loads(Path('launch/candidate.json').read_text());assert p['finalBrandingRevision']==H['REVISION']
    index={}
    with a.car.open('rb') as f:
        hb=f.read(var(f));assert len(hb)==len(header(bytes(36)));old_root=hb[13:49];assert hb==header(old_root)
        while f.tell()<a.car.stat().st_size:
            n=var(f);offset=f.tell();c=f.read(36);b=f.read(n-36);assert cid(b,c[1])==c and c not in index
            index[c]=(offset,len(b))
        def read(c):
            offset,size=index[c];f.seek(offset+36);return f.read(size)
        raw=read(old_root);links=[];data=[]
        for k,v in fields(raw):
            if k==1:data.append(v)
            elif k==2:
                d=dict(fields(v));assert set(d)=={1,2,3};links.append((d[2].decode(),d[1],d[3]))
            else:raise ValueError('BAD_ROOT')
        assert data==[H['pv'](1,1)] and [n for n,_,_ in links]==['collection.json','images','metadata']
        old_collection=links[0][1];cb=read(old_collection);assert H['sha'](cb)=='cb633c941a4515aaf9446e694726b1a5552cf5986ada22caeeecf9581aa11d79'
    col=json.loads(cb);assets=json.loads(Path('release/prereveal-assets.json').read_text())
    for key in ('logo','banner'):
        b=Path(assets[key]['source']).read_bytes();assert H['sha'](b)==assets[key]['sha256'] and text(cid(b,0x55))==assets[key]['cid']
    col['image']='ipfs://'+assets['logo']['cid'];col['cover_image']='ipfs://'+assets['banner']['cid'];nb=jb(col);assert len(nb)==len(cb)
    new_collection=cid(nb,0x55);new_links=[('collection.json',new_collection,len(nb)),*links[1:]]
    new_root,_,nr=H['directory'](new_links);assert len(nr)==len(raw)
    assert index[old_collection][0]//(256*1024*1024)==47 and index[old_root][0]//(256*1024*1024)==47
    with a.car.open('r+b') as f:
        f.write(vu(len(header(new_root)))+header(new_root))
        for old,new,b in [(old_collection,new_collection,nb),(old_root,new_root,nr)]:f.seek(index[old][0]);f.write(new+b)
        f.flush();os.fsync(f.fileno())
    assert H['file_sha'](a.car)==p['releaseCarSha256'],'NEW_CAR_DIFFERS_FROM_LOCAL_VERIFIED_RELEASE'
    print(json.dumps({'status':'STORED_CAR_REBRANDED_EXACTLY','sourceCarSha256':H['OLD_CAR'],'carSha256':p['releaseCarSha256'],'carBytes':a.car.stat().st_size,'sourceBlocksVerified':len(index),'changedPartNumbers':[1,48],'unchangedNfts':10000,'privateIdentifiersExposed':False}))
if __name__=='__main__':main()
