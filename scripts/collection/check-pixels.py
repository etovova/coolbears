#!/usr/bin/env python3
"""Read framed PNGs, decode every pixel, and verify the original pixel hash."""
import hashlib, io, json, struct, sys
from PIL import Image
stream = sys.stdin.buffer
def exact(n):
    result = bytearray()
    while len(result) < n:
        b = stream.read(n - len(result))
        if not b: raise EOFError('Incomplete PNG frame')
        result.extend(b)
    return bytes(result)
count = 0
while header := stream.read(4):
    meta = json.loads(exact(struct.unpack('>I', header)[0]))
    png = exact(meta['bytes'])
    with Image.open(io.BytesIO(png)) as image:
        assert image.size == (2000, 2000), meta['index']
        image.load()
        assert hashlib.sha256(image.tobytes()).hexdigest() == meta['pixel_sha256'], meta['index']
    count += 1
assert count == 10000, count
print(json.dumps({'decodedPngs': count, 'originalPixelHashes': count}), flush=True)
