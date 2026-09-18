"""Strictly decode exact approved public branding/GIF; never open final NFT files."""
import hashlib, io, json, subprocess
from pathlib import Path
from PIL import Image, ImageFile
ImageFile.LOAD_TRUNCATED_IMAGES = False
a = json.loads(Path('release/prereveal-assets.json').read_text())
for name, size in [('logo',(1000,1000)),('banner',(2048,483))]:
    b = Path(a[name]['source']).read_bytes()
    assert hashlib.sha256(b).hexdigest() == a[name]['sha256']
    im = Image.open(io.BytesIO(b)); im.load()
    assert im.format == 'PNG' and im.size == size
url = 'https://gateway.pinata.cloud/ipfs/' + a['gif']['cid']
b = subprocess.check_output(['curl','--fail','--silent','--show-error','--location','--retry','3','--max-time','60',url])
assert hashlib.sha256(b).hexdigest() == a['gif']['sha256']
im = Image.open(io.BytesIO(b))
assert im.format == 'GIF' and im.size == (640,640) and im.info.get('loop') == 0
assert im.n_frames == a['gif']['frames']
duration = 0
for i in range(im.n_frames):
    im.seek(i); im.load(); duration += im.info.get('duration',0)
assert duration == a['gif']['durationMs']
out = dict(strictImageDecodeVerified=True, gifSha256=a['gif']['sha256'], gifFrames=im.n_frames, gifDurationMs=duration, logoSha256=a['logo']['sha256'], bannerSha256=a['banner']['sha256'])
Path('build/hidden-metadata').mkdir(parents=True, exist_ok=True)
Path('build/hidden-metadata/media-proof.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(out))
