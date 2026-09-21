"""Streaming read-only PNG verifier. Input: u32 length + PNG. Output: JSON line."""
import hashlib
import io
import json
import struct
import sys
from PIL import Image


def read_exact(n):
    chunks = bytearray()
    while len(chunks) < n:
        part = sys.stdin.buffer.read(n - len(chunks))
        if not part:
            raise EOFError('Incomplete PNG frame')
        chunks.extend(part)
    return bytes(chunks)


while True:
    header = sys.stdin.buffer.read(4)
    if not header:
        break
    try:
        size = struct.unpack('>I', header)[0]
        if not 0 < size <= 20_000_000:
            raise ValueError('Invalid PNG size')
        raw = read_exact(size)
        with Image.open(io.BytesIO(raw)) as im:
            if im.format != 'PNG':
                raise ValueError('Not a PNG')
            im.verify()
        with Image.open(io.BytesIO(raw)) as im:
            result = {'size': list(im.size), 'mode': im.mode,
                      'pixel_sha256': hashlib.sha256(im.convert('RGB').tobytes()).hexdigest()}
    except Exception as exc:
        result = {'error': type(exc).__name__ + ': ' + str(exc)}
    print(json.dumps(result), flush=True)
