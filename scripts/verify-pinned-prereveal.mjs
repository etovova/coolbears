import fs from 'node:fs';
import assert from 'node:assert/strict';
const policy = JSON.parse(fs.readFileSync('contracts/mint-policy.json','utf8'));
const template = JSON.parse(fs.readFileSync('metadata/prereveal.json','utf8'));
async function check(cid, expected) {
  const url = `https://gateway.pinata.cloud/ipfs/${cid}`;
  let last;
  for (let attempt=0; attempt<8; attempt++) {
    try {
      const r = await fetch(url, {signal: AbortSignal.timeout(45000)});
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      assert.deepEqual(await r.json(), expected);
      console.log(`VERIFIED ${cid}`);
      return;
    } catch(e) {
      last=e;
      if (e.code === 'ERR_ASSERTION') throw e;
      if (attempt<7) await new Promise(r=>setTimeout(r,10000));
    }
  }
  throw new Error(`Pinned metadata unavailable: ${url}: ${last.message}`);
}
await check(policy.preRevealMetadataCid, template);
for (const id of ['0000','0001','4979','9999']) {
  await check(`${policy.preRevealMetadataRootCid}/${id}.json`, {...template, name:`CoolBears #${id} — Hidden Bear`});
}
console.log('PINNED_PREREVEAL_DATE_AND_CONTENT_OK');
