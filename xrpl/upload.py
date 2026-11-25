"""Upload exact verified bytes with the short-lived Workers asset session JWT."""
import argparse
import base64
import concurrent.futures
import json
import mimetypes
import os
import time
import uuid
import urllib.error
import urllib.request
from pathlib import Path
from archive import Original, require
from prepare import asset, seal, storage_key


class Assets:
    def __init__(self, source, work, seed):
        self.work = work
        self.archive = Original(source, verify=False)
        self.key = storage_key(seed)
        self.packs = json.loads((work/"packs.json").read_text())
        self.manifest = json.loads((work/"manifest.json").read_text())
        self.by_hash = {v["hash"]:k for k,v in self.manifest.items()}

    def get(self, path):
        if path in self.packs:
            first = 10 * int(Path(path).stem[1:])
            data = b"".join(seal(self.key, f"art/{first+i:04d}", self.archive.file(bytes.fromhex(cid)))
                            for i,cid in enumerate(self.packs[path]))
        else:
            data = (self.work / Path(path).name).read_bytes()
        require(asset(data) == self.manifest[path], "Prepared asset hash mismatch")
        return data


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args):
        return None


def send(batch, assets, session):
    boundary=uuid.uuid4().hex
    body=bytearray()
    for digest in batch:
        path=assets.by_hash[digest]
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{digest}"; filename="{digest}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode())
        body.extend(base64.b64encode(assets.get(path)))
        body.extend(b'\r\n')
    body.extend(f'--{boundary}--\r\n'.encode())
    url="https://api.cloudflare.com/client/v4/accounts/"+session["accountId"]+"/workers/assets/upload?base64=true"
    for attempt in range(4):
        req=urllib.request.Request(url,data=body,headers={"Authorization":"Bearer "+session["jwt"],"Content-Type":"multipart/form-data; boundary="+boundary})
        try:
            with urllib.request.build_opener(NoRedirect()).open(req,timeout=150) as result:
                out=json.load(result)
                require(out.get("success"),"Asset upload was rejected")
                return (out.get("result") or {}).get("jwt")
        except urllib.error.HTTPError as e:
            if attempt==3 or (e.code not in (408,429) and e.code<500):
                raise RuntimeError(f"Asset upload HTTP {e.code}") from None
        except (TimeoutError,urllib.error.URLError):
            if attempt==3: raise RuntimeError("Asset transfer timed out") from None
        time.sleep(2**attempt)


def main():
    ap=argparse.ArgumentParser()
    for arg in ("source","work","seed","session","completion"): ap.add_argument(arg,type=Path)
    args=ap.parse_args()
    sess=json.loads(args.session.read_text())
    assets=Assets(args.source,args.work,args.seed.read_bytes())
    batches=sess["buckets"]
    require(all(h in assets.by_hash for b in batches for h in b),"Unrecognized upload request")
    total=sum(map(len,batches))
    completed=0;token=sess["jwt"] if not batches else None
    print(f"Starting {len(batches)} batches, {total} files",flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures={pool.submit(send,b,assets,sess):len(b) for b in batches}
        for future in concurrent.futures.as_completed(futures):
            try:
                token=future.result() or token
            except Exception as exc:
                print(f"Transfer stopped: {exc}",flush=True)
                for queued in futures: queued.cancel()
                raise
            completed+=futures[future]
            print(f"{completed}/{total} assets transferred",flush=True)
    require(token,"Cloudflare did not confirm the complete manifest")
    fd=os.open(args.completion,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(fd,"w") as out:json.dump({"jwt":token},out)


if __name__=="__main__": main()
