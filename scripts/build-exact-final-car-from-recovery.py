#!/usr/bin/env python3
"""Rebuild the exact corrected CoolBears release from the sealed v3 source recovery.

The sealed Pinata recovery is intentionally the older v3 source snapshot. We use only
its already verified 454 original PNG layers and metadata plan as input, apply the
frozen glasses correction deterministically, render all 10,000 images, pack the CAR,
and refuse success unless the corrected candidate/manifest/CAR hashes match exactly.
No network upload or wallet operation is performed here.
"""
from pathlib import Path
import collections, hashlib, io, json, os, shutil, subprocess, sys, zipfile

EXPECTED_PACKAGE_SHA='763ad4e4c4e7c230652a5b44d18ef175d1abed4d989cef7b0d0116fb3e7a684f'
EXPECTED_MANIFEST_SHA='4d6dd18bf5050a9244862997e4a51ae9ba2026e656279745e7d4fee05213ce96'
EXPECTED_CAR_SHA='287406498c91a1791880bef7919a58c61e55a7dfd884aeb57c22a8ab49115b84'
EXPECTED_CAR_BYTES=12779698835
REVISION='v3-glasses-correction-1'
EYES_MAP={'Crystal Glasses':'Gold Glasses','Gold Glasses':'Cyber Goggles','Cyber Goggles':'Crystal Glasses'}

