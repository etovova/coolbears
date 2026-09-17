#!/usr/bin/env python3
"""Inspect executable tooling names in the CURRENT sealed recovery without exposing traits/CIDs/images."""
from pathlib import Path
import io, json, os, zipfile

base=Path(os.environ['RUNNER_TEMP'])/'coolbears-verified-recovery'
recovery=base/'recovery.zip'
if not recovery.exists(): raise FileNotFoundError(recovery)

def candidates(names, prefix):
    out=[]
    for n in names:
        low=n.lower()
        if n.endswith('/'):
            continue
        if low.endswith(('.py','.mjs','.js','.sh','.json')) and any(k in low for k in ('ipfs','car','package','release','render','build','correct','fix','verify')):
            out.append(prefix+n)
    return sorted(out)

result={'schema':1,'status':'CURRENT_RECOVERY_TOOLING_INSPECTED','outerCandidates':[],'originalCandidates':[],'v3Candidates':[],'outerFileCount':0,'originalFileCount':0,'v3FileCount':0,'traitsExposed':False,'cidsExposed':False,'imagesExposed':False,'walletOperations':False,'uploadsPerformed':False}
with zipfile.ZipFile(recovery) as outer:
    on=[n for n in outer.namelist() if not n.endswith('/')]
    result['outerFileCount']=len(on)
    result['outerCandidates']=candidates(outer.namelist(),'outer:')
    if 'original_private_recovery.zip' in outer.namelist():
        with zipfile.ZipFile(io.BytesIO(outer.read('original_private_recovery.zip'))) as orig:
            orn=[n for n in orig.namelist() if not n.endswith('/')]
            result['originalFileCount']=len(orn)
            result['originalCandidates']=candidates(orig.namelist(),'original:')
            if 'V3_Metadata_and_Reports.zip' in orig.namelist():
                with zipfile.ZipFile(io.BytesIO(orig.read('V3_Metadata_and_Reports.zip'))) as v3:
                    vn=[n for n in v3.namelist() if not n.endswith('/')]
                    result['v3FileCount']=len(vn)
                    result['v3Candidates']=candidates(v3.namelist(),'v3:')
out=Path('build/current-recovery-tooling');out.mkdir(parents=True,exist_ok=True)
(out/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
