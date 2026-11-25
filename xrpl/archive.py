"""Read the original, uncompressed multipart ZIP/CAR without duplicating 13 GB."""
import bisect
import hashlib
import json
import mmap
import struct
import zipfile
from pathlib import Path

SOURCE_SHA256 = "1718812be2c8b1c964f41bf0bb1d58d4be856b4b391d2b50773899e895390b81"


def require(ok, message):
    if not ok:
        raise ValueError(message)


def varint(data, pos=0):
    value = 0
    for shift in range(0, 64, 7):
        byte = data[pos]
        pos += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, pos
    raise ValueError("Invalid varint")


def protobuf(data):
    pos = 0
    while pos < len(data):
        tag, pos = varint(data, pos)
        wire = tag & 7
        if wire == 0:
            value, pos = varint(data, pos)
        elif wire == 2:
            size, pos = varint(data, pos)
            value = data[pos:pos + size]
            require(len(value) == size, "Truncated protobuf field")
            pos += size
        else:
            raise ValueError("Unsupported wire type in UnixFS")
        yield tag >> 3, value


class Original:
    def __init__(self, directory, verify=True):
        self.parts = []
        self.starts = []
        self.blocks = {}
        self.size = 0
        manifest = json.loads((directory / "manifest.json").read_text())
        require(len(manifest["parts"]) == 28 and manifest["sha256"] == SOURCE_SHA256, "Wrong archive")
        whole = hashlib.sha256()
        for part in manifest["parts"]:
            path = directory / part["file"]
            with zipfile.ZipFile(path) as archive, path.open("rb") as stream:
                item, = archive.infolist()
                require(item.filename == part["member"] and item.compress_type == zipfile.ZIP_STORED
                        and item.file_size == part["bytes"], "Unexpected ZIP member")
                stream.seek(item.header_offset + 26)
                name, extra = struct.unpack("<HH", stream.read(4))
                offset = item.header_offset + 30 + name + extra
                mapped = mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ)
                self.parts.append((mapped, offset, item.file_size))
                self.starts.append(self.size)
                self.size += item.file_size
                if verify:
                    block = memoryview(mapped)[offset:offset + item.file_size]
                    require(hashlib.sha256(block).hexdigest() == part["sha256"], "Bad archive part")
                    whole.update(block)
                    block.release()
        require(self.size == manifest["bytes"], "Archive length mismatch")
        if verify:
            require(whole.hexdigest() == SOURCE_SHA256, "Archive digest mismatch")
        header_size, start = varint(self.read(0, 10))
        header = self.read(start, header_size)
        # This exact archived CAR uses one DAG-CBOR CIDv1 DAG-PB SHA-256 root.
        prefix = bytes.fromhex("a265726f6f747381d82a582500")
        require(header.startswith(prefix) and header.endswith(b"\x67version\x01"), "Unknown CAR header")
        self.root = header[len(prefix):len(prefix)+36]
        pos = start + header_size
        while pos < self.size:
            lead = self.read(pos, min(48, self.size - pos))
            size, clen = varint(lead)
            cid = lead[clen:clen + 36]
            require(cid[:4] in (b"\x01\x55\x12\x20", b"\x01\x70\x12\x20")
                    and size >= 36 and pos + clen + size <= self.size, "Malformed CAR section")
            location = (pos + clen + 36, size - 36)
            if verify:
                require(hashlib.sha256(self.read(*location)).digest() == cid[4:], "Incorrect CID")
            self.blocks[cid] = location
            pos += clen + size
        require(self.root in self.blocks and pos == self.size, "Missing CAR root")

    def read(self, pos, size):
        require(0 <= pos <= self.size and 0 <= size <= self.size - pos, "Read outside archive")
        chunks = []
        while size:
            i = bisect.bisect_right(self.starts, pos) - 1
            mm, offset, length = self.parts[i]
            local = pos - self.starts[i]
            take = min(size, length - local)
            chunks.append(mm[offset + local:offset + local + take])
            pos += take
            size -= take
        return b"".join(chunks)

    def node(self, cid):
        fields = list(protobuf(self.read(*self.blocks[cid])))
        info = dict(protobuf(next(v for k,v in fields if k == 1)))
        links = [dict(protobuf(v)) for k,v in fields if k == 2]
        return info, links

    def files(self, cid=None, path=""):
        cid = self.root if cid is None else cid
        if cid[1] == 0x70:
            info, links = self.node(cid)
            if info[1] in (1, 5):
                for link in links:
                    name = link[2].decode()
                    if info[1] == 5:
                        require(info[6] == 256 and len(name) >= 2, "Unexpected HAMT fanout")
                        int(name[:2], 16)
                        name = name[2:]
                        if not name:
                            yield from self.files(link[1], path)
                            continue
                    require(name not in ("", ".", "..") and "/" not in name, "Invalid member path")
                    yield from self.files(link[1], path + "/" + name)
                return
        yield path, cid

    def file(self, cid):
        if cid[1] == 0x55:
            return self.read(*self.blocks[cid])
        info, links = self.node(cid)
        require(info[1] == 2, "Expected UnixFS file")
        raw = info.get(2, b"") + b"".join(self.file(link[1]) for link in links)
        require(len(raw) == info[3], "UnixFS length mismatch")
        return raw
