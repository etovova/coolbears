#!/usr/bin/env python3
"""Restore the exact current CoolBears v3 CAR from the sealed private recovery.

This script never uploads anything. It extracts the already verified private recovery,
uses the embedded renderer and embedded IPFS packer, then refuses to continue unless
both the candidate package bytes and final CAR SHA-256 match the committed release.
"""
from pathlib import Path
import hashlib, io, json, os, shutil, subprocess, sys, zipfile

EXPECTED_PACKAGE_SHA='10aff272f0be8b315f7c280539ed49483c7bdf2f7a545863064d29fffcb008fa'
EXPECTED_CAR_SHA='3d6377484e3d27361c367be7b002a065d83426342df30f25e1d681b4d50f820c'

def sha256_file(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for b in iter(lambda:f.read(8<<20),b''): h.update(b)
    return h.hexdigest()

def safe_extract(z,dest):
    for n in z.namelist():
        parts=Path(n).parts
        if n.startswith(('/', '\\')) or '..' in parts: raise ValueError('unsafe zip member')
    z.extractall(dest)

def main():
    restored=Path(os.environ['RUNNER_TEMP'])/'coolbears-verified-recovery'/'recovery.zip'
    if not restored.exists(): raise FileNotFoundError(restored)
    work=Path(os.environ['RUNNER_TEMP'])/'coolbears-final-car-work'
    if work.exists(): shutil.rmtree(work)
    work.mkdir(parents=True)
    with zipfile.ZipFile(restored) as outer:
        candidate=outer.read('unsigned-packages/mainnet.candidate.json')
        if hashlib.sha256(candidate).hexdigest()!=EXPECTED_PACKAGE_SHA: raise ValueError('RECOVERY_PACKAGE_SHA_MISMATCH')
        committed=Path('launch/candidate.json').read_bytes()
        if candidate!=committed: raise ValueError('RECOVERY_CANDIDATE_BYTES_DIFFER_FROM_COMMITTED')
        orig_bytes=outer.read('original_private_recovery.zip')
        tool_names=[n for n in outer.namelist() if n.startswith('tools/') and 'prepare_ipfs' in n and n.endswith('.py')]
        if len(tool_names)!=1: raise ValueError('EXACT_IPFS_PACKER_NOT_FOUND')
        packer=work/'prepare_ipfs_release.py'; packer.write_bytes(outer.read(tool_names[0]))
    with zipfile.ZipFile(io.BytesIO(orig_bytes)) as orig:
        source=work/'SourceLayers.zip'; source.write_bytes(orig.read('SourceLayers.zip'))
        v3zip=orig.read('V3_Metadata_and_Reports.zip')
    data=work/'data'; data.mkdir()
    with zipfile.ZipFile(io.BytesIO(v3zip)) as v3: safe_extract(v3,data)
    roots=[p.parent for p in data.rglob('generation_plan.json') if (p.parent/'build_collection_v3.py').exists()]
    if len(roots)!=1: raise ValueError('EXACT_RENDER_ROOT_NOT_FOUND')
    root=roots[0]
    rendered=work/'CoolBears_v3_rendered_verified.zip'
    env=dict(os.environ); env['PYTHONHASHSEED']='0'
    subprocess.run([sys.executable,str(root/'build_collection_v3.py'),'--source',str(source),'--data',str(root),'--output',str(rendered),'--workers','4'],check=True,env=env)
    release=work/'release'; release.mkdir()
    subprocess.run([sys.executable,str(packer),'--input',str(rendered),'--output',str(release)],check=True,env=env)
    car=release/'CoolBears_v3_final.car'
    if not car.exists(): raise FileNotFoundError(car)
    car_sha=sha256_file(car)
    cand=json.loads(committed)
    if cand.get('releaseCarSha256')!=EXPECTED_CAR_SHA or car_sha!=EXPECTED_CAR_SHA:
        raise ValueError('FINAL_CAR_SHA_MISMATCH')
    manifest=release/'manifest.PRIVATE.json'
    msha=hashlib.sha256(manifest.read_bytes()).hexdigest()
    if msha!=cand.get('releaseManifestSha256'): raise ValueError('FINAL_MANIFEST_SHA_MISMATCH')
    summary={'schema':1,'status':'EXACT_FINAL_CAR_REBUILT_AND_HASH_VERIFIED','packageSha256':EXPECTED_PACKAGE_SHA,'carSha256':car_sha,'carBytes':car.stat().st_size,'manifestSha256':msha,'uploadsPerformed':False,'walletOperations':False,'salesChanged':False}
    out=Path('build/private-final-car'); out.mkdir(parents=True,exist_ok=True)
    (out/'build-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
    (out/'car-path.txt').write_text(str(car)+'\n')
    print(json.dumps(summary))

if __name__=='__main__': main()
