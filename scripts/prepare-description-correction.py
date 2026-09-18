#!/usr/bin/env python3
"""Prepare a PRIVATE description-only revision; never upload or activate it."""
import argparse, hashlib, io, json, os, runpy, zipfile
from pathlib import Path

H = runpy.run_path(str(Path(__file__).with_name('build-final-branding-local.py')))
R = runpy.run_path(str(Path(__file__).with_name('rebrand-final-car.py')))
jb, cid, dec, text, directory, header, vu, file_size = [H[k] for k in ('jb','cid','dec','text','directory','header','vu','file_size')]
var = R['var']
sha = lambda b: hashlib.sha256(b).hexdigest()
SOURCE_CAR = '9b419a1d4642fd3e3b7d7ddcb1f27db6e25532b756634165a269ae0b76b02161'
SOURCE_RECOVERY = '51ea08da63ea9a2da09751285c13f2cc503ee38cc5d567c92d215596c67623ed'

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source-car', type=Path, required=True)
    ap.add_argument('--recovery', type=Path, required=True)
    ap.add_argument('--output', type=Path, required=True)
    a = ap.parse_args()
    assert not a.output.exists(), 'Refusing to overwrite an earlier revision'
    assert a.source_car.stat().st_size == 12779698835
    with a.recovery.open('rb') as f:
        assert hashlib.file_digest(f, 'sha256').hexdigest() == SOURCE_RECOVERY
    package = json.loads(Path('launch/candidate.json').read_text())
    assert package['releaseCarSha256'] == SOURCE_CAR
    with zipfile.ZipFile(a.recovery) as z:
        archive = z.read('final_metadata_PRIVATE.zip')
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        old_mb = z.read('manifest.PRIVATE.json')
        assert sha(old_mb) == package['releaseManifestSha256']
        m = json.loads(old_mb)
        old_cb = z.read('collection.json')
        old_col = json.loads(old_cb)
        col = dict(old_col)
        col['description'] = json.loads(Path('metadata/collection.json').read_text())['description']
        assert {k for k in col if col[k] != old_col[k]} == {'description'}
        assert 'reserved' not in col['description'].lower()
        new_cb = jb(col)
        records = m['records']
        assert [r['id'] for r in records] == list(range(10000))
        metas = []
        for r in records:
            b = z.read('metadata/%04d.json' % r['id'])
            assert sha(b) == r['metadataSha256'] and text(cid(b, 0x55)) == r['metadataCid']
            metas.append(b)
    ic, isz, _ = directory([('%04d.png'%r['id'], dec(r['imageCid']), file_size(r['imageBytes'])) for r in records])
    mc, msz, _ = directory([('%04d.json'%r['id'], dec(r['metadataCid']), len(b)) for r,b in zip(records, metas)])
    oldroot, _, oldraw = directory([('collection.json', cid(old_cb,0x55), len(old_cb)), ('images',ic,isz), ('metadata',mc,msz)])
    newroot, _, newraw = directory([('collection.json', cid(new_cb,0x55), len(new_cb)), ('images',ic,isz), ('metadata',mc,msz)])
    assert text(oldroot) == m['bundleCid']
    new_m = {**m, 'bundleCid':text(newroot), 'collectionMetadataIpfs':'ipfs://'+text(newroot)+'/collection.json', 'metadataRootIpfs':'ipfs://'+text(newroot)+'/metadata/', 'descriptionRevision':'approved-description-1'}
    new_mb = jb(new_m)
    a.output.mkdir(parents=True, mode=0o700)
    (a.output/'collection.json').write_bytes(new_cb)
    (a.output/'manifest.PRIVATE.json').write_bytes(new_mb)
    with zipfile.ZipFile(a.output/'final_metadata_PRIVATE.zip','x',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for r,b in zip(records,metas): z.writestr('metadata/%04d.json'%r['id'],b)
        z.writestr('collection.json',new_cb)
        z.writestr('manifest.PRIVATE.json',new_mb)
    replacements = {cid(old_cb,0x55):(cid(new_cb,0x55),new_cb),oldroot:(newroot,newraw)}
    old_hash, new_hash = hashlib.sha256(), hashlib.sha256()
    blocks = changes = 0
    with a.source_car.open('rb') as src, (a.output/'CoolBears_v3_final.car').open('xb') as out:
        hb = src.read(var(src))
        assert hb == header(oldroot)
        old_hash.update(vu(len(hb))+hb)
        nh = vu(len(header(newroot)))+header(newroot)
        out.write(nh);new_hash.update(nh)
        while src.tell() < a.source_car.stat().st_size:
            n = var(src);c = src.read(36);b = src.read(n-36)
            assert len(b)==n-36 and cid(b,c[1])==c
            original = vu(n)+c+b;old_hash.update(original)
            if c in replacements:
                c,b = replacements[c];changes += 1
            current = vu(len(c)+len(b))+c+b
            out.write(current);new_hash.update(current);blocks += 1
        out.flush();os.fsync(out.fileno())
    assert old_hash.hexdigest()==SOURCE_CAR and changes==2
    target = a.output/'CoolBears_v3_final.car'
    with target.open('rb') as f: assert hashlib.file_digest(f,'sha256').hexdigest()==new_hash.hexdigest()
    proof = {'status':'DESCRIPTION_CORRECTION_PREPARED_OFFLINE','descriptionRevision':'approved-description-1','sourceCarSha256':SOURCE_CAR,'sourceManifestSha256':sha(old_mb),'sourceRecoverySha256':SOURCE_RECOVERY,'sourceCarExactlyVerified':True,'manifestSha256':sha(new_mb),'carSha256':new_hash.hexdigest(),'carBytes':target.stat().st_size,'collectionJsonSha256':sha(new_cb),'unchangedPngFiles':10000,'unchangedMetadataFiles':10000,'sourceCarBlocksVerified':blocks,'changedBlocks':2,'finalFilesPublished':False,'transactionsSent':0}
    (a.output/'description-proof.json').write_bytes(jb(proof))
    print(json.dumps(proof),flush=True)

if __name__ == '__main__':main()
