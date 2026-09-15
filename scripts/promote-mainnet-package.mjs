import fs from 'node:fs';
import path from 'node:path';
import { Address, Cell, contractAddress, loadStateInit } from '@ton/core';

const sourcePath = process.env.SOURCE_PACKAGE || 'testnet/creator/deployment.json';
const outPath = process.env.OUT_PACKAGE || 'build/mainnet-release/deployment.json';
const p = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

function assert(cond, message) { if (!cond) throw new Error(message); }
assert(p.network === 'testnet', 'Source package must be testnet');
assert(p.initialPaused === true, 'Source package must start paused');
assert(Number(p.nextItemIndex) === 0, 'Source package must start at index 0');
assert(Number(p.priceNanoTon) === 7000000000, 'Unexpected mint price');
assert(Number(p.supply) === 10000, 'Unexpected supply');
assert(Number(p.maxPerTransaction) === 50, 'Unexpected max per transaction');
assert(Number(p.royaltyBps) === 700, 'Unexpected royalty');
assert(Number(p.revealAt) === 1798761600, 'Unexpected reveal timestamp');
assert(p.revealAtUtc === '2027-01-01T00:00:00Z', 'Unexpected reveal UTC');
assert(p.creatorReservation?.tokenIndex === 0, 'Creator reservation must be token 0');
assert(p.creatorReservation?.beneficiaryAddressRaw === p.treasuryAddressRaw, 'Creator beneficiary must equal treasury');
assert(p.tonConnectCreatorClaimRequest?.network === '-3', 'Source claim must be testnet');
assert(p.tonConnectCreatorClaimRequest?.messages?.length === 1, 'Source claim must have one message');
assert(p.tonConnectCreatorClaimRequest.messages[0].amount === '7100000000', 'Unexpected creator claim amount');

const init = loadStateInit(Cell.fromBase64(p.stateInitBocBase64).beginParse());
assert(init.code && init.data, 'Invalid StateInit');
const actual = contractAddress(0, init);
assert(actual.toRawString() === p.collectionAddressRaw, 'StateInit address mismatch');
if (p.collectionCodeHash) assert(init.code.hash().toString('hex') === p.collectionCodeHash, 'Collection code hash mismatch');

const owner = Address.parse(p.ownerAddressRaw);
const treasury = Address.parse(p.treasuryAddressRaw);
assert(owner.toRawString() === p.ownerAddressRaw, 'Owner parse mismatch');
assert(treasury.toRawString() === p.treasuryAddressRaw, 'Treasury parse mismatch');

const mainnetBounceable = actual.toString({ bounceable: true, testOnly: false });
const mainnetNonBounceable = actual.toString({ bounceable: false, testOnly: false });
const ownerMainnet = owner.toString({ bounceable: false, testOnly: false });
const treasuryMainnet = treasury.toString({ bounceable: false, testOnly: false });

const out = {
  ...p,
  network: 'mainnet',
  promotedFromVerifiedTestnetPackage: sourcePath,
  sourceTestnetCollectionAddress: p.collectionAddressTestnetNonBounceable,
  ownerAddressMainnetFriendly: ownerMainnet,
  treasuryAddressMainnetFriendly: treasuryMainnet,
  collectionAddressMainnetBounceable: mainnetBounceable,
  collectionAddressMainnetNonBounceable: mainnetNonBounceable,
  tonConnectCreatorClaimRequest: {
    ...p.tonConnectCreatorClaimRequest,
    network: '-239',
    from: p.treasuryAddressRaw,
    messages: [{
      ...p.tonConnectCreatorClaimRequest.messages[0],
      address: mainnetBounceable,
    }],
  },
  tonConnectDeployMessage: {
    ...p.tonConnectDeployMessage,
    address: mainnetNonBounceable,
  },
};

delete out.collectionAddressTestnetBounceable;
delete out.collectionAddressTestnetNonBounceable;
delete out.ownerAddressTestnetFriendly;
delete out.treasuryAddressTestnetFriendly;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(`COOLBEARS_MAINNET_ADDRESS=${mainnetNonBounceable}`);
console.log(`COOLBEARS_MAINNET_BOUNCEABLE=${mainnetBounceable}`);
console.log('CoolBears tested package promoted to mainnet: OK');
