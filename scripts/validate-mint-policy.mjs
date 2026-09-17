import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const p = JSON.parse(fs.readFileSync('contracts/mint-policy.json', 'utf8'));
const d = JSON.parse(fs.readFileSync('mainnet/owner/deployment.json', 'utf8'));
const context = vm.createContext({window: {}, document: {addEventListener() {}}});
vm.runInContext(fs.readFileSync('config.js', 'utf8'), context, {timeout: 1000});
const c = context.window.COOLBEARS_CONFIG;
assert.ok(c && typeof c === 'object', 'Site configuration is missing');
for (const [key, value] of Object.entries({network:'mainnet',displayPrice:'7 GRAM (TON)',settlementCurrency:'TON',priceNanoTon:7000000000,supply:10000,maxPerTransaction:50,lifetimeWalletLimit:null,royaltyBps:700,revealDate:'2027-01-01',publicMintPausedByDefault:true,demoModeUntilTestnetVerified:true})) {
  assert.equal(p[key], value, `Mint policy mismatch: ${key}`);
}
assert.equal(p.treasuryAddress, p.royaltyAddress, 'Treasury/royalty recipient mismatch');
assert.match(p.treasuryAddress, /^UQ[A-Za-z0-9_-]{46}$/, 'Invalid treasury address format');
assert.equal(d.network, 'mainnet');
assert.equal(d.initialPaused, true);
assert.equal(d.nextItemIndex, 0);
assert.equal(d.priceNanoTon, p.priceNanoTon);
assert.equal(d.supply, p.supply);
assert.equal(d.maxPerTransaction, p.maxPerTransaction);
assert.equal(d.royaltyBps, p.royaltyBps);
assert.equal(d.revealAt, 1798761600);
assert.equal(d.treasuryAddressMainnetFriendly, p.treasuryAddress);
assert.equal(d.creatorReservation.tokenIndex, 0);
assert.equal(d.creatorReservation.beneficiaryAddressRaw, d.treasuryAddressRaw);
assert.equal(p.creatorReservation?.tokenIndex, 0);
assert.equal(p.creatorReservation?.beneficiaryAddress, p.treasuryAddress);
assert.equal(p.creatorReservation?.claimOpcode, '0x52535630');

// Compare actual values to the unsigned package; comments and partial string
// matches are not evidence. A configured address is not permission to sell.
for (const [key, value] of Object.entries({network:'mainnet',priceTon:7,supply:10000,royaltyPercent:7,maxPerTransaction:50,revealDate:'2027-01-01',mintPaymentPerNftTon:7.10,mintPaymentPerNftNano:7100000000,treasuryAddress:p.treasuryAddress,royaltyAddress:p.royaltyAddress,collectionAddress:d.collectionAddressMainnetNonBounceable,mintContractAddress:d.collectionAddressMainnetBounceable,collectionCodeHash:d.collectionCodeHash})) {
  assert.ok(value !== undefined && value !== '', `Missing expected value: ${key}`);
  assert.equal(c[key], value, `Site/package mismatch: ${key}`);
}
for (const key of ['preRevealImageCid','preRevealMetadataCid','preRevealMetadataRootCid','collectionMetadataCid']) {
  assert.match(p[key], /^baf[a-z2-7]+$/, `Missing or malformed CID: ${key}`);
  assert.equal(c[key], p[key], `Site/policy CID mismatch: ${key}`);
}
assert.equal(c.preRevealMetadataRootIpfs, d.preRevealMetadataRootIpfs);
assert.equal(c.collectionMetadataIpfs, d.collectionMetadataIpfs);
// This is deliberately a PRELAUNCH gate. A future production phase needs its
// own verified release approval. Merely changing demoMode must not pass CI.
await import('./validate-release-state.mjs');
console.log('CoolBears mint policy: package, metadata references and release gate OK');
