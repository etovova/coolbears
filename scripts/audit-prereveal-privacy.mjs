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

// Production addresses may be preloaded only after the exact tested package has
// been promoted to mainnet. The public mint must still remain gated until the
// live contract, creator NFT #0 and metadata are verified on mainnet.
await import('./validate-release-state.mjs');
const ownerPackagePath = 'mainnet/owner/deployment.json';
if (fs.existsSync(ownerPackagePath)) {
  const mainnet = JSON.parse(fs.readFileSync(ownerPackagePath,'utf8'));
  if (mainnet.network !== 'mainnet') throw new Error('Owner package is not mainnet');
  if (!mainnet.initialPaused || Number(mainnet.nextItemIndex) !== 0) throw new Error('Unsafe mainnet initial state');
  if (!configText.includes(`collectionAddress: '${mainnet.collectionAddressMainnetNonBounceable}'`)) throw new Error('Production collectionAddress does not match verified package');
  if (!configText.includes(`mintContractAddress: '${mainnet.collectionAddressMainnetBounceable}'`)) throw new Error('Production mintContractAddress does not match verified package');
  if (!configText.includes(`collectionCodeHash: '${mainnet.collectionCodeHash}'`)) throw new Error('Production code hash does not match verified package');
} else {
  if (!configText.includes("collectionAddress: ''")) throw new Error('Production collectionAddress must stay empty without a verified mainnet package');
  if (!configText.includes("mintContractAddress: ''")) throw new Error('Production mintContractAddress must stay empty without a verified mainnet package');
}

console.log('PREREVEAL_PRIVACY_AUDIT_OK');
console.log(`Root: ${policy.preRevealMetadataRootIpfs}`);
console.log(`Hidden image: ${expectedImage}`);
console.log('Production mint gate validated against release/launch-state.json');
