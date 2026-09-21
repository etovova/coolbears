import { Connection, PublicKey } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createNoopSigner, createSignerFromKeypair, generateSigner, publicKey, signerIdentity } from '@metaplex-foundation/umi';
import { toWeb3JsTransaction } from '@metaplex-foundation/umi-web3js-adapters';
import { mplCore, fetchCollection, fetchAsset, fetchAssetsByCollection } from '@metaplex-foundation/mpl-core';
import { mplCandyMachine, fetchCandyMachine, fetchCandyGuard, findCandyGuardPda } from '@metaplex-foundation/mpl-core-candy-machine';
import { SPEC, CLOSED_DATE, PROGRAMS, validateCommitment, assertQuantity, commitmentFor, indexFromName, assertRevealTime } from './spec.mjs';
import { buildCollection, buildReserved, buildMachine, buildMint, buildReveal } from './builders.mjs';
import { Journal, performOperation } from './journal.mjs';

const GENESIS = { devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1', 'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' };
export class CoolBearsClient {
  constructor({ provider, address, endpoint, cluster = 'devnet', storage = globalThis.localStorage, onProgress = () => {} }) {
    if (!GENESIS[cluster]) throw Error('Unsupported Solana network');
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw Error('HTTPS RPC required');
    if (!storage?.getItem || !storage?.setItem) throw Error('Progress storage is unavailable');
    this.provider = provider; this.address = publicKey(address); this.cluster = cluster;
    this.storage = storage; this.onProgress = onProgress;
    this.connection = new Connection(endpoint, { commitment: 'confirmed', confirmTransactionInitialTimeout: 45000 });
    this.umi = createUmi(endpoint).use(mplCore()).use(mplCandyMachine()).use(signerIdentity(createNoopSigner(this.address)));
    this.journal = new Journal(storage, `${cluster}:${this.address}`);
    this.sessionKey = `coolbears-v2:deployment:${cluster}:${this.address}`;
  }
  assertWallet() {
    if (this.provider.publicKey?.toString() !== this.address) throw Error('Wallet account changed; reconnect before continuing');
  }
  async checkNetwork() {
    this.assertWallet();
    if (await this.connection.getGenesisHash() !== GENESIS[this.cluster]) throw Error('RPC network does not match the selected network');
    for (const address of Object.values(PROGRAMS)) {
      const a = await this.connection.getAccountInfo(new PublicKey(address));
      if (!a?.executable) throw Error('Metaplex program is not available on this network');
    }
  }
  load() { return JSON.parse(this.storage.getItem(this.sessionKey) || 'null'); }
  save(state) {
    const json = JSON.stringify(state); this.storage.setItem(this.sessionKey, json);
    if (this.storage.getItem(this.sessionKey) !== json) throw Error('Deployment state could not be saved');
    return state;
  }
  newSigner() { const signer = generateSigner(this.umi); return { address: signer.publicKey, secret: Array.from(signer.secretKey) }; }
  signer(saved) {
    const signer = createSignerFromKeypair(this.umi, this.umi.eddsa.createKeypairFromSecretKey(Uint8Array.from(saved.secret)));
    if (signer.publicKey !== saved.address) throw Error('Saved account key mismatch');
    return signer;
  }
  init(commitment) {
    if (this.address !== SPEC.owner) throw Error('CoolBears owner required');
    validateCommitment(commitment);
    const previous = this.load();
    if (previous) {
      if (previous.commitment !== commitment || previous.owner !== this.address || previous.cluster !== this.cluster) throw Error('Saved deployment does not match');
      return previous;
    }
    return this.save({ schema: SPEC.schema, owner: this.address, cluster: this.cluster, commitment,
      collection: this.newSigner(), reserved: this.newSigner(), machine: this.newSigner() });
  }
  async exists(address, ownerProgram) {
    const a = await this.connection.getAccountInfo(new PublicKey(address), 'finalized');
    if (!a) return false;
    if (a.owner.toBase58() !== ownerProgram) throw Error('Account belongs to an unexpected program');
    return true;
  }
  async confirm(signature) {
    // Bounded polling; the next explicit action resumes from the saved receipt.
    for (let i = 0; i < 12; i++) {
      const { value: [s] } = await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      if (s?.err) throw Error('Transaction was rejected by Solana; inspect the saved operation');
      if (s?.confirmationStatus === 'finalized') return true;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    return false;
  }
  async operation(id, target, builder, inspect) {
    if (!globalThis.navigator?.locks) throw Error('This browser must support Web Locks to protect simultaneous wallet operations');
    return navigator.locks.request(`coolbears-v2:${this.cluster}:${this.address}`, { ifAvailable: true }, lock => {
      if (!lock) throw Error('Another CoolBears operation is already running in this browser');
      return this.operationUnlocked(id, target, builder, inspect);
    });
  }
  async operationUnlocked(id, target, builder, inspect) {
    this.assertWallet();
    const old = this.journal.get(id);
    if (old && ['submitting', 'submitted', 'unknown'].includes(old.state)) {
      if (await inspect(old)) return this.journal.put(id, { state: 'confirmed', reconciled: true });
      const status = old.signature ? (await this.connection.getSignatureStatuses([old.signature], { searchTransactionHistory: true })).value[0] : null;
      if (status && !status.err) {
        if (await this.confirm(old.signature) && await inspect(old)) return this.journal.put(id, { state: 'confirmed' });
        throw Error('Previous operation is still awaiting confirmation');
      }
      const height = await this.connection.getBlockHeight('finalized');
      if (!Number.isSafeInteger(old.lastValidBlockHeight) || height <= old.lastValidBlockHeight + 32) throw Error('Previous operation has not expired; progress is saved');
      // Finalized absence after expiry allows a new transaction for the SAME target.
      this.journal.put(id, { state: 'expired', signature: null });
    }
    return performOperation({ id, journal: this.journal, inspect,
      prepare: async () => {
        this.assertWallet();
        const latest = await this.connection.getLatestBlockhash('confirmed');
        const unsigned = await builder.setBlockhash(latest).buildAndSign(this.umi);
        const tx = toWeb3JsTransaction(unsigned);
        if (tx.serialize().length > 1232) throw Error('Transaction exceeds the Solana packet limit');
        const simulation = await this.connection.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed' });
        if (simulation.value.err) throw Error('Preflight did not pass; no wallet signature requested');
        return { transaction: tx, record: { target, ...latest, cluster: this.cluster, owner: this.address } };
      },
      submit: async tx => {
        this.assertWallet();
        const options = { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 };
        if (typeof this.provider.signAndSendTransaction === 'function') {
          const result = await this.provider.signAndSendTransaction(tx, options); return result.signature;
        }
        if (typeof this.provider.sendTransaction === 'function') return this.provider.sendTransaction(tx, this.connection, options);
        throw Error('Wallet must support signing and sending Solana transactions');
      }, confirm: signature => this.confirm(signature) });
  }
  async verifyCollection(address) {
    const col = await fetchCollection(this.umi, publicKey(address), { commitment: 'finalized' });
    if (col.updateAuthority !== SPEC.owner || col.name !== 'CoolBears' || col.uri !== SPEC.collectionUri ||
        col.royalties?.basisPoints !== SPEC.royaltyBps || col.royalties.creators.length !== 1 ||
        col.royalties.creators[0].address !== SPEC.owner || col.royalties.creators[0].percentage !== 100) throw Error('Collection parameters mismatch');
    return col;
  }
  async verifyMachine(state, requireOpen = false) {
    const cm = await fetchCandyMachine(this.umi, publicKey(state.machine.address), { commitment: 'finalized' });
    const guardAddress = findCandyGuardPda(this.umi, { base: cm.publicKey });
    const cg = await fetchCandyGuard(this.umi, guardAddress, { commitment: 'finalized' });
    const hash = Array.from(cm.data.hiddenSettings.value?.hash || [], b => b.toString(16).padStart(2, '0')).join('');
    if (cm.authority !== SPEC.owner || cm.collectionMint !== state.collection.address || cm.mintAuthority !== guardAddress[0] ||
        cm.data.itemsAvailable !== 9999n || cm.data.configLineSettings.__option !== 'None' ||
        hash !== state.commitment || cm.data.hiddenSettings.value.name !== SPEC.hiddenName || cm.data.hiddenSettings.value.uri !== SPEC.hiddenUri ||
        cg.authority !== SPEC.owner || cg.groups.length || cg.guards.solPayment.value?.destination !== SPEC.owner ||
        cg.guards.solPayment.value?.lamports.basisPoints !== SPEC.priceLamports || cg.guards.startDate.__option !== 'Some') throw Error('Candy Machine parameters mismatch');
    const allowed = new Set(['solPayment', 'startDate']);
    if (Object.entries(cg.guards).some(([k,v]) => !allowed.has(k) && v.__option !== 'None')) throw Error('Unexpected Candy Guard');
    if (requireOpen && cg.guards.startDate.value.date !== 0n) throw Error('Mint is not open');
    return { cm, cg, open: cg.guards.startDate.value.date === 0n };
  }
  async deploy(commitment) {
    await this.checkNetwork(); const state = this.init(commitment);
    const { collection, reserved, machine } = state;
    this.onProgress('Создание коллекции · 1/3');
    await this.operation(`collection:${collection.address}`, collection.address, buildCollection(this.umi, this.signer(collection)), async () => {
      if (!await this.exists(collection.address, PROGRAMS.core)) return false;
      await this.verifyCollection(collection.address); return true;
    });
    this.onProgress('Создание первого NFT · 2/3');
    await this.operation(`reserved:${reserved.address}`, reserved.address, buildReserved(this.umi, this.signer(reserved), collection.address), async () => {
      if (!await this.exists(reserved.address, PROGRAMS.core)) return false;
      const a = await fetchAsset(this.umi, publicKey(reserved.address), { commitment: 'finalized' });
      if (a.updateAuthority.address !== collection.address || a.name !== 'CoolBears #0000 — Hidden Bear' || a.uri !== SPEC.reservedUri || a.owner !== SPEC.owner) throw Error('First asset mismatch');
      return true;
    });
    this.onProgress('Настройка выпуска · 3/3');
    await this.operation(`machine:${machine.address}`, machine.address, await buildMachine(this.umi, this.signer(machine), collection.address, commitment), async () => {
      if (!await this.exists(machine.address, PROGRAMS.machine)) return false;
      const result = await this.verifyMachine(state);
      if (result.cg.guards.startDate.value.date !== CLOSED_DATE) throw Error('New collection must remain closed');
      return true;
    });
    this.onProgress('Коллекция создана. Продажи закрыты.'); return state;
  }
  async mintOrder(state, quantity, orderId) {
    assertQuantity(quantity); await this.checkNetwork(); await this.verifyCollection(state.collection.address);
    const { cm } = await this.verifyMachine(state, true);
    const key = `coolbears-v2:order:${this.cluster}:${this.address}:${state.machine.address}:${orderId}`;
    let order = JSON.parse(this.storage.getItem(key) || 'null');
    if (!order) {
      if (BigInt(quantity) > cm.data.itemsAvailable - cm.itemsRedeemed) throw Error('Not enough NFTs remain');
      order = { quantity, targets: Array.from({ length: quantity }, () => this.newSigner()) };
      this.storage.setItem(key, JSON.stringify(order));
    }
    if (order.quantity !== quantity) throw Error('Saved order quantity mismatch');
    for (let i = 0; i < order.targets.length; i++) {
      const target = order.targets[i];
      this.onProgress(`${i + 1}/${quantity}`);
      await this.operation(`mint:${target.address}`, target.address,
        buildMint(this.umi, this.signer(target), state.machine.address, state.collection.address, SPEC.owner), async () => {
          if (!await this.exists(target.address, PROGRAMS.core)) return false;
          const a = await fetchAsset(this.umi, publicKey(target.address), { commitment: 'finalized' });
          if (a.updateAuthority.address !== state.collection.address || indexFromName(a.name) < 1) throw Error('Minted asset mismatch');
          return true;
        });
    }
    return order.targets.map(x => x.address);
  }
  async reveal(state, map) {
    if (this.address !== SPEC.owner) throw Error('CoolBears owner required');
    await this.checkNetwork();
    const slot = await this.connection.getSlot('finalized'); const time = await this.connection.getBlockTime(slot);
    assertRevealTime(time);
    if (await commitmentFor(map) !== state.commitment) throw Error('Reveal commitment mismatch');
    await this.verifyMachine(state);
    const collection = await this.verifyCollection(state.collection.address);
    const assets = await fetchAssetsByCollection(this.umi, collection.publicKey, { commitment: 'finalized' });
    const indices = new Set();
    for (const asset of assets) {
      const index = indexFromName(asset.name); if (indices.has(index)) throw Error('Duplicate collection index'); indices.add(index);
    }
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i], item = map[indexFromName(asset.name)];
      this.onProgress(`Раскрытие ${i + 1}/${assets.length}`);
      await this.operation(`reveal:${asset.publicKey}`, asset.publicKey, buildReveal(this.umi, asset, collection, item, time), async () => {
        const a = await fetchAsset(this.umi, asset.publicKey, { commitment: 'finalized' });
        if (a.updateAuthority.address !== collection.publicKey) throw Error('Asset collection changed');
        return a.name === item.name && a.uri === item.uri;
      });
    }
    return assets.length;
  }
}
