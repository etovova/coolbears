"""Rebuild CoolBears v3 images privately and verify pixels against the sealed V3 checksum report.
No traits, layer paths, CIDs or generated images are written to artifacts or logs.
"""
from pathlib import Path
from collections import defaultdict
import csv, hashlib, io, json, os, zipfile
from PIL import Image

CATEGORIES = ['Background','Body','Clothes','Mouth','Eyes','Head','Ears']
base = Path(os.environ['RUNNER_TEMP']) / 'coolbears-verified-recovery'
recovery = base / 'recovery.zip'
if not recovery.exists(): raise FileNotFoundError('recovery.zip missing')

def h(b): return hashlib.sha256(b).hexdigest()

def open_nested(z, name): return zipfile.ZipFile(io.BytesIO(z.read(name)))

with zipfile.ZipFile(recovery) as rz:
    with open_nested(rz, 'original_private_recovery.zip') as orig:
        source_bytes = orig.read('SourceLayers.zip')
        v3_bytes = orig.read('V3_Metadata_and_Reports.zip')
with zipfile.ZipFile(io.BytesIO(v3_bytes)) as v3:
    root='CoolBears_10000_v3/'
    plan=json.loads(v3.read(root+'generation_plan.json'))
    layers_report=json.loads(v3.read(root+'reports/source_layers.json'))
    checks=list(csv.DictReader(io.StringIO(v3.read(root+'reports/image_checksums.csv').decode())))

by_key=defaultdict(list)
for x in layers_report:
    by_key[(x['category'],x['trait_value'])].append(x)

with zipfile.ZipFile(io.BytesIO(source_bytes)) as sz:
    members=[n for n in sz.namelist() if not n.endswith('/')]
    suffix_map=defaultdict(list)
    for n in members:
        suffix_map[n].append(n)
    cache={}
    def member_for(rel):
        exact=[n for n in members if n==rel or n.endswith('/'+rel)]
        if len(exact)!=1: raise ValueError('layer path resolution is not unique')
        return exact[0]
    def image_for(layer):
        key=layer['relative_path']
        if key not in cache:
            im=Image.open(io.BytesIO(sz.read(member_for(key)))).convert('RGBA')
            im.load(); cache[key]=im
        return cache[key]
    def choose_layer(cat,val,attrs):
        choices=by_key[(cat,val)]
        if not choices: raise ValueError('required layer missing')
        if len(choices)==1: return choices[0]
        body=attrs.get('Body')
        exact=[x for x in choices if x.get('mouth_body')==body]
        if len(exact)==1: return exact[0]
        generic=[x for x in choices if x.get('mouth_body') in (None,'','None')]
        if len(generic)==1: return generic[0]
        raise ValueError('ambiguous layer selection')

    def hash_variants(im):
        rgba=im.convert('RGBA'); rgb=im.convert('RGB')
        return {
            'RGBA_BYTES': h(rgba.tobytes()),
            'RGB_BYTES': h(rgb.tobytes()),
            'RGBA_SIZE_BYTES': h(rgba.size[0].to_bytes(4,'big')+rgba.size[1].to_bytes(4,'big')+rgba.tobytes()),
            'RGB_SIZE_BYTES': h(rgb.size[0].to_bytes(4,'big')+rgb.size[1].to_bytes(4,'big')+rgb.tobytes()),
        }

    matched_variant=None
    matched=0
    first_mismatch=None
    dims=set()
    for i,item in enumerate(plan):
        attrs=item['attributes']
        layers=[choose_layer(cat,attrs[cat],attrs) for cat in CATEGORIES]
        ims=[image_for(x) for x in layers]
        sizes={im.size for im in ims}
        if len(sizes)!=1: raise ValueError('layer dimensions differ within an NFT')
        size=next(iter(sizes)); dims.add(size)
        canvas=Image.new('RGBA',size,(0,0,0,0))
        for im in ims:
            canvas=Image.alpha_composite(canvas,im)
        expected=checks[i]['pixel_sha256']
        variants=hash_variants(canvas)
        if matched_variant is None:
            hits=[k for k,v in variants.items() if v==expected]
            if len(hits)==1: matched_variant=hits[0]
            elif len(hits)>1: matched_variant=hits[0]
            else:
                first_mismatch=i
                break
        if variants[matched_variant]!=expected:
            first_mismatch=i
            break
        matched+=1

result={
    'schema':1,
    'status':'PIXEL_REBUILD_VERIFIED' if matched==10000 else 'PIXEL_REBUILD_MISMATCH',
    'verifiedImages':matched,
    'expectedImages':10000,
    'pixelHashConvention':matched_variant,
    'firstMismatchIndex':first_mismatch,
    'distinctCanvasDimensions':len(dims),
    'traitsExposed':False,
    'layerPathsExposed':False,
    'cidsExposed':False,
    'generatedImagesPublished':False,
    'walletOperations':False,
    'uploadsPerformed':False,
}
out=Path('build/private-image-rebuild-verify'); out.mkdir(parents=True,exist_ok=True)
(out/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
if matched!=10000: raise SystemExit(2)
