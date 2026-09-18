import { generateSigner, publicKey } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { fetchCollection, fetchAsset } from '@metaplex-foundation/mpl-core';
import { fetchCandyMachine, fetchCandyGuard } from '@metaplex-foundation/mpl-core-candy-machine';
import { devnetUmi, assertDevnet, collectionBuilder, testMachineBuilder, testItemsBuilder, testMintBuilder, SITE } from './builders.mjs';

export function ownerClient(provider, state, persist) {
  const umi = devnetUmi(provider);
  const owner = umi.identity.publicKey;
  if (state.owner && state.owner !== owner) throw new Error('Подключён другой кошелёк. Подключи кошелёк, которым создан этот тест.');
  state.owner = owner;
  state.cluster = 'devnet';
  state.assets ||= [];
  state.transactions ||= [];
  persist(state);
  async function send(builder, pending, commit) {
    assertDevnet(umi);
    if (umi.identity.publicKey !== state.owner) throw new Error('Кошелёк сменился. Подключись заново.');
    if (!builder.fitsInOneTransaction(umi)) throw new Error('Транзакция превышает размер Solana. Ничего не отправлено.');
    let signed, blockhash;
    try { blockhash = await umi.rpc.getLatestBlockhash(); signed = await builder.setBlockhash(blockhash).buildAndSign(umi); }
    catch (error) { throw error; }
    commit?.();
    // Keep the operation and address before broadcasting. A timeout must not
    // cause a second mint; the Refresh action reads these accounts from chain.
    state.pending = { ...pending, lastValidBlockHeight: Number(blockhash.lastValidBlockHeight) };
    persist(state);
    const signature = await umi.rpc.sendTransaction(signed);
    state.transactions.push(base58.deserialize(signature)[0]);
    persist(state);
    const confirmation = await umi.rpc.confirmTransaction(signature, {
      strategy: { type: 'blockhash', ...blockhash }, commitment: 'confirmed'
    });
    if (confirmation.value.err) throw new Error(`Транзакция отклонена сетью: ${JSON.stringify(confirmation.value.err)}`);
    delete state.pending;
    persist(state);
  }
  async function read() {
    assertDevnet(umi);
    const balance = await umi.rpc.getBalance(owner);
    const out = { balance: Number(balance.basisPoints) / 1e9, collection: null, machine: null, assets: [] };
    if (state.collection) {
      const account = await umi.rpc.getAccount(publicKey(state.collection));
      if (account.exists) {
        out.collection = await fetchCollection(umi, state.collection);
        if (out.collection.updateAuthority !== owner || out.collection.uri !== `${SITE}/metadata/collection.json` || out.collection.royalties?.basisPoints !== 700) throw new Error('Параметры тестовой коллекции не совпадают.');
      }
    }
    if (state.machine) {
      const account = await umi.rpc.getAccount(publicKey(state.machine));
      if (account.exists) {
        out.machine = await fetchCandyMachine(umi, publicKey(state.machine));
        const guard = await fetchCandyGuard(umi, out.machine.mintAuthority);
        if (out.machine.authority !== owner || out.machine.collectionMint !== state.collection || out.machine.data.itemsAvailable !== 2n || guard.guards.addressGate.__option !== 'Some' || guard.guards.addressGate.value.address !== owner) throw new Error('Параметры тестового минта не совпадают.');
      }
    }
    for (const address of state.assets) {
      const account = await umi.rpc.getAccount(publicKey(address));
      if (!account.exists) continue;
      const asset = await fetchAsset(umi, address);
      if (asset.owner !== owner || asset.updateAuthority.type !== 'Collection' || asset.updateAuthority.address !== state.collection || !/^CoolBears #000[01] — Hidden Bear$/.test(asset.name) || asset.uri !== `${SITE}/metadata/hidden/${asset.name.slice(11, 15)}.json`) throw new Error('Параметры NFT не совпадают.');
      out.assets.push(asset);
    }
    if (state.pending && ((state.pending.kind === 'collection' && out.collection) || (state.pending.kind === 'machine' && out.machine) || (state.pending.kind === 'items' && out.machine?.itemsLoaded === 2) || (state.pending.kind === 'mint' && out.assets.some(a => a.publicKey === state.pending.address)))) { delete state.pending; persist(state); }
    if (state.pending && await umi.rpc.call('getBlockHeight', [{ commitment: 'confirmed' }]) > state.pending.lastValidBlockHeight) {
      const pending = state.pending;
      if (pending.kind === 'collection' && !out.collection) delete state.collection;
      if (pending.kind === 'machine' && !out.machine) delete state.machine;
      if (pending.kind === 'mint') state.assets = state.assets.filter(a => a !== pending.address);
      delete state.pending;
      persist(state);
    }
    return out;
  }
  return {
    read,
    async createCollection() {
      if (state.collection) throw new Error('Адрес уже сохранён. Нажми «Проверить состояние».');
      const collection = generateSigner(umi);
      await send(collectionBuilder(umi, collection), { kind: 'collection', address: collection.publicKey }, () => { state.collection = collection.publicKey; });
    },
    async createMachine() {
      const current = await read();
      if (!current.collection || state.machine) throw new Error('Сначала проверь коллекцию.');
      const machine = generateSigner(umi);
      const builder = await testMachineBuilder(umi, machine, state.collection);
      await send(builder, { kind: 'machine', address: machine.publicKey }, () => { state.machine = machine.publicKey; });
    },
    async loadItems() {
      const current = await read();
      if (!current.machine || current.machine.itemsRedeemed !== 0n) throw new Error('Проверь состояние тестового минта.');
      await send(testItemsBuilder(umi, state.machine), { kind: 'items' });
    },
    async mint() {
      const current = await read();
      if (state.pending || !current.machine || current.machine.itemsLoaded !== 2 || current.machine.itemsRedeemed >= 2n) throw new Error('Нажми «Проверить состояние».');
      const asset = generateSigner(umi);
      const builder = testMintBuilder(umi, state.machine, state.collection, asset);
      await send(builder, { kind: 'mint', address: asset.publicKey }, () => { state.assets.push(asset.publicKey); });
    }
  };
}
