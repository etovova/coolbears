import fs from 'node:fs';
import { compileFunc } from '@ton-community/func-js';
import { Address, beginCell, Cell, contractAddress, storeStateInit, toNano } from '@ton/core';

const TON_ROOT = '/tmp/token-contract';
const COLLECTION_SRC = 'contracts/src/coolbears-collection-mint.fc';
const policy = JSON.parse(fs.readFileSync('contracts/mint-policy.json', 'utf8'));

const ownerText = process.env.OWNER_ADDRESS || policy.treasuryAddress;
const owner = Address.parse(ownerText);
const treasury = Address.parse(policy.treasuryAddress);
if (!treasury.equals(Address.parse(policy.creatorReservation.beneficiaryAddress))) throw Error('Creator beneficiary differs from immutable treasury');

async function compileCollection() {
  const r = await compileFunc({
    targets: ['coolbears-collection-mint.fc'],
    sources: {
      'stdlib.fc': fs.readFileSync(`${TON_ROOT}/stdlib.fc`, 'utf8'),
      'coolbears-collection-mint.fc': fs.readFileSync(COLLECTION_SRC, 'utf8'),
    },
  });
  if (r.status === 'error') throw new Error(r.message);
  return Cell.fromBoc(Buffer.from(r.codeBoc, 'base64'))[0];
}

async function compileOfficialItem() {
  const r = await compileFunc({
    targets: ['stdlib.fc', 'params.fc', 'op-codes.fc', 'nft-item.fc'],
    sources: {
      'stdlib.fc': fs.readFileSync(`${TON_ROOT}/stdlib.fc`, 'utf8'),
      'params.fc': fs.readFileSync(`${TON_ROOT}/nft/params.fc`, 'utf8'),
      'op-codes.fc': fs.readFileSync(`${TON_ROOT}/nft/op-codes.fc`, 'utf8'),
      'nft-item.fc': fs.readFileSync(`${TON_ROOT}/nft/nft-item.fc`, 'utf8'),
    },
  });
  if (r.status === 'error') throw new Error(r.message);
  return Cell.fromBoc(Buffer.from(r.codeBoc, 'base64'))[0];
}

const collectionCode = await compileCollection();
const itemCode = await compileOfficialItem();

const collectionContent = beginCell()
  .storeUint(1, 8)
  .storeStringTail(policy.collectionMetadataIpfs)
  .endCell();
const commonContent = beginCell()
  .storeStringTail(policy.preRevealMetadataRootIpfs)
  .endCell();
const content = beginCell()
  .storeRef(collectionContent)
  .storeRef(commonContent)
  .endCell();
const royalty = beginCell()
  .storeUint(7, 16)
  .storeUint(100, 16)
  .storeAddress(treasury)
  .endCell();
const data = beginCell()
  .storeAddress(owner)
  .storeUint(0, 64)
  .storeRef(content)
  .storeRef(itemCode)
  .storeRef(royalty)
  .storeAddress(treasury)
  .storeUint(1, 1)
  .endCell();

const init = { code: collectionCode, data };
const address = contractAddress(0, init);
const stateInitCell = beginCell().store(storeStateInit(init)).endCell();
const stateInitB64 = stateInitCell.toBoc().toString('base64');
const emptyBodyB64 = beginCell().endCell().toBoc().toString('base64');
const deploymentAmount = toNano('0.2');

fs.mkdirSync('build/testnet-deployment', { recursive: true });
const out = {
  network: 'testnet',
  ownerAddressRaw: owner.toRawString(),
  ownerAddressMainnetFriendly: owner.toString({ bounceable: false, testOnly: false }),
  ownerAddressTestnetFriendly: owner.toString({ bounceable: false, testOnly: true }),
  treasuryAddressRaw: treasury.toRawString(),
  treasuryAddressMainnetFriendly: treasury.toString({ bounceable: false, testOnly: false }),
  treasuryAddressTestnetFriendly: treasury.toString({ bounceable: false, testOnly: true }),
  collectionAddressRaw: address.toRawString(),
  collectionAddressTestnetBounceable: address.toString({ bounceable: true, testOnly: true }),
  collectionAddressTestnetNonBounceable: address.toString({ bounceable: false, testOnly: true }),
  creatorReservation: { tokenIndex: 0, beneficiaryAddressRaw: treasury.toRawString(), opcode: '0x52535630' },
  tonConnectCreatorClaimRequest: {
    network: '-3', from: treasury.toRawString(),
    messages: [{address: address.toString({bounceable:true,testOnly:true}),amount:'7100000000',payload:beginCell().storeUint(0x52535630,32).storeUint(0,64).endCell().toBoc().toString('base64')}]
  },
  initialPaused: true,
  nextItemIndex: 0,
  priceNanoTon: policy.priceNanoTon,
  displayPrice: policy.displayPrice,
  maxPerTransaction: policy.maxPerTransaction,
  supply: policy.supply,
  royaltyBps: policy.royaltyBps,
  collectionMetadataIpfs: policy.collectionMetadataIpfs,
  preRevealMetadataRootIpfs: policy.preRevealMetadataRootIpfs,
  deployValueNanoTon: deploymentAmount.toString(),
  stateInitBocBase64: stateInitB64,
  deployBodyBocBase64: emptyBodyB64,
  tonConnectDeployMessage: {
    address: address.toString({ bounceable: false, testOnly: true }),
    amount: deploymentAmount.toString(),
    stateInit: stateInitB64,
    payload: emptyBodyB64
  }
};
fs.writeFileSync('build/testnet-deployment/deployment.json', JSON.stringify(out, null, 2) + '\n');
fs.writeFileSync('build/testnet-deployment/stateinit.boc', stateInitCell.toBoc());
fs.writeFileSync('build/testnet-deployment/collection-code.boc', collectionCode.toBoc());
fs.writeFileSync('build/testnet-deployment/nft-item-code.boc', itemCode.toBoc());

console.log(`COOLBEARS_TESTNET_ADDRESS=${out.collectionAddressTestnetNonBounceable}`);
console.log('CoolBears deterministic testnet deployment package: OK');
