import fs from 'node:fs';

const p = JSON.parse(fs.readFileSync('contracts/mint-policy.json', 'utf8'));
const fail = (m) => { throw new Error(m); };

if (p.network !== 'mainnet') fail('network must be mainnet');
if (p.displayPrice !== '7 GRAM (TON)') fail('display price mismatch');
if (p.settlementCurrency !== 'TON') fail('settlement currency must remain TON');
if (p.priceNanoTon !== 7_000_000_000) fail('mint price must be exactly 7 TON');
if (p.supply !== 10_000) fail('supply must be 10000');
if (p.maxPerTransaction !== 50) fail('max per transaction must be 50');
if (p.lifetimeWalletLimit !== null) fail('there must be no lifetime wallet limit');
if (p.royaltyBps !== 700) fail('royalty must be 7%');
if (p.treasuryAddress !== p.royaltyAddress) fail('treasury/royalty recipient mismatch');
if (!/^UQ[A-Za-z0-9_-]+$/.test(p.treasuryAddress)) fail('unexpected treasury address format');
if (p.revealDate !== '2026-10-07') fail('reveal date mismatch');
if (!p.preRevealImageCid.startsWith('baf')) fail('missing image CID');
if (!p.preRevealMetadataCid.startsWith('baf')) fail('missing metadata CID');
if (p.publicMintPausedByDefault !== true) fail('mint must start paused');
if (p.demoModeUntilTestnetVerified !== true) fail('testnet deployment gate must remain enabled');

const config = fs.readFileSync('config.js', 'utf8');
for (const expected of [
  "priceTon: 7",
  "supply: 10000",
  "royaltyPercent: 7",
  "maxPerTransaction: 50",
  "collectionAddress: ''",
  "mintContractAddress: ''",
  "demoMode: true"
]) {
  if (!config.includes(expected)) fail(`site config safety mismatch: ${expected}`);
}
console.log('CoolBears mint policy: OK');