def sha256_file(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for b in iter(lambda:f.read(8<<20),b''): h.update(b)
    return h.hexdigest()

def jbytes(o):
    return (json.dumps(o,ensure_ascii=False,indent=2)+'\n').encode()

def safe_extract(z,dest):
    for n in z.namelist():
        parts=Path(n).parts
        if n.startswith(('/', '\\')) or '..' in parts: raise ValueError('unsafe zip member')
    z.extractall(dest)

def packer_command(packer, rendered, release):
    text=packer.read_text(encoding='utf-8',errors='strict')
    for left,right in [('--input','--output'),('--source','--output'),('--input','--out'),('--source','--out')]:
        if left in text and right in text:
            return [sys.executable,str(packer),left,str(rendered),right,str(release)]
    raise ValueError('UNSUPPORTED_IPFS_PACKER_CLI')

def apply_correction(root):
    plan_path=root/'generation_plan.json'; rows=json.loads(plan_path.read_text())
    if len(rows)!=10000 or [r.get('token_id') for r in rows]!=list(range(10000)): raise ValueError('PLAN_SHAPE_MISMATCH')
    changed=[]
    for r in rows:
        old=r['attributes']['Eyes']
        if old in EYES_MAP:
            new=EYES_MAP[old]; r['attributes']['Eyes']=new; changed.append(r['token_id'])
            mp=root/'metadata'/f"{r['token_id']:04d}.json"; m=json.loads(mp.read_text())
            hits=0
            for a in m.get('attributes',[]):
                if a.get('trait_type')=='Eyes':
                    if a.get('value')!=old: raise ValueError('METADATA_EYES_OLD_VALUE_MISMATCH')
                    a['value']=new; hits+=1
            for f in m.get('properties',{}).get('trait_frequencies',[]):
                if f.get('trait_type')=='Eyes':
                    if f.get('value')!=old: raise ValueError('FREQUENCY_EYES_OLD_VALUE_MISMATCH')
                    f['value']=new; hits+=1
            if hits!=2: raise ValueError('METADATA_EYES_FIELDS_MISSING')
            mp.write_bytes(jbytes(m))
    if len(changed)!=200 or 0 not in changed: raise ValueError('CORRECTION_COUNT_MISMATCH')
    if rows[0]['attributes']['Eyes']!='Gold Glasses': raise ValueError('TOKEN_ZERO_NOT_GOLD_GLASSES')
    plan_path.write_bytes(jbytes(rows))
    cfgp=root/'generation_config.json'; cfg=json.loads(cfgp.read_text())
    freq=collections.Counter(r['attributes']['Eyes'] for r in rows)
    cfg.setdefault('fixed_counts',{})['Eyes']=dict(freq)
    cfg['revision']={'id':REVISION,'replaces':'v3','changed_images':200,'mapping':EYES_MAP}
    cfgp.write_bytes(jbytes(cfg))
    counts={k:freq[k] for k in ('Gold Glasses','Cyber Goggles','Crystal Glasses')}
    if counts!={'Gold Glasses':50,'Cyber Goggles':60,'Crystal Glasses':90}: raise ValueError('CORRECTED_EYES_COUNTS_MISMATCH')
    return changed

def main():
    restored=Path(os.environ['RUNNER_TEMP'])/'coolbears-verified-recovery'/'recovery.zip'
    if not restored.exists(): raise FileNotFoundError(restored)
    committed=Path('launch/candidate.json').read_bytes()
    if hashlib.sha256(committed).hexdigest()!=EXPECTED_PACKAGE_SHA: raise ValueError('CURRENT_CORRECTED_CANDIDATE_SHA_MISMATCH')
    cand=json.loads(committed)
    if cand.get('collectionRevision')!=REVISION or cand.get('releaseCarSha256')!=EXPECTED_CAR_SHA or cand.get('releaseManifestSha256')!=EXPECTED_MANIFEST_SHA: raise ValueError('CURRENT_CANDIDATE_BINDING_MISMATCH')
    work=Path(os.environ['RUNNER_TEMP'])/'coolbears-final-car-work'
    if work.exists(): shutil.rmtree(work)
    work.mkdir(parents=True)
    with zipfile.ZipFile(restored) as outer:
        orig_bytes=outer.read('original_private_recovery.zip')
        names=outer.namelist()
        if 'prepare_ipfs_release.py' in names: tool_names=['prepare_ipfs_release.py']
        else: tool_names=[n for n in names if n.startswith('tools/') and 'prepare_ipfs' in n and n.endswith('.py')]
        if len(tool_names)!=1: raise ValueError('EXACT_IPFS_PACKER_NOT_FOUND')
        packer=work/'prepare_ipfs_release.py'; packer.write_bytes(outer.read(tool_names[0]))
    with zipfile.ZipFile(io.BytesIO(orig_bytes)) as orig:
        source=work/'SourceLayers.zip'; source.write_bytes(orig.read('SourceLayers.zip'))
        v3zip=orig.read('V3_Metadata_and_Reports.zip')
    data=work/'data'; data.mkdir()
    with zipfile.ZipFile(io.BytesIO(v3zip)) as v3: safe_extract(v3,data)
    roots=[p.parent for p in data.rglob('generation_plan.json') if (p.parent/'build_collection_v3.py').exists()]
    if len(roots)!=1: raise ValueError('EXACT_RENDER_ROOT_NOT_FOUND')
    root=roots[0]; changed=apply_correction(root)
    rendered=work/'CoolBears_v3_rendered_verified.zip'; env=dict(os.environ); env['PYTHONHASHSEED']='0'
    subprocess.run([sys.executable,str(root/'build_collection_v3.py'),'--source',str(source),'--data',str(root),'--output',str(rendered),'--workers','4'],check=True,env=env)
    release=work/'release'; release.mkdir()
    subprocess.run(packer_command(packer,rendered,release),check=True,env=env)
    car=release/'CoolBears_v3_final.car'
    if not car.exists(): raise FileNotFoundError(car)
    car_sha=sha256_file(car)
    if car.stat().st_size!=EXPECTED_CAR_BYTES or car_sha!=EXPECTED_CAR_SHA: raise ValueError('CORRECTED_FINAL_CAR_MISMATCH')
    manifest=release/'manifest.PRIVATE.json'; mo=json.loads(manifest.read_text()); mo['revision']=REVISION; manifest.write_bytes(jbytes(mo))
    msha=hashlib.sha256(manifest.read_bytes()).hexdigest()
    if msha!=EXPECTED_MANIFEST_SHA: raise ValueError('CORRECTED_FINAL_MANIFEST_SHA_MISMATCH')
    summary={'schema':2,'status':'EXACT_CORRECTED_FINAL_CAR_REBUILT_AND_HASH_VERIFIED','collectionRevision':REVISION,'correctedNfts':len(changed),'packageSha256':EXPECTED_PACKAGE_SHA,'carSha256':car_sha,'carBytes':car.stat().st_size,'manifestSha256':msha,'uploadsPerformed':False,'walletOperations':False,'salesChanged':False}
    out=Path('build/private-final-car'); out.mkdir(parents=True,exist_ok=True)
    (out/'build-summary.json').write_text(json.dumps(summary,indent=2)+'\n'); (out/'car-path.txt').write_text(str(car)+'\n')
    print(json.dumps(summary))

if __name__=='__main__': main()
