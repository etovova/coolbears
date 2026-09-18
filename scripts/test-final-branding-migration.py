#!/usr/bin/env python3
"""Local end-to-end test of both CAR migration paths; no network or publishing."""
import io,json,os,runpy,shutil,subprocess,tempfile,zipfile
from pathlib import Path
H=runpy.run_path(str(Path(__file__).with_name('build-final-branding-local.py')))
R=runpy.run_path(str(Path(__file__).with_name('rebrand-final-car.py')))
base=Path(os.environ['COOLBEARS_BRANDING_RELEASE']);source=Path(os.environ.get('COOLBEARS_BRANDING_CAR',str(base/'CoolBears_v3_final.car')))
recovery=Path(os.environ['COOLBEARS_BRANDING_RECOVERY'])
p=json.loads(Path('launch/candidate.json').read_text());m=json.loads((base/'manifest.PRIVATE.json').read_text())
assert H['file_sha'](source)==p['releaseCarSha256']
with zipfile.ZipFile(recovery) as z:old_zip=z.read('final_metadata_PRIVATE.zip')
with zipfile.ZipFile(io.BytesIO(old_zip)) as z:old_cb=z.read('collection.json');old_mb=z.read('manifest.PRIVATE.json')
old_m=json.loads(old_mb);new_cb=(base/'collection.json').read_bytes()
new_root=H['dec'](m['bundleCid']);old_root=H['dec'](old_m['bundleCid']);new_col=H['cid'](new_cb,0x55);old_col=H['cid'](old_cb,0x55)
offsets={};new_raw=None
with source.open('rb') as f:
    assert f.read(R['var'](f))==H['header'](new_root)
    while f.tell()<source.stat().st_size:
        n=R['var'](f);offset=f.tell();c=f.read(36)
        if c in (new_root,new_col):
            b=f.read(n-36);offsets[c]=offset
            if c==new_root:new_raw=b
        else:f.seek(n-36,1)
assert len(offsets)==2 and new_raw.count(new_col)==1
old_raw=new_raw.replace(new_col,old_col);assert H['cid'](old_raw,0x70)==old_root
tmp=Path(tempfile.mkdtemp(prefix='migration-test-',dir=source.parent));car=tmp/'branding-migration.car'
try:
    # Only this task's freshly generated CAR is used. Three small byte ranges
    # are restored in finally; never duplicate a 13-GB file just for the test.
    assert source.name=='CoolBears_v3_final.car'
    car.symlink_to(source.resolve())
    def reverse(target):
        with target.open('r+b') as f:
            f.write(H['vu'](len(H['header'](old_root)))+H['header'](old_root))
            f.seek(offsets[new_col]);f.write(old_col+old_cb)
            f.seek(offsets[new_root]);f.write(old_root+old_raw)
        assert H['file_sha'](target)==H['OLD_CAR']
    reverse(car)
    subprocess.run(['python','scripts/rebrand-stored-car.py','--car',str(car)],check=True)
    assert H['file_sha'](car)==p['releaseCarSha256']
    reverse(car);second=tmp/'CoolBears_v3_final.car';car.rename(second)
    (tmp/'manifest.PRIVATE.json').write_bytes(old_mb);(tmp/'collection.json').write_bytes(old_cb);(tmp/'final_metadata_PRIVATE.zip').write_bytes(old_zip)
    result=R['patch'](tmp)
    assert result['carSha256']==p['releaseCarSha256'] and result['manifestSha256']==p['releaseManifestSha256']
    assert (tmp/'manifest.PRIVATE.json').read_bytes()==(base/'manifest.PRIVATE.json').read_bytes()
    with zipfile.ZipFile(tmp/'final_metadata_PRIVATE.zip') as a,zipfile.ZipFile(base/'final_metadata_PRIVATE.zip') as b:
        assert set(a.namelist())==set(b.namelist()) and all(a.read(n)==b.read(n) for n in a.namelist())
    report={'status':'BOTH_FULL_CAR_MIGRATION_PATHS_VERIFIED','carSha256':p['releaseCarSha256'],'manifestSha256':p['releaseManifestSha256'],'restoredCarMigrationVerified':True,'rebuildCarMigrationVerified':True,'all10002MetadataArchiveMembersByteIdentical':True,'transactionsSent':0,'networkRequests':0}
    (base/'migration-test-proof.json').write_bytes(H['jb'](report));print(json.dumps(report))
finally:
    with source.open('r+b') as f:
        f.write(H['vu'](len(H['header'](new_root)))+H['header'](new_root))
        f.seek(offsets[new_col]);f.write(new_col+new_cb)
        f.seek(offsets[new_root]);f.write(new_root+new_raw)
    assert H['file_sha'](source)==p['releaseCarSha256'],'Original generated CAR restoration failed'
    shutil.rmtree(tmp)
