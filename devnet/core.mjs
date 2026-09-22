import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createNoopSigner, generateSigner, publicKey, signerIdentity } from '@metaplex-foundation/umi';
import { base64 } from '@metaplex-foundation/umi/serializers';
import { deserializeAssetV1, deserializeCollectionV1, mplCore } from '@metaplex-foundation/mpl-core';
import { deserializeCandyMachine, deserializeCandyGuard, mintV1, mplCandyMachine } from '@metaplex-foundation/mpl-core-candy-machine';
import { setComputeUnitLimit } from '@metaplex-foundation/mpl-toolbox';
import { settings as S } from './settings.mjs';
import { makeReadFetch, safeRpcError, validateRpcEndpoint } from './rpc.mjs';
export { makeReadFetch } from './rpc.mjs';

export function requireValue(condition, message) { if (!condition) throw Error(message); }
export const assetUrl = address => `https://core.metaplex.com/explorer/${address}?env=devnet`;
export const signatureUrl = signature => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
const validAddress = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
export const isSignature = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value);

export function createClient(fetchImpl = globalThis.fetch, configuration = {}) {
  const endpoint = validateRpcEndpoint(configuration.endpoint ?? S.rpc);
  const readFetch = makeReadFetch(fetchImpl, { ...configuration, endpoint });
  let umi;
  try {
    umi = createUmi(endpoint, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: readFetch })
      .use(mplCore()).use(mplCandyMachine());
  } catch (error) { throw safeRpcError(error); }
  umi.rpc = new Proxy(umi.rpc, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      return (...args) => {
        try {
          const result = Reflect.apply(value, target, args);
          return result?.then ? result.catch(error => { throw safeRpcError(error); }) : result;
        } catch (error) { throw safeRpcError(error); }
      };
    },
  });
  async function rpc(method, params = []) {
    const response = await readFetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const data = await response.json();
    requireValue(data.id === 1 && !data.error && 'result' in data, 'RPC: invalid response');
    return data.result;
  }
  return { umi, rpc };
}

export function assertState({ machine, guard, collection }, allowed = S.owner) {
  requireValue(machine.publicKey === S.machine && machine.collectionMint === S.collection && machine.mintAuthority === S.guard, 'Не совпадает тестовая машина');
  requireValue(machine.data.itemsAvailable === 2n && machine.itemsLoaded === 2 && machine.itemsRedeemed >= 1n && machine.itemsRedeemed <= 2n, 'Не совпадает состояние тестового тиража');
  requireValue(guard.publicKey === S.guard && guard.authority === S.laboratory && guard.groups.length === 0, 'Не совпадает тестовый guard');
  const active = Object.entries(guard.guards).filter(([, value]) => value.__option === 'Some').map(([key]) => key).sort();
  requireValue(active.join(',') === 'addressGate,solPayment', 'Изменились условия минта');
  requireValue(guard.guards.addressGate.value.address === allowed, 'Минт для этого кошелька ещё не подготовлен');
  requireValue(guard.guards.solPayment.value.lamports.basisPoints === S.price && guard.guards.solPayment.value.destination === S.owner, 'Не совпадают цена или получатель');
  requireValue(collection.publicKey === S.collection && collection.updateAuthority === S.laboratory && collection.royalties?.basisPoints === 700, 'Не совпадает тестовая коллекция');
  const creators = collection.royalties.creators;
  requireValue(creators.length === 1 && creators[0].address === S.owner && creators[0].percentage === 100, 'Не совпадает получатель роялти');
}

export async function readState(client, allowed = S.owner) {
  requireValue(await client.rpc('getGenesisHash') === S.genesis, 'Требуется Solana Devnet');
  const accounts = await client.umi.rpc.getAccounts([S.machine, S.guard, S.collection].map(publicKey), { commitment: 'finalized' });
  requireValue(accounts.every(account => account.exists), 'Тестовые аккаунты не найдены');
  ['mplCoreCandyMachineCore', 'mplCoreCandyGuard', 'mplCore'].forEach((program, index) => {
    requireValue(accounts[index].owner === client.umi.programs.get(program).publicKey, 'Не совпадает программа тестового аккаунта');
  });
  const state = { machine: deserializeCandyMachine(accounts[0]), guard: deserializeCandyGuard(client.umi, accounts[1]), collection: deserializeCollectionV1(accounts[2]) };
  assertState(state, allowed);
  return state;
}

