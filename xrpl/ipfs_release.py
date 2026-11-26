"""Package the public cover and private reveal metadata locally. No network calls."""
import argparse
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from archive import Original, require
from prepare import BASE, COUNT, json_bytes, slot_order, verify_png


def cid_string(cid):
    return 'b' + base64.b32encode(cid).decode().lower().rstrip('=')


def pack(tool, source, destination, *, single=False):
    cmd = [tool, 'pack', str(source), '--output', str(destination)]
    if single:
        cmd.append('--no-wrap')
    return subprocess.check_output(cmd, text=True).strip()


def hidden(tool, work):
    cover = BASE.parent / 'assets/collection/gif.gif'
    with tempfile.TemporaryDirectory(dir=work) as tmp:
        root = Path(tmp)
        cover_cid = pack(tool, cover, work/'cover.car', single=True)
        shutil.copyfile(cover, root/'cover.gif')
        for n in range(COUNT):
            slot = f'{n:04d}'
            data = {'name': f'CoolBears #{slot} — Hidden Bear', 'description': 'Your CoolBear is hiding.',
                    'image': 'ipfs://' + cover_cid}
            (root/(slot+'.json')).write_bytes(json_bytes(data))
        return {'hidden': pack(tool, root, work/'hidden.car'), 'cover': cover_cid, 'count': COUNT}


def revealed(tool, source, seed_path, work):
    archive = Original(source)
    entries = list(archive.files())
    files = dict(entries)
    require(len(files) == len(entries), 'Duplicate archive paths')
    order = slot_order(seed_path.read_bytes())
    ranks = set()
    unique_images = set()
    traits = 0
    with tempfile.TemporaryDirectory(dir=work) as tmp:
        root = Path(tmp)
        for n, number in enumerate(order):
            slot = f'{n:04d}'
            image_cid = files[f'/images/{number}.png']
            verify_png(archive.file(image_cid))
            meta = json.loads(archive.file(files[f'/metadata/{number}.json']))
            rarity = meta['properties']['rarity']
            rank = rarity['rank']
            require(isinstance(rank, int) and 1 <= rank <= COUNT and rank not in ranks,
                    'Invalid or duplicate rarity rank')
            require(image_cid not in unique_images and meta['name'] == 'CoolBears #'+number
                    and meta['image'].endswith('/'+number+'.png'), 'Mismatched original pair')
            require(isinstance(meta['description'], str) and isinstance(meta['attributes'], list)
                    and all('trait_type' in a and 'value' in a for a in meta['attributes']), 'Invalid original traits')
            ranks.add(rank)
            unique_images.add(image_cid)
            traits += len(meta['attributes'])
            image = 'ipfs://' + cid_string(image_cid)
            data = {'name': meta['name'], 'description': meta['description'], 'attributes': meta['attributes'],
                    'image': image, 'external_url': 'https://coolbears-nfts.com/xrpl/?slot='+slot+'#rarity',
                    'properties': {'category':'image', 'files':[{'uri':image,'type':'image/png'}],
                                   'collection_size':COUNT, 'top_percent':rank/100, 'rarity':rarity}}
            (root/(slot+'.json')).write_bytes(json_bytes(data))
        return {'metadata': pack(tool, root, work/'revealed.car'), 'originals': cid_string(archive.root),
                'count':len(unique_images), 'traits':traits}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--ipfs-car', default='ipfs-car', help='ipfs-car 3.1.0 executable')
    p.add_argument('phase', choices=['hidden','revealed'])
    p.add_argument('output', type=Path)
    p.add_argument('--originals', type=Path)
    p.add_argument('--allocation', type=Path)
    a = p.parse_args()
    a.output.mkdir(parents=True, exist_ok=True)
    if a.phase == 'revealed' and not (a.originals and a.allocation):
        p.error('revealed requires the original multipart archive and existing allocation')
    # Install complete output atomically; a failed retry leaves the previous archive intact.
    with tempfile.TemporaryDirectory(dir=a.output) as tmp:
        stage = Path(tmp)
        result = hidden(a.ipfs_car, stage) if a.phase == 'hidden' else revealed(a.ipfs_car, a.originals, a.allocation, stage)
        report = stage/(a.phase+'.json')
        report.write_bytes(json_bytes(result))
        for car in stage.glob('*.car'):
            os.replace(car, a.output/car.name)
        os.replace(report, a.output/report.name)


if __name__ == '__main__':
    main()
