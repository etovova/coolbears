// Keep uncertain and signed responses. No clear/delete/re-sign shortcut.
export function createOwnerStorage(indexedDB) {
  let opening;
  const database = () => opening ??= new Promise((resolve, reject) => {
    const request = (indexedDB ?? globalThis.indexedDB).open('coolbears-private-owner-signing-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('responses');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(Error('STORAGE')); request.onblocked = () => reject(Error('STORAGE'));
  });
  async function run(mode, action) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('responses', mode), request = action(tx.objectStore('responses'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(Error('STORAGE'));
    });
  }
  return { ready: () => run('readwrite', store => store.put(true, 'storage-probe')), get: key => run('readonly', store => store.get(key)), put: (key, value) => run('readwrite', store => store.put(value, key)) };
}