export function assertAsset(asset, owner = S.owner) {
  requireValue(asset.owner === owner && asset.updateAuthority.type === 'Collection' && asset.updateAuthority.address === S.collection, 'NFT: не совпадают владелец или коллекция');
  const index = /\/metadata\/hidden\/(000[12])\.json$/.exec(asset.uri)?.[1];
  requireValue(index && asset.uri === `https://coolbears-nfts.com/metadata/hidden/${index}.json` && asset.name === `CoolBears #${index} — Hidden Bear`, 'NFT: не совпадают метаданные');
}

export async function prepareMint(client, owner) {
  requireValue(owner === S.owner, 'Подключи кошелёк FNyt…CW6y');
  const state = await readState(client);
  requireValue(state.machine.itemsRedeemed === 1n, 'Оба тестовых NFT уже выпущены');
  const balance = await client.rpc('getBalance', [owner, { commitment: 'confirmed' }]);
  requireValue(BigInt(balance.value) > S.price, 'Недостаточно тестового SOL для условия минта и комиссий');
  const umi = client.umi;
  umi.use(signerIdentity(createNoopSigner(publicKey(owner))));
  const asset = generateSigner(umi);
  const blockhash = await umi.rpc.getLatestBlockhash({ commitment: 'confirmed' });
  const transaction = await setComputeUnitLimit(umi, { units: 300000 }).add(mintV1(umi, {
    candyMachine: publicKey(S.machine), candyGuard: publicKey(S.guard),
    collection: publicKey(S.collection), asset, owner: publicKey(owner),
    mintArgs: { solPayment: { destination: publicKey(S.owner) } },
  })).setBlockhash(blockhash).buildAndSign(umi);
  const bytes = umi.transactions.serialize(transaction);
  const encoded = base64.deserialize(bytes)[0];
  const simulation = await client.rpc('simulateTransaction', [encoded, { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }]);
  requireValue(simulation.value?.err === null, `Симуляция минта: ${JSON.stringify(simulation.value?.err)}`);
  return {
    bytes,
    operation: {
      version: 1, cluster: 'devnet', machine: S.machine, collection: S.collection,
      owner, asset: asset.publicKey, blockhash: blockhash.blockhash,
      lastValidBlockHeight: Number(blockhash.lastValidBlockHeight),
      stage: 'wallet-pending', signature: null, createdAt: new Date().toISOString(),
    },
    simulation: simulation.value,
  };
}

export function validateOperation(operation) {
  requireValue(operation?.version === 1 && operation.cluster === 'devnet' && operation.machine === S.machine && operation.collection === S.collection && operation.owner === S.owner, 'Не удалось прочитать сохранённую операцию');
  requireValue(validAddress(operation.asset) && validAddress(operation.blockhash) && Number.isSafeInteger(operation.lastValidBlockHeight) && operation.lastValidBlockHeight > 0, 'Неполная сохранённая операция');
  requireValue(['wallet-pending', 'submitted', 'unknown', 'verified', 'cancelled', 'expired', 'failed'].includes(operation.stage), 'Неизвестное состояние операции');
  requireValue(operation.signature === null || isSignature(operation.signature), 'Неверная сохранённая подпись');
  return operation;
}

export function readOperation(storage) {
  const raw = storage.getItem(S.storageKey);
  return raw === null ? null : validateOperation(JSON.parse(raw));
}
export function saveOperation(storage, operation) {
  const text = JSON.stringify(validateOperation(operation));
  storage.setItem(S.storageKey, text);
  requireValue(storage.getItem(S.storageKey) === text, 'Браузер не сохранил операцию. Подпись не запрашивается.');
}
export function mayStart(operation) { return !operation || ['cancelled', 'expired', 'failed'].includes(operation.stage); }
export async function withMintLock(locks, callback) {
  requireValue(typeof locks?.request === 'function', 'Открой страницу в обновлённом браузере Phantom');
  return locks.request(S.storageKey, { ifAvailable: true }, lock => {
    requireValue(lock, 'Операция уже открыта в другой вкладке');
    return callback();
  });
}

