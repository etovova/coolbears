import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileFunc } from '@ton-community/func-js';
import { Blockchain } from '@ton/sandbox';
import { beginCell, Cell, contractAddress, SendMode, toNano } from '@ton/core';

const TON_ROOT = '/tmp/token-contract';
const SRC_PATH = 'contracts/src/coolbears-collection-mint.fc';
const OP_MINT = 0x4d494e54;
const BASE_PRICE = toNano('7');
const SELF = fileURLToPath(import.meta.url);

async function compileItemToBase64() {
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
  console.log(`COMPILED_BOC ${result.codeBoc}`);
}

async function compileCollectionToBase64(deployValueNano) {
  const original = fs.readFileSync(SRC_PATH, 'utf8');
  const patched = original.replace(
    /const int COOLBEARS_DEPLOY_VALUE = \d+;/,
    `const int COOLBEARS_DEPLOY_VALUE = ${deployValueNano};`,
  );
  const result = await compileFunc({
    targets: ['coolbears-collection-mint.fc'],
    sources: {
      'stdlib.fc': fs.readFileSync(`${TON_ROOT}/stdlib.fc`, 'utf8'),
      'coolbears-collection-mint.fc': patched,
    },
  });
  if (result.status === 'error') throw new Error(result.message);
  console.log(`COMPILED_BOC ${result.codeBoc}`);
}

function compileInFreshProcess(mode, candidate = '') {
  const child = spawnSync(process.execPath, [SELF], {
    encoding: 'utf8',
    env: {
      ...process.env,
      COOLBEARS_COMPILE_MODE: mode,
      COOLBEARS_COMPILE_CANDIDATE: candidate,
    },
  });
  if (child.stderr) process.stderr.write(child.stderr);
  assert.equal(child.status, 0, `${mode} compiler subprocess failed${candidate ? ` for ${candidate}` : ''}`);
  const line = child.stdout.split('\n').find((x) => x.startsWith('COMPILED_BOC '));
  assert.ok(line, `Missing compiler output for ${mode}`);
  return Cell.fromBoc(Buffer.from(line.slice('COMPILED_BOC '.length), 'base64'))[0];
}

function data(owner, treasury, itemCode) {
  const collectionContent = beginCell().storeUint(1, 8).storeStringTail('ipfs://collection.json').endCell();
  const commonContent = beginCell().storeStringTail('ipfs://PRE_REVEAL_ROOT/').endCell();
  const content = beginCell().storeRef(collectionContent).storeRef(commonContent).endCell();
  const royalty = beginCell().storeUint(7, 16).storeUint(100, 16).storeAddress(treasury).endCell();
  return beginCell()
    .storeAddress(owner)
    .storeUint(0, 64)
    .storeRef(content)
    .storeRef(itemCode)
    .storeRef(royalty)
    .storeAddress(treasury)
    .storeUint(0, 1)
    .endCell();
}

class Collection {
  constructor(address, init) { this.address = address; this.init = init; }
  static create(owner, treasury, code, itemCode) {
    const init = { code, data: data(owner, treasury, itemCode) };
    return new Collection(contractAddress(0, init), init);
  }
  async sendDeploy(provider, via) {
    return provider.internal(via, {
      value: toNano('0.2'),
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().endCell(),
    });
  }
  async sendMint(provider, via, value) {
    return provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().storeUint(OP_MINT, 32).storeUint(0, 64).storeUint(1, 8).endCell(),
    });
  }
  async getNftAddress(provider, index) {
    const result = await provider.get('get_nft_address_by_index', [{ type: 'int', value: BigInt(index) }]);
    return result.stack.readAddress();
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

function sumFees(transactions) {
  let total = 0n;
  for (const tx of transactions ?? []) {
    const coins = tx?.totalFees?.coins;
    if (typeof coins === 'bigint') total += coins;
  }
  return total;
}

function txSummary(transactions) {
  return (transactions ?? []).map((tx) => ({
    account: tx.address?.toString?.() ?? null,
    lt: tx.lt?.toString?.() ?? null,
    success: tx.description?.computePhase?.success ?? null,
    exitCode: tx.description?.computePhase?.exitCode ?? null,
    actionSuccess: tx.description?.actionPhase?.success ?? null,
    totalFeesNano: tx.totalFees?.coins?.toString?.() ?? null,
  }));
}

const compileMode = process.env.COOLBEARS_COMPILE_MODE;
if (compileMode === 'item') {
  await compileItemToBase64();
  process.exit(0);
}
if (compileMode === 'collection') {
  await compileCollectionToBase64(BigInt(process.env.COOLBEARS_COMPILE_CANDIDATE));
  process.exit(0);
}

const itemCode = compileInFreshProcess('item');
const candidates = [10_000_000n, 15_000_000n, 20_000_000n, 25_000_000n, 30_000_000n, 35_000_000n, 40_000_000n, 45_000_000n, 50_000_000n];
const results = [];

for (const candidate of candidates) {
  const collectionCode = compileInFreshProcess('collection', candidate.toString());
  const blockchain = await Blockchain.create();
  const owner = await blockchain.treasury(`owner-${candidate}`);
  const treasury = await blockchain.treasury(`treasury-${candidate}`);
  const buyer = await blockchain.treasury(`buyer-${candidate}`);
  const collection = blockchain.openContract(Collection.create(owner.address, treasury.address, collectionCode, itemCode));
  await collection.sendDeploy(owner.getSender());

  let ok = false;
  let fees = 0n;
  let txCount = 0;
  let error = null;
  let initialized = null;
  let nftOwner = null;
  let mintStateNext = null;
  let nftAddressText = null;
  let transactions = [];

  try {
    const mintResult = await collection.sendMint(buyer.getSender(), BASE_PRICE + candidate);
    transactions = mintResult.transactions ?? [];
    fees = sumFees(transactions);
    txCount = transactions.length;
    const mintState = await collection.getMintState();
    mintStateNext = mintState.next.toString();
    const nftAddress = await collection.getNftAddress(0);
    nftAddressText = nftAddress.toString();
    const nft = blockchain.openContract(new NftItem(nftAddress));
    const nftData = await nft.getData();
    initialized = nftData.initialized.toString();
    nftOwner = nftData.owner.toString();
    ok = nftData.initialized === -1n && nftData.index === 0n && nftOwner === buyer.address.toString();
  } catch (e) {
    error = e?.stack ?? String(e);
  }

  const record = {
    deployValueNano: candidate.toString(),
    deployValueTon: Number(candidate) / 1e9,
    nftInitialized: ok,
    initialized,
    nftOwner,
    nftAddress: nftAddressText,
    buyer: buyer.address.toString(),
    mintStateNext,
    sandboxTotalFeesNano: fees.toString(),
    sandboxTransactionCount: txCount,
    transactions: txSummary(transactions),
    error,
  };
  results.push(record);
  console.log(`GAS_PROFILE_DIAGNOSTIC ${JSON.stringify(record)}`);
}

const passing = results.filter((r) => r.nftInitialized);
assert.ok(passing.length > 0, 'No tested reserve initialized NFT; see GAS_PROFILE_DIAGNOSTIC');
const minimumPassing = passing[0];
console.log(`Minimum passing tested reserve: ${minimumPassing.deployValueNano} nanoTON (${minimumPassing.deployValueTon} TON)`);
console.log('NOTE: Sandbox measurement only. Testnet validation and a safety margin are still required before production.');
