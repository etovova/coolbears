import fs from 'node:fs';
import assert from 'node:assert/strict';
import { compileFunc } from '@ton-community/func-js';
import { Blockchain } from '@ton/sandbox';
import { beginCell, Cell, contractAddress, SendMode, toNano } from '@ton/core';

const TON_ROOT = '/tmp/token-contract';
const COLLECTION_SRC = 'contracts/src/coolbears-collection-mint.fc';
const OP_MINT = 0x4d494e54;
const OP_EDIT_CONTENT = 4;

async function compileCollection() {
  const result = await compileFunc({
    targets: ['coolbears-collection-mint.fc'],
    sources: {
      'stdlib.fc': fs.readFileSync(`${TON_ROOT}/stdlib.fc`, 'utf8'),
      'coolbears-collection-mint.fc': fs.readFileSync(COLLECTION_SRC, 'utf8'),
    },
  });
  if (result.status === 'error') throw new Error(result.message);
  return Cell.fromBoc(Buffer.from(result.codeBoc, 'base64'))[0];
}

async function compileOfficialItem() {
  const result = await compileFunc({
    targets: ['stdlib.fc', 'params.fc', 'op-codes.fc', 'nft-item.fc'],
    sources: {
      'stdlib.fc': fs.readFileSync(`${TON_ROOT}/stdlib.fc`, 'utf8'),
      'params.fc': fs.readFileSync(`${TON_ROOT}/nft/params.fc`, 'utf8'),
      'op-codes.fc': fs.readFileSync(`${TON_ROOT}/nft/op-codes.fc`, 'utf8'),
      'nft-item.fc': fs.readFileSync(`${TON_ROOT}/nft/nft-item.fc`, 'utf8'),
    },
  });
  if (result.status === 'error') throw new Error(result.message);
  return Cell.fromBoc(Buffer.from(result.codeBoc, 'base64'))[0];
}

function makeContent(commonPrefix) {
  const collectionContent = beginCell().storeUint(1, 8).storeStringTail('ipfs://collection.json').endCell();
  const commonContent = beginCell().storeStringTail(commonPrefix).endCell();
  return beginCell().storeRef(collectionContent).storeRef(commonContent).endCell();
}

function makeRoyalty(address) {
  return beginCell().storeUint(7, 16).storeUint(100, 16).storeAddress(address).endCell();
}

function collectionData(owner, treasury, itemCode) {
  return beginCell()
    .storeAddress(owner)
    .storeUint(0, 64)
    .storeRef(makeContent('ipfs://PRE_REVEAL_ROOT/'))
    .storeRef(itemCode)
    .storeRef(makeRoyalty(treasury))
    .storeAddress(treasury)
    .storeUint(0, 1)
    .endCell();
}

class Collection {
  constructor(address, init) { this.address = address; this.init = init; }
  static create(owner, treasury, code, itemCode) {
    const init = { code, data: collectionData(owner, treasury, itemCode) };
    return new Collection(contractAddress(0, init), init);
  }
  async sendDeploy(provider, via) {
    return provider.internal(via, {
      value: toNano('0.2'),
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().endCell(),
    });
  }
  async sendMint(provider, via) {
    return provider.internal(via, {
      value: toNano('7.05'),
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().storeUint(OP_MINT, 32).storeUint(0, 64).storeUint(1, 8).endCell(),
    });
  }
  async sendContentUpdate(provider, via, prefix, treasury) {
    return provider.internal(via, {
      value: toNano('0.1'),
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OP_EDIT_CONTENT, 32)
        .storeUint(0, 64)
        .storeRef(makeContent(prefix))
        .storeRef(makeRoyalty(treasury))
        .endCell(),
    });
  }
  async getCollectionData(provider) {
    const result = await provider.get('get_collection_data', []);
    return {
      next: result.stack.readBigNumber(),
      collectionContent: result.stack.readCell(),
      owner: result.stack.readAddress(),
    };
  }
  async getNftAddress(provider, index) {
    const result = await provider.get('get_nft_address_by_index', [{ type: 'int', value: BigInt(index) }]);
    return result.stack.readAddress();
  }
  async getRoyalty(provider) {
    const result = await provider.get('royalty_params', []);
    return {
      factor: result.stack.readBigNumber(),
      base: result.stack.readBigNumber(),
      address: result.stack.readAddress(),
    };
  }
}

class NftItem {
  constructor(address) { this.address = address; }
  async getData(provider) {
    const result = await provider.get('get_nft_data', []);
    return {
      initialized: result.stack.readBigNumber(),
      index: result.stack.readBigNumber(),
      collection: result.stack.readAddress(),
      owner: result.stack.readAddress(),
      content: result.stack.readCell(),
    };
  }
}

const collectionCode = await compileCollection();
const itemCode = await compileOfficialItem();
const blockchain = await Blockchain.create();
const owner = await blockchain.treasury('owner-reveal');
const treasury = await blockchain.treasury('treasury-reveal');
const buyer = await blockchain.treasury('buyer-reveal');
const attacker = await blockchain.treasury('attacker-reveal');

const collection = blockchain.openContract(Collection.create(owner.address, treasury.address, collectionCode, itemCode));
await collection.sendDeploy(owner.getSender());
await collection.sendMint(buyer.getSender());

const nftAddressBefore = await collection.getNftAddress(0);
const nft = blockchain.openContract(new NftItem(nftAddressBefore));
const before = await nft.getData();
assert.equal(before.index, 0n);
assert.equal(before.owner.toString(), buyer.address.toString());
assert.equal(before.content.beginParse().loadStringTail(), '0000.json');

// A non-owner must not be able to change the reveal prefix.
await collection.sendContentUpdate(attacker.getSender(), 'ipfs://ATTACKER_ROOT/', treasury.address);
let data = await collection.getCollectionData();
assert.equal(data.next, 1n);
assert.equal(data.owner.toString(), owner.address.toString());

// The owner performs reveal by changing only collection/common content.
await collection.sendContentUpdate(owner.getSender(), 'ipfs://FINAL_METADATA_ROOT/', treasury.address);

const nftAddressAfter = await collection.getNftAddress(0);
assert.equal(nftAddressAfter.toString(), nftAddressBefore.toString());
const after = await nft.getData();
assert.equal(after.index, before.index);
assert.equal(after.owner.toString(), before.owner.toString());
assert.equal(after.content.beginParse().loadStringTail(), '0000.json');

const royalty = await collection.getRoyalty();
assert.equal(royalty.factor, 7n);
assert.equal(royalty.base, 100n);
assert.equal(royalty.address.toString(), treasury.address.toString());

console.log('CoolBears reveal Sandbox test: same NFT survives owner-only metadata root change');
