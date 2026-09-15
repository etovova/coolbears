import fs from 'node:fs';
import assert from 'node:assert/strict';
import { compileFunc } from '@ton-community/func-js';
import { Blockchain } from '@ton/sandbox';
import { beginCell, Cell, contractAddress, SendMode, toNano } from '@ton/core';

const COLLECTION_SRC = 'contracts/src/coolbears-collection-mint.fc';
const TON_ROOT = '/tmp/token-contract';
const OP_MINT = 0x4d494e54;
const OP_PAUSE = 0x50415553;
const OP_UNPAUSE = 0x554e5053;
const OP_NFT_TRANSFER = 0x5fcc3d14;
const OP_GET_ROYALTY = 0x693d3950;
const OP_REPORT_ROYALTY = 0xa8cb00ad;

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

function collectionData(owner, treasury, itemCode, nextIndex = 0, paused = 0) {
  const collectionContent = beginCell().storeUint(1, 8).storeStringTail('ipfs://collection.json').endCell();
  const commonContent = beginCell().storeStringTail('ipfs://PRE_REVEAL_ROOT/').endCell();
  const content = beginCell().storeRef(collectionContent).storeRef(commonContent).endCell();
  const royalty = beginCell().storeUint(7, 16).storeUint(100, 16).storeAddress(treasury).endCell();
  return beginCell()
    .storeAddress(owner)
    .storeUint(nextIndex, 64)
    .storeRef(content)
    .storeRef(itemCode)
    .storeRef(royalty)
    .storeAddress(treasury)
    .storeUint(paused, 1)
    .endCell();
}

class CoolBearsCollection {
  constructor(address, init) {
    this.address = address;
    this.init = init;
  }
  static create(owner, treasury, code, itemCode, nextIndex = 0, paused = 0) {
    const init = { code, data: collectionData(owner, treasury, itemCode, nextIndex, paused) };
    return new CoolBearsCollection(contractAddress(0, init), init);
  }
  async sendDeploy(provider, via) {
    return provider.internal(via, {
      value: toNano('0.2'),
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().endCell(),
    });
  }
  async sendMint(provider, via, count, value) {
    return provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().storeUint(OP_MINT, 32).storeUint(0, 64).storeUint(count, 8).endCell(),
    });
  }
  async sendReserved(provider, via, value = toNano('7.05')) {
    return provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().storeUint(0x52535630,32).storeUint(0,64).endCell() });
  }
  async sendAdmin(provider, via, op) {
    return provider.internal(via, {
      value: toNano('0.1'),
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().storeUint(op, 32).storeUint(0, 64).endCell(),
    });
  }
  async sendRoyaltyQuery(provider, via, queryId) {
    return provider.internal(via, {
      value: toNano('0.05'),
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().storeUint(OP_GET_ROYALTY, 32).storeUint(queryId, 64).endCell(),
    });
  }
  async getMintState(provider) {
    const result = await provider.get('get_mint_state', []);
    return {
      next: result.stack.readBigNumber(),
      supply: result.stack.readBigNumber(),
      price: result.stack.readBigNumber(),
      paused: result.stack.readBigNumber(),
    };
  }
  async getRoyalty(provider) {
    const result = await provider.get('royalty_params', []);
    return {
      factor: result.stack.readBigNumber(),
      base: result.stack.readBigNumber(),
      address: result.stack.readAddress(),
    };
  }
  async getNftAddress(provider, index) {
    const result = await provider.get('get_nft_address_by_index', [{ type: 'int', value: BigInt(index) }]);
    return result.stack.readAddress();
  }
}

class NftItem {
  constructor(address) {
    this.address = address;
  }
  async sendTransfer(provider, via, newOwner) {
    return provider.internal(via, {
      value: toNano('0.1'),
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OP_NFT_TRANSFER, 32)
        .storeUint(0, 64)
        .storeAddress(newOwner)
        .storeAddress(null)
        .storeBit(0)
        .storeCoins(0)
        .storeBit(0)
        .endCell(),
    });
  }
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
const owner = await blockchain.treasury('owner');
const treasury = await blockchain.treasury('treasury');
const buyer = await blockchain.treasury('buyer');
const recipient = await blockchain.treasury('recipient');
const attacker = await blockchain.treasury('attacker');

const collection = blockchain.openContract(
  CoolBearsCollection.create(owner.address, treasury.address, collectionCode, itemCode),
);

await collection.sendDeploy(owner.getSender());
let state = await collection.getMintState();
assert.equal(state.next, 0n);
assert.equal(state.supply, 10000n);
assert.equal(state.price, 7000000000n);
assert.equal(state.paused, 0n);

const royalty = await collection.getRoyalty();
assert.equal(royalty.factor, 7n);
assert.equal(royalty.base, 100n);
assert.equal(royalty.address.toString(), treasury.address.toString());

// Standard royalty query is message-based and must be available to any sender,
// not only the collection owner. Verify the actual report_royalty_params reply.
const royaltyQueryId = 0x1234n;
const royaltyQueryResult = await collection.sendRoyaltyQuery(attacker.getSender(), royaltyQueryId);
const royaltyResponseTx = royaltyQueryResult.transactions.find((tx) => {
  const msg = tx.inMessage;
  return msg?.info?.type === 'internal'
    && msg.info.src?.toString() === collection.address.toString()
    && msg.info.dest?.toString() === attacker.address.toString();
});
assert.ok(royaltyResponseTx, 'Royalty query must produce a response transaction to the requester');
const royaltyBody = royaltyResponseTx.inMessage.body.beginParse();
assert.equal(royaltyBody.loadUint(32), OP_REPORT_ROYALTY);
assert.equal(royaltyBody.loadUintBig(64), royaltyQueryId);
assert.equal(royaltyBody.loadUint(16), 7);
assert.equal(royaltyBody.loadUint(16), 100);
assert.equal(royaltyBody.loadAddress().toString(), treasury.address.toString());
state = await collection.getMintState();
assert.equal(state.next, 0n);
assert.equal(state.paused, 0n);

