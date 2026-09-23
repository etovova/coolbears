# Assets-only www redirect

`coolbears-www-redirect` is bound only to `www.coolbears-nfts.com`.
All paths redirect to the approved HTTPS apex with status 301, preserving the
path and query. Never bind the apex to this redirect: that would create a loop.

There is no user Worker module, binding, secret, or outbound fetch. The one-byte
404.html provides an asset manifest; `_redirects` is control metadata. The rule
uses path matching, not unsupported domain-level matching in `_redirects`.
Workers.dev and version previews are disabled after live validation.

Run `node hosting/www-redirect/runtime.mjs` for six local workerd cases. Deploy
uses the same official assets direct-upload sequence as the main staging host;
pass `_redirects` in assets.config and do not publish it as a public asset. The
account JWT and upload-completion JWT are temporary and must never be committed.
