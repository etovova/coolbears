#!/usr/bin/env python3
"""Patch only collection description in a freshly downloaded PRIVATE CAR."""
import argparse, io, json, os, runpy
from pathlib import Path
H=runpy.run_path(str(Path(__file__).with_name('build-final-branding-local.py')))
R=runpy.run_path(str(Path(__file__).with_name('rebrand-final-car.py')))
var=R['var']
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
def patch_car(car):
    assert car.name in {'description-migration.car','CoolBears_v3_final.car'}
    proof=json.loads(Path('release/description-correction/preparation.json').read_text())
    assert car.stat().st_size==12779698835 and H['file_sha'](car)==proof['sourceCarSha256']
    index={}
    with car.open('rb') as f:
        hb=f.read(var(f));old_root=hb[13:49];assert hb==H['header'](old_root)
        while f.tell()<car.stat().st_size:
            start=f.tell();n=var(f);c=f.read(36);b=f.read(n-36)
            assert len(b)==n-36 and H['cid'](b,c[1])==c and c not in index
            index[c]=(start,f.tell(),len(b))
        def read(c):
            start,end,size=index[c];f.seek(end-size);return f.read(size)
        raw=read(old_root);links=[];data=[]
        for k,v in fields(raw):
            if k==1:data.append(v)
            elif k==2:
                d=dict(fields(v));assert set(d)=={1,2,3};links.append((d[2].decode(),d[1],d[3]))
            else:raise ValueError('BAD_ROOT')
        assert data==[H['pv'](1,1)] and [n for n,_,_ in links]==['collection.json','images','metadata']
        old_collection=links[0][1];cb=read(old_collection)
    col=json.loads(cb);approved=json.loads(Path('metadata/collection.json').read_text())
    col['description']=approved['description'];nb=H['jb'](col)
    assert {k for k in col if col[k]!=json.loads(cb)[k]}=={'description'}
    nc=H['cid'](nb,0x55);new_root,_,nr=H['directory']([('collection.json',nc,len(nb)),*links[1:]])
    assert index[old_collection][1]==index[old_root][0] and index[old_root][1]==car.stat().st_size
    assert index[old_collection][0]//(256*1024*1024)==47
    with car.open('r+b') as f:
        f.write(H['vu'](len(H['header'](new_root)))+H['header'](new_root))
        f.seek(index[old_collection][0])
        for c,b in [(nc,nb),(new_root,nr)]:f.write(H['vu'](len(c)+len(b))+c+b)
        f.truncate();f.flush();os.fsync(f.fileno())
    assert car.stat().st_size==proof['carBytes'] and H['file_sha'](car)==proof['carSha256']
    result={'status':'STORED_DESCRIPTION_PATCHED_EXACTLY','carSha256':proof['carSha256'],'carBytes':proof['carBytes'],'blocksVerified':len(index),'unchangedNfts':10000,'privateIdentifiersExposed':False}
    print(json.dumps(result))
    return result
if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--car',type=Path,required=True)
    patch_car(ap.parse_args().car)
