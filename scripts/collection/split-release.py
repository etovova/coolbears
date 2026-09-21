#!/usr/bin/env python3
"""Create independently verifiable ZIP parts for the private collection CAR."""
import argparse, hashlib, json, zipfile
from pathlib import Path
p = argparse.ArgumentParser();p.add_argument('source');p.add_argument('output');p.add_argument('--part-size',type=int,default=480000000)
a=p.parse_args();out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
manifest={'file':'collection.car','bytes':0,'sha256':None,'parts':[]};total=hashlib.sha256()
with Path(a.source).open('rb') as source:
    index=1
    while data:=source.read(a.part_size):
        name=f'CoolBears_Core_v2_PRIVATE.part{index:03d}.zip';member=f'collection.car.part{index:03d}'
        with zipfile.ZipFile(out/name,'w',compression=zipfile.ZIP_STORED) as archive:
            info=zipfile.ZipInfo(member,date_time=(2026,9,21,0,0,0));archive.writestr(info,data)
        manifest['parts'].append({'file':name,'member':member,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
        manifest['bytes']+=len(data);total.update(data);index+=1
        print(f'Saved part {index-1}',flush=True)
manifest['sha256']=total.hexdigest()
(out/'CoolBears_Core_v2_Backup_Manifest_PRIVATE.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'parts':len(manifest['parts']),'bytes':manifest['bytes'],'sha256':manifest['sha256']}))
