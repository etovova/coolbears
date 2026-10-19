# Cloudflare staging after PR28 — 23 September 2026

The owner authorized continuing the prepared migration. PR28 remains an open
draft; `main` and GitHub Pages were not changed. Work resumes from
`5bce65e3735ac24f3a93a826d5143a96558049ff` on `hosting-staging-20260923`.

## Completed

- Deployed the verified public site to
  **https://coolbears-site-candidate.yauheni84.workers.dev**.
- The API confirms `has_assets=true`, `has_modules=false`: assets-only hosting,
  no user Worker code, RPC bindings, routes, secrets or custom domain.
- Registered and uploaded **10031 public assets / 11145924 bytes**, in eleven
  confirmed buckets (ten of 1000 and one of 31). `_headers` (172 bytes) is sent
  as routing metadata, never as a publicly accessible asset.
- Candidate inventory including `_headers`: **10032 files / 11146096 bytes**;
  SHA-256 inventory digest
  `fd73845f95c98d23066d49a6b3fc3bf73051356bba1788143f3f83a9771e17bc`.
- Upload/deployment used the official direct-upload flow. Upload authorization
  was a one-hour asset-session token, not an account API key. No token is
  committed; temporary local token files were removed after use.
- Deployment ID: `19d1df60fdd74ec980c45600e6e8df1e`. The candidate's workers.dev
  endpoint is enabled; per-version preview URLs remain disabled.
- Saved complete Cloudflare before/after snapshots in the private project
  continuation file, including zone, DNS, DNSSEC, routes, domains and RPC
  script metadata. No RPC secret values were requested.
- Changed exactly five imported records in the still-pending Cloudflare zone:
  four apex A records and the www CNAME now use DNS-only. IDs, content, TTL,
  MX/TXT and other values were preserved and compared after the changes.
- Existing `coolbears-devnet-rpc` ETag and modification timestamp match the
  before snapshot. It was not redeployed or reconfigured.

## Validation

`build:wallet`, `build:site` and `verify` passed. All 10000 hidden metadata files
and original media were checked; public content bytes match the PR28 candidate.
The direct-upload preparer re-audits the allowlist and complete tree, then the
uploader checks SHA-256, transport digest and length before every upload.

**47 live HTTPS checks passed**, saved in `hosting-staging-live-20260923.json`:
all 31 existing public files, four hidden metadata samples, legal-page and
directory redirects, MIME/byte comparison, metadata CORS, config `no-store`,
closed-sale configuration at **0.2 SOL**, missing/private/control paths,
absence of RPC/mint endpoints, and GIF HEAD/ETag behavior. The first check run
used two unpadded sample URLs; the checker was corrected to the actual padded
filenames and the full run then passed. Site bytes were not changed to fix this.

The main page also opened in the cloud browser and showed 0.2 SOL and the
disabled coming-soon mint button. This was a desktop browser observation, not
a physical phone or wallet test. No wallet connected, no RPC or blockchain
transaction was sent. Staging origin is intentionally not added to RPC CORS.

The main domain still returned **HTTP 200 / Server: GitHub.com** after all work.
Public DNS still delegates to Porkbun. Public A/CNAME/MX/TXT matched the imported
Cloudflare record values; queried apex AAAA, CAA, DS and DNSKEY had no answers.
This public snapshot is **not a complete zone export or registrar DNSSEC check**.
Cloudflare's own DNSSEC setting is disabled.

## Blocker before nameserver migration

The connected Cloudflare account does not grant access to Porkbun. A browser
visit reached Porkbun's login form with a human-verification checkbox. No
credentials or CAPTCHA were submitted. Full source-zone enumeration and
registrar DNSSEC/DS settings therefore remain unverified.

Need a complete DNS export/list from Porkbun for `coolbears-nfts.com` plus its
DNSSEC/DS state, or an authenticated Porkbun session. Preserve every relevant
record, including mail, verification records and names outside the known apex,
www and ACME challenge names. Do not treat the ten Cloudflare auto-imported
records as proof of completeness.

## Next steps and rollback

1. Obtain/export Porkbun DNS and registrar DNSSEC; compare the complete zone
   with Cloudflare and reconcile missing records before changing delegation.
   If DS is present, follow the verified DNSSEC transition procedure first.
2. Preserve Porkbun DNS and GitHub Pages. The old nameservers are
   `curitiba.ns.porkbun.com`, `fortaleza.ns.porkbun.com`,
   `maceio.ns.porkbun.com`, `salvador.ns.porkbun.com`.
   The verified assigned Cloudflare nameservers are
   `blakely.ns.cloudflare.com` and `nash.ns.cloudflare.com`.
3. Only after the full comparison, perform the already authorized delegation
   change. Keep the website A/www records DNS-only pointing at GitHub Pages
   while Cloudflare activation completes. Check authoritative DNS and mail.
4. Prepare apex/www canonical routing and TLS, then bind the verified assets
   to the custom domain. www must redirect to the canonical apex; do not make
   a second mint origin or broaden RPC CORS. No custom-domain binding has yet
   been created. Verify exact existing metadata URLs and HTTPS before declaring
   the main-site migration complete.
5. Before a custom-domain cutover, retain the full DNS/route snapshot. If it
   fails, remove only the newly added site bindings and restore the saved
   GitHub Pages DNS values. If delegation itself fails, restore the saved
   Porkbun nameservers, accounting for DNS propagation and DNSSEC state.
6. To suspend only staging now, disable the candidate's workers.dev endpoint
   (`enabled:false`, `previews_enabled:false`). Keep its assets and the existing
   RPC untouched. No rollback is currently needed: main remains on GitHub Pages.

No mainnet work, new mint, old transaction replay, reveal, sales opening,
collection/machine recreation, or browser-data cleanup is authorized by this
staging result. Production mint RPC remains a separate unfinished stage.

## Reproduction and limits

- `node hosting/direct-upload-manifest.mjs` works on a freshly prepared
  `build/hosting-candidate`, rejects additional files, and writes the manifest,
  inventory and metadata. Never point it at private collection material.
- The connected Cloudflare API creates an assets upload session for the exact
  manifest. Keep its token/buckets only in the ignored build directory.
  `python3 hosting/upload-assets.py` uploads those exact files using the token.
  HTTP 202 confirms intermediate buckets; 201 with a completion token finishes
  the upload. The script itself cannot deploy or change DNS.
- Publish the asset-only metadata through the connected API, then enable only
  the candidate's workers.dev endpoint. Do not repeat uploads or deployment
  merely to recheck access.
- `node hosting/check-staging.mjs` performs bounded read-only HTTP validation
  and saves `build/hosting-candidate/live-staging.json`.

Primary implementation reference, read 23 September 2026:
https://developers.cloudflare.com/workers/static-assets/direct-upload/

No claim of a new physical-device, main-domain Cloudflare, wallet, mainnet,
Magic Eden or complete-budget validation is made.
