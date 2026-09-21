// One atomic IndexedDB record per owner. No wallet keys or seed phrases stored.
export async function openPhantomStore(owner) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('coolbears-phantom-check-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('checks');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(Error('STORAGE_UNAVAILABLE'));
    request.onblocked = () => reject(Error('STORAGE_UNAVAILABLE'));
  });
  function transact(mode, change) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('checks', mode);
      const records = tx.objectStore('checks');
      let result, failure;
      const request = records.get(owner);
      request.onsuccess = () => {
        try { result = change(request.result || null, records); }
        catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(failure || Error('STORAGE_UNAVAILABLE'));
    });
  }
  return {
    load: () => transact('readonly', value => value),
    claim: candidate => transact('readwrite', (existing, records) => {
      if (existing) return existing;
      records.add(candidate, owner); return candidate;
    }),
    patch: (asset, update) => transact('readwrite', (existing, records) => {
      if (!existing || existing.asset !== asset) throw Error('SAVED_OPERATION_CHANGED');
      // A late response can enrich a verified record but must not downgrade it.
      const next = { ...existing, ...update };
      if (existing.phase === 'verified') next.phase = 'verified';
      records.put(next, owner); return next;
    }),
    removeIf: (asset, phase) => transact('readwrite', (existing, records) => {
      if (existing?.asset !== asset || existing.phase !== phase) throw Error('SAVED_OPERATION_CHANGED');
      records.delete(owner); return null;
    }),
  };
}
