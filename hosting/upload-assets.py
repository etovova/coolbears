"""Upload audited static bytes with a one-hour asset-session token, never an account key.

The connected Cloudflare API registers the manifest. Its buckets/token are supplied
in the ignored build directory. This script only uploads to the official assets API;
it cannot publish a Worker, change DNS, or access the existing RPC.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import uuid
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError

root = Path(__file__).resolve().parents[1]
candidate = root / 'build/hosting-candidate'
bundle = json.loads((candidate / 'direct-upload.json').read_text())
session_path = candidate / 'upload-session.PRIVATE.json'
session = json.loads(session_path.read_text())
assert session['accountId'] == 'edd6f56777691b0008836c1297f04f0d'
assert len(bundle['entries']) == 10031
by_hash = {entry['hash']: entry for entry in bundle['entries']}
assert len(by_hash) == 10031
report = {'kind': 'cloudflare-static-assets-upload', 'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
          'candidateManifestSha256': bundle['candidateManifestSha256'], 'buckets': [],
          'complete': False, 'workerPublished': False, 'dnsChanged': False}
report_path = candidate / 'upload-report.json'
if report_path.exists():
    previous = json.loads(report_path.read_text())
    assert previous['candidateManifestSha256'] == report['candidateManifestSha256']
    assert not previous['complete'], 'UPLOAD_ALREADY_COMPLETED'
    report = previous
confirmed = {item['index'] for item in report['buckets'] if item['success'] and item['httpStatus'] in (200, 201, 202)}
class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
http = build_opener(NoRedirect)
token = None
for index, bucket in enumerate(session['buckets']):
    if index in confirmed:
        continue
    boundary = 'CoolBearsAssetUpload' + uuid.uuid4().hex
    parts = []
    for digest in bucket:
        entry = by_hash[digest]
        file = candidate / 'site' / entry['path']
        assert not file.is_symlink() and file.is_file()
        data = file.read_bytes()
        assert len(data) == entry['size'] and hashlib.sha256(data).hexdigest() == entry['sha256']
        assert hashlib.md5(data).hexdigest() == digest
        parts.extend([f'--{boundary}\r\n'.encode(),
                      f'Content-Disposition: form-data; name="{digest}"; filename="{digest}"\r\n'.encode(),
                      f'Content-Type: {entry["type"]}\r\n\r\n'.encode(),
                      base64.b64encode(data), b'\r\n'])
    parts.append(f'--{boundary}--\r\n'.encode())
    request = Request('https://api.cloudflare.com/client/v4/accounts/' + session['accountId'] + '/workers/assets/upload?base64=true',
                      headers={'Authorization': 'Bearer ' + session['jwt'], 'Content-Type': 'multipart/form-data; boundary=' + boundary},
                      data=b''.join(parts), method='POST')
    try:
        response = http.open(request, timeout=120)
    except HTTPError as error:
        response = error
    status = response.status
    value = json.loads(response.read())
    item = {'index': index, 'files': len(bucket), 'httpStatus': status, 'success': value.get('success')}
    report['buckets'].append(item)
    (candidate / 'upload-report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(item), flush=True)
    if status not in (200, 201, 202) or not value.get('success'):
        print(json.dumps({'errorCodes': [e.get('code') for e in value.get('errors', [])]}), flush=True)
        sys.exit(1)
    token = (value.get('result') or {}).get('jwt') or token
assert token, 'COMPLETION_TOKEN_MISSING'
secret = candidate / 'upload-completion.PRIVATE.json'
fd = os.open(secret, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as output:
    json.dump({'jwt': token}, output)
report.update(complete=True, completedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), uploadedFiles=sum(len(x) for x in session['buckets']))
(candidate / 'upload-report.json').write_text(json.dumps(report, indent=2) + '\n')
session_path.unlink()
print(json.dumps({'complete': True, 'uploadedFiles': report['uploadedFiles']}), flush=True)
