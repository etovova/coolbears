import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileFunc } from '@ton-community/func-js';
import { Blockchain } from '@ton/sandbox';
import { beginCell, Cell, contractAddress, SendMode, toNano } from '@ton/core';

const TON_ROOT = '/tmp/token-contract';
const COLLECTION_SRC = 'contracts/src/coolbears-collection-mint.fc';
const OP_MINT = 0x52535630;
const OP_EDIT_CONTENT = 4;
const SELF = fileURLToPath(import.meta.url);

async function compileCollectionOutput() {
  const result = await compileFunc({ targets: ['coolbears-collection-mint.fc'], sources: {
    'stdlib.fc': fs.readFileSync(`${TON_ROOT}/stdlib.fc`, 'utf8'),
    'coolbears-collection-mint.fc': fs.readFileSync(COLLECTION_SRC, 'utf8'),
  }});
  if (result.status === 'error') throw new Error(result.message);
  console.log(`COMPILED_BOC ${result.codeBoc}`);
}
async function compileItemOutput() {
  const result = await compileFunc({ targets: ['stdlib.fc', 'params.fc', 'op-codes.fc', 'nft-item.fc'], sources: {
    'stdlib.fc': fs.readFileSync(`${TON_ROOT}/stdlib.fc`, 'utf8'),
    'params.fc': fs.readFileSync(`${TON_ROOT}/nft/params.fc`, 'utf8'),
    'op-codes.fc': fs.readFileSync(`${TON_ROOT}/nft/op-codes.fc`, 'utf8'),
    'nft-item.fc': fs.readFileSync(`${TON_ROOT}/nft/nft-item.fc`, 'utf8'),
  }});
  if (result.status === 'error') throw new Error(result.message);
  console.log(`COMPILED_BOC ${result.codeBoc}`);
}
function compileFresh(mode) {
  const child = spawnSync(process.execPath, [SELF], { encoding: 'utf8', env: { ...process.env, COOLBEARS_REVEAL_COMPILE: mode } });
  if (child.stderr) process.stderr.write(child.stderr);
  assert.equal(child.status, 0, `${mode} compiler subprocess failed`);
  const line = child.stdout.split('\n').find((x) => x.startsWith('COMPILED_BOC '));
  assert.ok(line, `Missing ${mode} compiler output`);
  return Cell.fromBoc(Buffer.from(line.slice('COMPILED_BOC '.length), 'base64'))[0];
}
if (process.env.COOLBEARS_REVEAL_COMPILE === 'collection') { await compileCollectionOutput(); process.exit(0); }
if (process.env.COOLBEARS_REVEAL_COMPILE === 'item') { await compileItemOutput(); process.exit(0); }

function makeContent(commonPrefix) {
  const collectionContent = beginCell().storeUint(1, 8).storeStringTail('ipfs://collection.json').endCell();
  const commonContent = beginCell().storeStringTail(commonPrefix).endCell();
  return beginCell().storeRef(collectionContent).storeRef(commonContent).endCell();
}
function makeRoyalty(address) { return beginCell().storeUint(7, 16).storeUint(100, 16).storeAddress(address).endCell(); }
function collectionData(owner, treasury, itemCode) {
  return beginCell().storeAddress(owner).storeUint(0, 64).storeRef(makeContent('ipfs://PRE_REVEAL_ROOT/'))
    .storeRef(itemCode).storeRef(makeRoyalty(treasury)).storeAddress(treasury).storeUint(0, 1).endCell();
}
class Collection {
  constructor(address, init) { this.address = address; this.init = init; }
  static create(owner, treasury, code, itemCode) { const init = { code, data: collectionData(owner, treasury, itemCode) }; return new Collection(contractAddress(0, init), init); }
  async sendDeploy(provider, via) { return provider.internal(via, { value: toNano('0.2'), sendMode: SendMode.PAY_GAS_SEPARATELY, body: beginCell().endCell() }); }
  async sendMint(provider, via) { return provider.internal(via, { value: toNano('7.05'), sendMode: SendMode.PAY_GAS_SEPARATELY, body: beginCell().storeUint(OP_MINT, 32).storeUint(0, 64).storeUint(1, 8).endCell() }); }
  async sendContentUpdate(provider, via, prefix, treasury) { return provider.internal(via, { value: toNano('0.1'), sendMode: SendMode.PAY_GAS_SEPARATELY, body: beginCell().storeUint(OP_EDIT_CONTENT, 32).storeUint(0, 64).storeRef(makeContent(prefix)).storeRef(makeRoyalty(treasury)).endCell() }); }
  async getCollectionData(provider) { const r = await provider.get('get_collection_data', []); return { next: r.stack.readBigNumber(), collectionContent: r.stack.readCell(), owner: r.stack.readAddress() }; }
  async getNftAddress(provider, index) { const r = await provider.get('get_nft_address_by_index', [{ type: 'int', value: BigInt(index) }]); return r.stack.readAddress(); }
  async getNftContent(provider, index, individualContent) { const r = await provider.get('get_nft_content', [{ type: 'int', value: BigInt(index) }, { type: 'cell', cell: individualContent }]); return r.stack.readCell(); }
  async getRoyalty(provider) { const r = await provider.get('royalty_params', []); return { factor: r.stack.readBigNumber(), base: r.stack.readBigNumber(), address: r.stack.readAddress() }; }
}
class NftItem {
  constructor(address) { this.address = address; }
  async getData(provider) { const r = await provider.get('get_nft_data', []); return { initialized: r.stack.readBigNumber(), index: r.stack.readBigNumber(), collection: r.stack.readAddress(), owner: r.stack.readAddress(), content: r.stack.readCell() }; }
}
function parseOffchainContent(cell) {
  const s = cell.beginParse();
  assert.equal(s.loadUint(8), 1);
  assert.equal(s.remainingBits % 8, 0);
  const prefix = s.loadBuffer(s.remainingBits / 8).toString('utf8');
  assert.equal(s.remainingRefs, 1);
  const suffix = s.loadRef().beginParse().loadStringTail();
  return { prefix, suffix, uri: prefix + suffix };
}