export async function boundedWalletCall(promise, timeoutMs = 60000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Кошелёк пока не ответил. Проверь результат сохранённой операции.')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

// Recovery NEVER signs or sends. An absent signature alone does not mean failure.
export async function inspectOperation(client, saved) {
  const operation = { ...validateOperation(saved) };
  requireValue(await client.rpc('getGenesisHash') === S.genesis, 'Требуется Solana Devnet');
  if (!operation.signature) {
    const history = await client.rpc('getSignaturesForAddress', [operation.asset, { limit: 10, commitment: 'finalized' }]);
    const entry = history.find(item => item.err === null);
    if (entry) operation.signature = entry.signature;
  }
  let status = null;
  if (operation.signature) {
    const result = await client.rpc('getSignatureStatuses', [[operation.signature], { searchTransactionHistory: true }]);
    requireValue(Array.isArray(result.value) && result.value.length === 1, 'Некорректный ответ о подписи');
    status = result.value[0];
  }
  const account = await client.umi.rpc.getAccount(publicKey(operation.asset), { commitment: 'finalized' });
  if (account.exists) {
    requireValue(account.owner === client.umi.programs.get('mplCore').publicKey, 'NFT не принадлежит программе Metaplex Core');
    const asset = deserializeAssetV1(account);
    assertAsset(asset, operation.owner);
    if (status?.confirmationStatus === 'finalized' && status.err === null) {
      await readState(client);
      return { ...operation, stage: 'verified', name: asset.name, uri: asset.uri, verifiedAt: new Date().toISOString() };
    }
    return { ...operation, stage: 'unknown' };
  }
  if (status?.confirmationStatus === 'finalized' && status.err !== null) return { ...operation, stage: 'failed', error: JSON.stringify(status.err) };
  const valid = await client.rpc('isBlockhashValid', [operation.blockhash, { commitment: 'finalized' }]);
  const height = await client.rpc('getBlockHeight', [{ commitment: 'finalized' }]);
  if (status === null && valid.value === false && height > operation.lastValidBlockHeight) {
    // Prove absence AGAIN after the finalized expiry observation. A read taken
    // before expiry could miss a transaction that landed near the boundary.
    const slot = valid.context?.slot;
    requireValue(Number.isSafeInteger(slot), 'Нет контекста проверки срока транзакции');
    const absent = await client.rpc('getAccountInfo', [operation.asset, { encoding: 'base64', commitment: 'finalized', minContextSlot: slot }]);
    requireValue(absent.context?.slot >= slot, 'RPC вернул устаревшее состояние NFT');
    if (absent.value !== null) return { ...operation, stage: 'unknown' };
    if (operation.signature) {
      const again = await client.rpc('getSignatureStatuses', [[operation.signature], { searchTransactionHistory: true }]);
      requireValue(again.context?.slot >= slot, 'RPC вернул устаревшее состояние подписи');
      if (again.value?.[0] !== null) return { ...operation, stage: 'unknown' };
    } else {
      const history = await client.rpc('getSignaturesForAddress', [operation.asset, { limit: 10, commitment: 'finalized', minContextSlot: slot }]);
      if (history.length) return { ...operation, signature: history[0].signature, stage: 'unknown' };
    }
    return { ...operation, stage: 'expired' };
  }
  return { ...operation, stage: 'unknown' };
}

export async function settleOperation(client, operation, { timeoutMs = 40000, intervalMs = 2000, onProgress = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    operation = await inspectOperation(client, operation);
    onProgress(operation);
    if (['verified', 'failed', 'expired'].includes(operation.stage)) return operation;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  return operation;
}

// Recovery may finish after the wallet has already delivered a late signature.
// Never replace stronger durable evidence with the older in-flight snapshot.
export function mergeOperationEvidence(incoming, saved) {
  if (!saved || saved.asset !== incoming.asset) return incoming;
  if (saved.stage === 'verified') return saved;
  if (saved.signature && !incoming.signature) return {
    ...incoming, signature: saved.signature,
    stage: ['cancelled', 'expired', 'failed'].includes(incoming.stage) ? 'unknown' : incoming.stage,
  };
  return incoming;
}
