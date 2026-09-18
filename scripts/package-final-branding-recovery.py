#!/usr/bin/env python3
"""Create the PRIVATE complete reproduction kit, not a public release artifact."""
import json,os,zipfile
from pathlib import Path
base=Path(os.environ['COOLBEARS_BRANDING_RELEASE']);source=Path(os.environ['COOLBEARS_BRANDING_RECOVERY'])
output=base/'CoolBears_v3_release_recovery_PRIVATE.zip'
assert not output.exists()
proof=json.loads((base/'branding-proof.json').read_text());package=json.loads((base/'package-proof.json').read_text())
readme='''CoolBears — PRIVATE recovery, final-collection-branding-1, 18 September 2026.

Only collection.image and collection.cover_image changed. All 10000 NFT PNG and
individual metadata JSON bytes are identical to glasses-correction-1. The GIF,
numbering, traits, rarity, owner, price and royalty are unchanged.

This is a compact deterministic reproduction kit, NOT all 10000 ready-made PNG.
The original complete private recovery v1 is included byte-for-byte as
source_recovery_v1.zip. Do not apply the glasses correction again to its already
corrected plan. The new final metadata/manifest and unsigned packages are included.

Do not publish this ZIP, final URIs, reveal.PRIVATE.json or private metadata.
No contract has been deployed or mint/reveal authorized by creating this file.
The release remains HOLD. The included release-state is a historical snapshot,
not authority to launch. Check the latest repository state and recorded context.

Offline reproduction on Linux:
1. Extract this archive into a PRIVATE directory with at least 15 GB free space.
2. Install Python Pillow==11.3.0, then enter the rebuild/ directory.
3. python scripts/build-final-branding-local.py --recovery ../source_recovery_v1.zip --output ../reconstructed --workers 4
4. Compare reconstructed/branding-proof.json with branding-proof.json. The script
   verifies every PNG SHA/pixel SHA, metadata SHA/CID, the complete historical CAR
   checksum, and all new CAR blocks. It prints no private CIDs.
5. For independent TON checks install @ton/core@0.63.1 and @ton/sandbox@0.44.0.
   Use COOLBEARS_BRANDING_RELEASE with an absolute path to the extracted archive.
   node scripts/test-final-branding-reveal.mjs (in-memory only, no network).
6. To reproduce the unsigned package, set COOLBEARS_BRANDING_SOURCE_CANDIDATE to
   the absolute unsigned-packages/source-mainnet.candidate.json path and
   COOLBEARS_BRANDING_RELEASE to the archive's absolute directory. Run
   node scripts/rebuild-final-branding-package.mjs. Its output must match the
   included package-proof.json. No wallet, key, payment or deployment is used.

The private Pinata full-CAR migration has its own fresh readback evidence in the
latest project context/repository; this compact archive alone is not proof of it.
'''
with zipfile.ZipFile(output,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    z.write(source,'source_recovery_v1.zip',compress_type=zipfile.ZIP_STORED)
    for name in ['final_metadata_PRIVATE.zip','collection.json','manifest.PRIVATE.json','branding-proof.json','package-proof.json','reveal-test-proof.json','migration-test-proof.json']:
        z.write(base/name,name)
    for name in ['mainnet.candidate.json','source-mainnet.candidate.json','reveal.PRIVATE.json']:
        z.write(base/'unsigned-packages'/name,'unsigned-packages/'+name)
    z.write('build/current-testnet/deployment.json','unsigned-packages/testnet.candidate.json')
    files=['scripts/build-final-branding-local.py','scripts/rebrand-final-car.py','scripts/rebrand-stored-car.py','scripts/rebuild-final-branding-package.mjs','scripts/test-final-branding-reveal.mjs','scripts/test-final-branding-migration.py','launch/package-tools.mjs','launch/candidate.json','release/launch-state.json','release/prereveal-assets.json']
    assets=json.loads(Path('release/prereveal-assets.json').read_text())
    files.extend(assets[k]['source'] for k in ('logo','banner'))
    for f in files:z.write(f,'rebuild/'+f)
    z.writestr('README_RU_EN_PRIVATE.txt',readme)
with zipfile.ZipFile(output) as z:
    assert z.testzip() is None
    assert z.read('final_metadata_PRIVATE.zip')==(base/'final_metadata_PRIVATE.zip').read_bytes()
    assert z.read('unsigned-packages/mainnet.candidate.json')==Path('launch/candidate.json').read_bytes()
print(json.dumps({'status':'PRIVATE_BRANDING_RECOVERY_PACKAGED','path':str(output),'bytes':output.stat().st_size,'packageSha256':package['packageSha256'],'carSha256':proof['carSha256'],'readyMadePngIncluded':False,'networkRequests':0}))
