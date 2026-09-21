#!/usr/bin/env python3
"""Stream verified parts into one CAR; never execute archived recovery code."""
import argparse, hashlib, json, os, zipfile
from pathlib import Path
p = argparse.ArgumentParser(); p.add_argument('--parts', required=True); p.add_argument('--output', required=True)
a = p.parse_args(); source = Path(a.parts); out = Path(a.output)
manifest = json.loads((source / 'manifest.json').read_text())
assert len(manifest['parts']) == 28
out.parent.mkdir(parents=True, exist_ok=True)
temp = out.with_suffix('.partial'); total = hashlib.sha256(); size = 0
with temp.open('wb') as target:
    for index, part in enumerate(manifest['parts']):
        assert Path(part['file']).name == part['file']
        digest = hashlib.sha256(); count = 0
        with zipfile.ZipFile(source / part['file']) as archive:
            assert archive.namelist() == [part['member']]
            with archive.open(part['member']) as data:
                while chunk := data.read(4 * 1024 * 1024):
                    target.write(chunk); digest.update(chunk); total.update(chunk); count += len(chunk)
        assert count == part['bytes'] and digest.hexdigest() == part['sha256'], f'Part {index + 1} mismatch'
        size += count
        print(f'Verified part {index + 1}/28', flush=True)
    target.flush(); os.fsync(target.fileno())
assert size == manifest['bytes'] and total.hexdigest() == manifest['sha256']
temp.replace(out)
print(json.dumps({'parts': 28, 'bytes': size, 'sha256': total.hexdigest()}))