const collectionCode = compileFresh('collection');
const itemCode = compileFresh('item');
const blockchain = await Blockchain.create();
const revealAt = 1798761600;
blockchain.now = revealAt - 86400;
const owner = await blockchain.treasury('owner-reveal');
const treasury = await blockchain.treasury('treasury-reveal');
const buyer = await blockchain.treasury('buyer-reveal');
const attacker = await blockchain.treasury('attacker-reveal');
const collection = blockchain.openContract(Collection.create(owner.address, treasury.address, collectionCode, itemCode));
await collection.sendDeploy(owner.getSender());
await collection.sendMint(treasury.getSender());

const nftAddressBefore = await collection.getNftAddress(0);
const nft = blockchain.openContract(new NftItem(nftAddressBefore));
const before = await nft.getData();
assert.equal(before.index, 0n);
assert.equal(before.owner.toString(), treasury.address.toString());
assert.equal(before.content.beginParse().loadStringTail(), '0000.json');
let resolved = parseOffchainContent(await collection.getNftContent(0, before.content));
assert.equal(resolved.prefix, 'ipfs://PRE_REVEAL_ROOT/');
assert.equal(resolved.suffix, '0000.json');
assert.equal(resolved.uri, 'ipfs://PRE_REVEAL_ROOT/0000.json');

await collection.sendContentUpdate(attacker.getSender(), 'ipfs://ATTACKER_ROOT/', treasury.address);
let data = await collection.getCollectionData();
assert.equal(data.next, 1n);
assert.equal(data.owner.toString(), owner.address.toString());
resolved = parseOffchainContent(await collection.getNftContent(0, before.content));
assert.equal(resolved.prefix, 'ipfs://PRE_REVEAL_ROOT/');
assert.equal(resolved.uri, 'ipfs://PRE_REVEAL_ROOT/0000.json');

// The owner cannot reveal even one second before the deadline.
blockchain.now = revealAt - 1;
const early = await collection.sendContentUpdate(owner.getSender(), 'ipfs://FINAL_METADATA_ROOT/', attacker.address);
assert.ok(early.transactions.some(tx => tx.inMessage?.info.type === 'internal' && tx.inMessage.info.dest.equals(collection.address) && tx.description.type === 'generic' && tx.description.computePhase.type === 'vm' && tx.description.computePhase.exitCode === 704));
resolved = parseOffchainContent(await collection.getNftContent(0, before.content));
assert.equal(resolved.uri, 'ipfs://PRE_REVEAL_ROOT/0000.json');
assert.equal((await collection.getRoyalty()).address.toString(), treasury.address.toString());
blockchain.now = revealAt;
await collection.sendContentUpdate(attacker.getSender(), 'ipfs://ATTACKER_ROOT/', attacker.address);
assert.equal(parseOffchainContent(await collection.getNftContent(0, before.content)).uri, 'ipfs://PRE_REVEAL_ROOT/0000.json');
await collection.sendContentUpdate(owner.getSender(), 'ipfs://FINAL_METADATA_ROOT/', treasury.address);
resolved = parseOffchainContent(await collection.getNftContent(0, before.content));
assert.equal(resolved.prefix, 'ipfs://FINAL_METADATA_ROOT/');
assert.equal(resolved.suffix, '0000.json');
assert.equal(resolved.uri, 'ipfs://FINAL_METADATA_ROOT/0000.json');

const nftAddressAfter = await collection.getNftAddress(0);
assert.equal(nftAddressAfter.toString(), nftAddressBefore.toString());
const after = await nft.getData();
assert.equal(after.index, before.index);
assert.equal(after.collection.toString(), before.collection.toString());
assert.equal(after.owner.toString(), before.owner.toString());
assert.equal(after.content.beginParse().loadStringTail(), '0000.json');
const royalty = await collection.getRoyalty();
assert.equal(royalty.factor, 7n);
assert.equal(royalty.base, 100n);
assert.equal(royalty.address.toString(), treasury.address.toString());
console.log('CoolBears reveal Sandbox test: attacker blocked; owner switches root; same NFT resolves final metadata');
