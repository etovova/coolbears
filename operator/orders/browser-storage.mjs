// Browser custody and asset-only signing. No buyer wallet, RPC or dispatch.
import policy from '../../metadata/policy.json' with { type: 'json' };
import { base58 } from '@metaplex-foundation/umi/serializers';
import { createOrderModel } from './journal-model.mjs';
import { prepareAssetClaim, validateAssetClaim, finalizeAssetRequest, validateAssetRequest } from './signing.mjs';
const model = createOrderModel(policy);
const DATABASE = 'coolbears-buyer-custody-v1';
const STORES = ['orders', 'keys', 'events', 'signing'];
const MAX_REVISION = 1024, MAX_BYTES = 262144;
const requireThat = (ok, code) => { if (!ok) throw Error(code); };
const fields = ['id', 'cluster', 'buyer', 'machine', 'collection', 'guard'];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function checkedScope(input) {
  // The validation placeholder must be distinct even when buyer is the owner.
  const scope = Object.fromEntries(fields.map(key => [key, input?.[key]]));
  const candidates = Array.from({ length: 8 }, (_, index) => base58.deserialize(new Uint8Array(32).fill(index + 1))[0]);
  const placeholder = candidates.find(value => ![...Object.values(scope), policy.owner].includes(value));
  model.createOrder({ ...scope, quantity: 1, available: 1, assets: [placeholder] });
  requireThat(scope.cluster === 'devnet', 'DEVNET_ONLY');
  return scope;
}
function bounded(order) {
  model.validateOrder(order);
  requireThat(order.revision <= MAX_REVISION && new TextEncoder().encode(JSON.stringify(order)).length <= MAX_BYTES, 'ORDER_STORAGE_LIMIT');
  return order;
}
function keyShape(record, scopeKey, item) {
  const key = record?.privateKey, pub = record?.publicKey;
  requireThat(record?.version === 1 && record.scopeKey === scopeKey && record.index === item.index && record.asset === item.asset, 'ASSET_KEY_MISSING');
  requireThat(key instanceof CryptoKey && key.type === 'private' && !key.extractable && key.algorithm.name === 'Ed25519' && equal([...key.usages], ['sign']), 'INVALID_ASSET_KEY');
  requireThat(pub instanceof CryptoKey && pub.type === 'public' && pub.algorithm.name === 'Ed25519' && equal([...pub.usages], ['verify']), 'INVALID_ASSET_KEY');
}
export function createBuyerStorage({ indexedDB = globalThis.indexedDB, crypto = globalThis.crypto, locks = globalThis.navigator?.locks } = {}) {
  let opening, connection, closed = false;
  const requireCapabilities = () => requireThat(!closed && indexedDB?.open && crypto?.subtle && locks?.request && globalThis.isSecureContext !== false, 'STORAGE_UNAVAILABLE');
  function database() {
    requireCapabilities();
    return opening ??= new Promise((resolve, reject) => {
      let settled = false;
      const request = indexedDB.open(DATABASE, 2);
      const timer = setTimeout(() => fail(), 5000);
      function fail() { if (!settled) { settled = true; clearTimeout(timer); reject(Error('STORAGE_UNAVAILABLE')); } }
      request.onupgradeneeded = () => {
        if (settled || closed) { request.transaction.abort(); return; }
        for (const store of STORES) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
      };
      request.onblocked = request.onerror = fail;
      request.onsuccess = () => {
        if (settled || closed) { request.result.close(); fail(); return; }
        settled = true; clearTimeout(timer); connection = request.result;
        connection.onversionchange = () => { closed = true; connection.close(); };
        resolve(connection);
      };
    });
  }
  // action and all IDB callbacks remain synchronous: no crypto awaits inside tx.
  async function transaction(mode, action) {
    const db = await database();
    return new Promise((resolve, reject) => {
      let tx, result, failure, done = false;
      const fail = error => { if (!done) { done = true; clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => { try { tx?.abort(); } catch {} fail(Error('STORAGE_UNCERTAIN')); }, 10000);
      try {
        tx = db.transaction(STORES, mode, { durability: 'strict' });
        requireThat(mode === 'readonly' || tx.durability === 'strict', 'STORAGE_DURABILITY_UNSUPPORTED');
        tx.oncomplete = () => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
        tx.onabort = tx.onerror = () => fail(failure ?? Error('STORAGE_WRITE_FAILED'));
        const abort = error => { failure = error; try { tx.abort(); } catch {} fail(error); };
        action(tx, value => { result = value; }, abort);
      } catch (error) { try { tx?.abort(); } catch {} fail(error); }
    });
  }
  function load(tx, scopeKey, callback, abort) {
    const queries = [tx.objectStore('orders').get(scopeKey),
      tx.objectStore('keys').getAll(IDBKeyRange.bound([scopeKey, 0], [scopeKey, 50])),
      tx.objectStore('events').getAll(IDBKeyRange.bound([scopeKey, 0], [scopeKey, MAX_REVISION + 1])),
      tx.objectStore('signing').getAll(IDBKeyRange.bound([scopeKey], [scopeKey, []]))];
    let left = queries.length;
    queries.forEach(request => { request.onsuccess = () => {
      if (--left !== 0) return;
      try { callback(queries.map(request => request.result)); } catch (error) { abort(error); }
    }; });
  }
  function validate([order, keys, events, signing], scope, scopeKey) {
    if (order === undefined) { requireThat(keys.length === 0 && events.length === 0 && signing.length === 0, 'ORPHANED_ORDER_DATA'); return null; }
    bounded(order);
    requireThat(fields.every(field => order[field] === scope[field]), 'ORDER_SCOPE_MISMATCH');
    requireThat(keys.length === order.quantity, 'ASSET_KEY_MISSING');
    for (const item of order.items) keyShape(keys[item.index], scopeKey, item);
    requireThat(events.length === order.revision + 1 && events[0]?.type === 'create', 'CORRUPT_ORDER_HISTORY');
    let replay = bounded(events[0].order);
    requireThat(replay.revision === 0 && !replay.paused && replay.items.every(item => !item.attempts.length), 'CORRUPT_ORDER_HISTORY');
    for (let i = 1; i < events.length; i++) replay = model.transitionOrder(replay, events[i]);
    requireThat(equal(replay, order), 'CORRUPT_ORDER_HISTORY');
    if (signing.length) {
      const claim = signing[0]?.record;
      requireThat(equal(events[1], { type:'prepare', revision:0, index:0, blockhash:claim?.blockhash,
        lastValidBlockHeight:claim?.lastValidBlockHeight, messageSha256:claim?.messageSha256 }), 'ASSET_CLAIM_HISTORY');
    }
    signingState(order, signing);
    return order;
  }
  async function proveKeys(order, records, scopeKey) {
    for (const item of order.items) {
      const record = records[item.index]; keyShape(record, scopeKey, item);
      try {
        const pub = new Uint8Array(await crypto.subtle.exportKey('raw', record.publicKey));
        requireThat(pub.length === 32 && base58.deserialize(pub)[0] === item.asset, 'ASSET_KEY_MISMATCH');
        // Internal domain-separated random challenge. Never a caller's transaction.
        const nonce = crypto.getRandomValues(new Uint8Array(32));
        const prefix = new TextEncoder().encode(`CoolBears custody proof v1\n${scopeKey}\n${item.index}\n`);
        const challenge = new Uint8Array(prefix.length + nonce.length); challenge.set(prefix); challenge.set(nonce, prefix.length);
        const signature = await crypto.subtle.sign('Ed25519', record.privateKey, challenge);
        requireThat(await crypto.subtle.verify('Ed25519', record.publicKey, signature, challenge), 'ASSET_KEY_MISMATCH');
      } catch { throw Error('ASSET_KEY_MISMATCH'); }
    }
  }
  function signingState(order, records) {
    requireThat(records.length <= 2, 'CORRUPT_ASSET_SIGNING');
    if (!records.length) return null;
    const [claimed, ready] = records;
    requireThat(claimed?.phase === 'claimed' && (!ready || ready.phase === 'ready'), 'CORRUPT_ASSET_SIGNING');
    validateAssetClaim(order, claimed.record);
    if (ready) validateAssetRequest(order, claimed.record, ready.record);
    return { status: ready ? 'asset-partial-saved' : 'asset-signing-unknown',
      claim: structuredClone(claimed.record), request: ready ? structuredClone(ready.record) : null,
      mode: 'offline-devnet-asset-signing', networkVerified: false, blockhashVerified: false, guardPriceVerified: false,
      readyToSign: false, readyToSubmit: false, salesOpen: false };
  }
  async function snapshotData(scope, scopeKey) {
    const data = await transaction('readonly', (tx, resolve, abort) => load(tx, scopeKey, resolve, abort));
    const order = validate(data, scope, scopeKey);
    if (order) await proveKeys(order, data[1], scopeKey);
    return { order, keys: data[1], signing: data[3] };
  }
  async function snapshot(scope, scopeKey) { return (await snapshotData(scope, scopeKey)).order; }
  async function locked(input, action) {
    requireCapabilities();
    const scope = checkedScope(structuredClone(input)), scopeKey = JSON.stringify(scope);
    return locks.request(`coolbears:buyer-order:v1:${scopeKey}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
      requireThat(lock, 'ORDER_BUSY');
      return action(scope, scopeKey);
    });
  }
  return {
    async create(input) {
      const frozen = structuredClone(input);
      return locked(frozen, async (scope, scopeKey) => {
        const quantity = frozen.quantity, available = frozen.available;
        requireThat(Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= policy.maxPerOrder && Number.isSafeInteger(available) && available >= quantity && available < policy.supply, 'INVALID_QUANTITY');
        requireThat(await snapshot(scope, scopeKey) === null, 'ORDER_EXISTS');
        const records = [];
        try {
          for (let index = 0; index < quantity; index++) {
            const pair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
            const asset = base58.deserialize(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))[0];
            records.push({ version: 1, scopeKey, index, asset, privateKey: pair.privateKey, publicKey: pair.publicKey });
          }
        } catch { throw Error('ASSET_KEY_UNSUPPORTED'); }
        const order = bounded(model.createOrder({ ...scope, quantity, available, assets: records.map(record => record.asset) }));
        await proveKeys(order, records, scopeKey);
        await transaction('readwrite', (tx, resolve, abort) => load(tx, scopeKey, data => {
          requireThat(validate(data, scope, scopeKey) === null, 'ORDER_EXISTS');
          tx.objectStore('orders').add(order, scopeKey);
          records.forEach(record => tx.objectStore('keys').add(record, [scopeKey, record.index]));
          tx.objectStore('events').add({ type: 'create', order }, [scopeKey, 0]);
          resolve(order);
        }, abort));
        // A completed write is not enough: re-read and prove cloned CryptoKeys.
        const persisted = await snapshot(scope, scopeKey);
        requireThat(equal(persisted, order), 'ORDER_NOT_SAVED');
        return persisted;
      });
    },
    read(input) { return locked(input, snapshot); },
    async append(input, event) {
      const frozen = structuredClone(event);
      requireThat(new TextEncoder().encode(JSON.stringify(frozen)).length <= 16384, 'EVENT_STORAGE_LIMIT');
      return locked(input, async (scope, scopeKey) => {
        const before = await snapshot(scope, scopeKey);
        requireThat(before, 'MISSING_ORDER');
        requireThat(frozen?.revision === before.revision, 'STALE_REVISION');
        const next = bounded(model.transitionOrder(before, frozen));
        await transaction('readwrite', (tx, resolve, abort) => load(tx, scopeKey, data => {
          const current = validate(data, scope, scopeKey);
          requireThat(equal(current, before), 'STALE_REVISION');
          tx.objectStore('events').add(frozen, [scopeKey, next.revision]);
          tx.objectStore('orders').put(next, scopeKey);
          resolve(next);
        }, abort));
        const persisted = await snapshot(scope, scopeKey);
        requireThat(equal(persisted, next), 'ORDER_NOT_SAVED');
        return persisted;
      });
    },
    // Fresh first item only. The persisted claim is consumed before asset signing.
    async prepareAssetSigning(input, candidate) {
      const frozen = structuredClone(candidate);
      return locked(input, async (scope, scopeKey) => {
        const before = await snapshotData(scope, scopeKey);
        requireThat(before.order, 'MISSING_ORDER');
        const prepared = prepareAssetClaim(before.order, frozen);
        bounded(prepared.order);
        requireThat(before.signing.length === 0, 'ASSET_SIGNING_EXISTS');
        const claimed = { phase: 'claimed', record: prepared.claim };
        await transaction('readwrite', (tx, resolve, abort) => load(tx, scopeKey, data => {
          requireThat(equal(validate(data, scope, scopeKey), before.order) && data[3].length === 0, 'STALE_REVISION');
          tx.objectStore('events').add(prepared.event, [scopeKey, prepared.order.revision]);
          tx.objectStore('orders').put(prepared.order, scopeKey);
          tx.objectStore('signing').add(claimed, [scopeKey, 0, 1, 0]);
          resolve(true);
        }, abort));
        // Native signing starts only after the intent has committed and been read back.
        const saved = await snapshotData(scope, scopeKey);
        requireThat(equal(saved.order, prepared.order) && equal(saved.signing, [claimed]), 'ASSET_CLAIM_CHANGED');
        const message = validateAssetClaim(saved.order, prepared.claim);
        let signature;
        try { signature = new Uint8Array(await crypto.subtle.sign('Ed25519', saved.keys[0].privateKey, message)); }
        catch { throw Error('ASSET_SIGNING_FAILED'); }
        const request = finalizeAssetRequest(saved.order, prepared.claim, signature);
        await transaction('readwrite', (tx, resolve, abort) => load(tx, scopeKey, data => {
          requireThat(equal(validate(data, scope, scopeKey), saved.order) && equal(data[3], [claimed]), 'ASSET_CLAIM_CHANGED');
          tx.objectStore('signing').add({ phase: 'ready', record: request }, [scopeKey, 0, 1, 1]);
          resolve(true);
        }, abort));
        const final = await snapshotData(scope, scopeKey);
        requireThat(equal(final.order, saved.order) && equal(final.signing, [claimed, {phase:'ready',record:request}]), 'ASSET_REQUEST_NOT_SAVED');
        return signingState(final.order, final.signing);
      });
    },
    readAssetSigning(input) {
      return locked(input, async (scope, scopeKey) => {
        const current = await snapshotData(scope, scopeKey);
        return current.order ? signingState(current.order, current.signing) : null;
      });
    },
    // Closing connections never deletes orders, events or keys.
    close() { closed = true; connection?.close(); },
  };
}