// Public mint cannot consume token zero even when unpaused.
function rejected(result, code) {
  assert.ok(result.transactions.some(tx => tx.inMessage?.info.type === 'internal' && tx.inMessage.info.dest.equals(collection.address) && tx.description.type === 'generic' && tx.description.computePhase.type === 'vm' && tx.description.computePhase.exitCode === code));
}
rejected(await collection.sendMint(buyer.getSender(), 1, toNano('7.05')),705);
rejected(await collection.sendReserved(attacker.getSender()),706);
rejected(await collection.sendReserved(owner.getSender()),706);
rejected(await collection.sendReserved(treasury.getSender(),toNano('7.049')),703);
assert.equal((await collection.getMintState()).next,0n);
await collection.sendAdmin(owner.getSender(), OP_PAUSE);
await collection.sendReserved(treasury.getSender());
assert.equal((await collection.getMintState()).paused,1n);
rejected(await collection.sendReserved(treasury.getSender()),707);
await collection.sendAdmin(owner.getSender(), OP_UNPAUSE);
state = await collection.getMintState();
assert.equal(state.next, 1n);

const nft0Address = await collection.getNftAddress(0);
const nft0 = blockchain.openContract(new NftItem(nft0Address));
let nft0Data = await nft0.getData();
assert.equal(nft0Data.initialized, -1n);
assert.equal(nft0Data.index, 0n);
assert.equal(nft0Data.collection.toString(), collection.address.toString());
assert.equal(nft0Data.owner.toString(), treasury.address.toString());
assert.equal(nft0Data.content.beginParse().loadStringTail(), '0000.json');

// Pre-reveal transfer uses the official TON NFT transfer opcode. The same NFT,
// collection link, index and metadata suffix remain intact while ownership changes.
await nft0.sendTransfer(treasury.getSender(), recipient.address);
nft0Data = await nft0.getData();
assert.equal(nft0Data.initialized, -1n);
assert.equal(nft0Data.index, 0n);
assert.equal(nft0Data.collection.toString(), collection.address.toString());
assert.equal(nft0Data.owner.toString(), recipient.address.toString());
assert.equal(nft0Data.content.beginParse().loadStringTail(), '0000.json');
assert.equal((await collection.getNftAddress(0)).toString(), nft0Address.toString());

// Same wallet may mint again: there is no lifetime wallet cap.
await collection.sendMint(buyer.getSender(), 1, toNano('7.05'));
state = await collection.getMintState();
assert.equal(state.next, 2n);

// Underpayment must not mint.
await collection.sendMint(buyer.getSender(), 2, toNano('14.099999999'));
state = await collection.getMintState();
assert.equal(state.next, 2n);

// More than 50 in one request must not mint.
await collection.sendMint(buyer.getSender(), 51, toNano('359.55'));
state = await collection.getMintState();
assert.equal(state.next, 2n);

// Non-owner cannot pause.
await collection.sendAdmin(attacker.getSender(), OP_PAUSE);
state = await collection.getMintState();
assert.equal(state.paused, 0n);

// Owner can pause; paused mint does not advance supply.
await collection.sendAdmin(owner.getSender(), OP_PAUSE);
state = await collection.getMintState();
assert.equal(state.paused, 1n);
await collection.sendMint(buyer.getSender(), 1, toNano('7.05'));
state = await collection.getMintState();
assert.equal(state.next, 2n);

// Owner can unpause and mint resumes.
await collection.sendAdmin(owner.getSender(), OP_UNPAUSE);
state = await collection.getMintState();
assert.equal(state.paused, 0n);
await collection.sendMint(buyer.getSender(), 1, toNano('7.05'));
state = await collection.getMintState();
assert.equal(state.next, 3n);

// Boundary collection: mint exactly the final 50 tokens, from #9950 through #9999.
const edgeCollection = blockchain.openContract(
  CoolBearsCollection.create(owner.address, treasury.address, collectionCode, itemCode, 9950, 0),
);
await edgeCollection.sendDeploy(owner.getSender());
let edgeState = await edgeCollection.getMintState();
assert.equal(edgeState.next, 9950n);

await edgeCollection.sendMint(buyer.getSender(), 50, toNano('352.5'));
edgeState = await edgeCollection.getMintState();
assert.equal(edgeState.next, 10000n);

const nft9999Address = await edgeCollection.getNftAddress(9999);
const nft9999 = blockchain.openContract(new NftItem(nft9999Address));
const nft9999Data = await nft9999.getData();
assert.equal(nft9999Data.index, 9999n);
assert.equal(nft9999Data.owner.toString(), buyer.address.toString());
assert.equal(nft9999Data.content.beginParse().loadStringTail(), '9999.json');

// Sold out means no token #10000 can ever be minted.
await edgeCollection.sendMint(buyer.getSender(), 1, toNano('7.05'));
edgeState = await edgeCollection.getMintState();
assert.equal(edgeState.next, 10000n);

console.log('CoolBears TON Sandbox boundary + royalty message + metadata + transfer tests: OK');
