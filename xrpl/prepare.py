"""Audit the immutable original archive and prepare a private Workers asset manifest."""
import argparse
import hashlib
import hmac
import json
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import struct
import zlib
from pathlib import Path
from archive import Original, require

COUNT = 10000
PACK_SIZE = 10
BASE = Path(__file__).resolve().parent


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def asset(data):
    require(0 < len(data) <= 25 * 1024 * 1024, "Asset exceeds the Workers limit")
    return {"hash": hashlib.sha256(data).hexdigest()[:32], "size": len(data)}


def verify_png(raw):
    require(raw[:8] == b"\x89PNG\r\n\x1a\n" and raw[12:16] == b"IHDR"
            and struct.unpack(">II", raw[16:24]) == (2000, 2000), "Wrong original image")
    pos = 8
    while pos < len(raw):
        size = struct.unpack_from(">I", raw, pos)[0]
        end = pos + 8 + size
        require(end + 4 <= len(raw) and zlib.crc32(memoryview(raw)[pos+4:end]) ==
                struct.unpack_from(">I", raw, end)[0], "Bad PNG CRC")
        tag = raw[pos + 4:pos + 8]
        pos = end + 4
        if tag == b"IEND":
            require(size == 0 and pos == len(raw), "Trailing PNG data")
            return
    raise ValueError("Missing PNG end")


def storage_key(seed):
    return hmac.digest(seed, b"CoolBears-XRPL-asset-key-v1", "sha256")


def seal(key, label, data):
    aad = label.encode()
    nonce = hmac.digest(key, b"iv/" + aad + b"/" + hashlib.sha256(data).digest(), "sha256")[:12]
    return nonce + AESGCM(key).encrypt(nonce, data, aad)


def save_leaderboard(work, key, manifest, leaders):
    leaders.sort(key=lambda item: item["rank"])
    require([row["rank"] for row in leaders] == list(range(1, 51)), "Incomplete top 50")
    name = "leaders.bin"
    data = seal(key, name, json_bytes(leaders))
    (work / name).write_bytes(data)
    manifest["/internal/" + name] = asset(data)


def slot_order(seed):
    require(len(seed) == 32, "Expected the existing 32-byte allocation seed")
    ids = (f"{n:04d}" for n in range(COUNT))
    return sorted(ids, key=lambda n: hmac.digest(seed, b"CoolBears-XRPL-v1/"+n.encode(), "sha256"))


def prepare(source, work, seed):
    key_bytes = storage_key(seed)
    archive = Original(source)
    entries = list(archive.files())
    files = dict(entries)
    require(len(files) == len(entries), "Duplicate UnixFS path")
    ids = [f"{n:04d}" for n in range(COUNT)]
    expected = set(ids)
    for kind, ext in (("images", "png"), ("metadata", "json")):
        names = {p.split("/")[-1].split(".")[0] for p in files if p.startswith("/"+kind+"/") and p.endswith("."+ext)}
        require(names == expected, "Missing or extra originals")
    # Independent of rarity and wallet identity; every original occurs exactly once.
    order = slot_order(seed)
    manifest, packs, checksums = {}, {}, set()
    leaders = []
    top_count = 0
    shards = []
    for start in range(0, COUNT, PACK_SIZE):
        pack = bytearray()
        block_ids = []
        for slot in range(start, start + PACK_SIZE):
            number = order[slot]
            cid = files["/images/"+number+".png"]
            raw = archive.file(cid)
            verify_png(raw)
            digest = hashlib.sha256(raw).hexdigest()
            require(digest not in checksums, "Duplicate original PNG")
            checksums.add(digest)
            meta = json.loads(archive.file(files["/metadata/"+number+".json"]))
            require(meta["name"] == "CoolBears #"+number and meta["image"].endswith("/"+number+".png")
                    and isinstance(meta["description"], str) and isinstance(meta["attributes"], list)
                    and all(isinstance(a,dict) and "trait_type" in a and "value" in a for a in meta["attributes"]), "Metadata mismatch")
            rarity = meta["properties"]["rarity"]
            require(isinstance(rarity["rank"], int) and 1 <= rarity["rank"] <= COUNT
                    and isinstance(rarity["score"], str) and isinstance(rarity["trait_frequencies"], dict),
                    "Invalid original rarity")
            top_count += rarity["rank"] == 1
            if rarity["rank"] <= 50:
                leaders.append({"slot":f"{slot:04d}", "name":meta["name"], "rank":rarity["rank"], "score":rarity["score"]})
            sealed = seal(key_bytes, f"art/{slot:04d}", raw)
            shards.append({"name":meta["name"], "description":meta["description"], "attributes":meta["attributes"],
                           "rarity":rarity, "offset":len(pack), "length":len(sealed), "sha256":digest})
            block_ids.append(cid.hex())
            pack.extend(sealed)
        key = f"/internal/p{start // PACK_SIZE:03d}.bin"
        manifest[key] = asset(pack)
        packs[key] = block_ids
        if len(shards) == 100:
            name = f"m{start // 100:02d}.json"
            data = seal(key_bytes, name, json_bytes(shards))
            (work / name).write_bytes(data)
            manifest["/internal/"+name] = asset(data)
            shards = []
    require(top_count >= 1 and not shards, "Missing highest-ranked original")
    save_leaderboard(work, key_bytes, manifest, leaders)
    static = {"cover.gif": BASE.parent/"assets/collection/gif.gif", "logo.png": BASE.parent/"assets/collection/logo.png",
              "wallet.js": BASE/"vendor/gemwallet.js","app.js":BASE/"web/app.js","site.css":BASE/"web/site.css","home.html":BASE/"web/index.html"}
    for name,path in static.items():
        data = path.read_bytes()
        (work / name).write_bytes(data)
        manifest["/internal/"+name] = asset(data)
    for name,obj in (("packs.json",packs), ("manifest.json",manifest)):
        tmp=work/(name+".tmp")
        tmp.write_bytes(json_bytes(obj))
        tmp.replace(work/name)
    print(json.dumps({"original_png":len(checksums),"metadata":COUNT,"top_rank_present":bool(top_count),
                      "unique_slots":len(set(order)), "assets":len(manifest),"archive_sha256_verified":True,
                      "commitment":hashlib.sha256(json_bytes(order)).hexdigest()}),flush=True)


if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    for name in ("source","work","seed"):
        parser.add_argument(name,type=Path)
    args=parser.parse_args()
    seed=args.seed.read_bytes()
    require(len(seed)==32,"Expected a private 32-byte allocation seed")
    args.work.mkdir(parents=True,exist_ok=True)
    prepare(args.source,args.work,seed)
