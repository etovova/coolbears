import fs from 'node:fs';

const policy = JSON.parse(fs.readFileSync('contracts/mint-policy.json','utf8'));
const meta = JSON.parse(fs.readFileSync('metadata/prereveal.json','utf8'));
const configText = fs.readFileSync('config.js','utf8');

const permittedKeys = new Set(['name', 'description', 'image', 'animation_url', 'external_url', 'attributes']);
for (const key of Object.keys(meta)) if (!permittedKeys.has(key)) throw new Error(`Unexpected public metadata field: ${key}`);
const revealLabel = 'January 1, 2027';
if (policy.revealDate !== '2027-01-01') throw new Error('Unexpected reveal date');
if (!meta.description.includes(revealLabel) || meta.attributes?.find(a => a.trait_type === 'Reveal')?.value !== revealLabel) throw new Error('Prereveal date differs from policy');
const expectedImage = `ipfs://${policy.preRevealImageCid}`;
if (meta.image !== expectedImage) throw new Error(`Prereveal image mismatch: ${meta.image}`);
if (meta.animation_url !== expectedImage) throw new Error('Prereveal animation_url must use hidden image only');

const attrs = Array.isArray(meta.attributes) ? meta.attributes : [];
const allowed = new Set(['Status','Reveal']);
if (attrs.length !== 2) throw new Error(`Expected exactly 2 prereveal attributes, got ${attrs.length}`);
for (const a of attrs) {
  if (!allowed.has(a.trait_type)) throw new Error(`Forbidden prereveal trait: ${a.trait_type}`);
}
if (attrs.find(a=>a.trait_type==='Status')?.value !== 'Unrevealed') throw new Error('Status must be Unrevealed');
if (!attrs.find(a=>a.trait_type==='Reveal')) throw new Error('Reveal date attribute missing');

const forbiddenKeys = ['rarity','rank','background','body','eyes','mouth','hat','clothes','accessory','trait_count'];
const serialized = JSON.stringify(meta).toLowerCase();
for (const key of forbiddenKeys) {
  if (serialized.includes(`\"trait_type\":\"${key}`) || serialized.includes(`\"${key}\":`)) {
    throw new Error(`Potential final trait leaked in prereveal metadata: ${key}`);
  }
}

if (!policy.preRevealMetadataRootIpfs?.startsWith('ipfs://')) throw new Error('Missing prereveal root');
if (!configText.includes(`preRevealMetadataRootCid: '${policy.preRevealMetadataRootCid}'`)) throw new Error('config.js prereveal root mismatch');
if (!configText.includes('demoMode: true')) throw new Error('demoMode must stay true before testnet verification');
if (!configText.includes("collectionAddress: ''")) throw new Error('Production collectionAddress must stay empty');
if (!configText.includes("mintContractAddress: ''")) throw new Error('Production mintContractAddress must stay empty');

console.log('PREREVEAL_PRIVACY_AUDIT_OK');
console.log(`Root: ${policy.preRevealMetadataRootIpfs}`);
console.log(`Hidden image: ${expectedImage}`);
