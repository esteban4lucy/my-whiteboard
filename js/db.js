// Tiny IndexedDB wrapper. IndexedDB is the local source of truth (offline-first).
const DB_NAME = 'my-whiteboard';
const DB_VERSION = 1;
const KEYS = { boards: 'id', templates: 'id', blobs: 'key', kv: 'k' };
let dbp = null;

export function openDB() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const [name, keyPath] of Object.entries(KEYS)) {
          if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function run(store, mode, fn) {
  return openDB().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    let out;
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const db = {
  get: (s, k) => run(s, 'readonly', (st) => st.get(k)),
  put: (s, v) => run(s, 'readwrite', (st) => st.put(v)),
  del: (s, k) => run(s, 'readwrite', (st) => st.delete(k)),
  all: (s) => run(s, 'readonly', (st) => st.getAll()),
  // Atomic read-modify-write in one transaction: fn(current|undefined) -> new value (or undefined to skip).
  update: (s, k, fn) => openDB().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(s, 'readwrite'); const st = t.objectStore(s); let out;
    const g = st.get(k);
    g.onsuccess = () => { out = fn(g.result); if (out !== undefined) st.put(out); };
    t.oncomplete = () => resolve(out); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
  })),
};

export const kv = {
  get: async (k, dflt) => { const r = await db.get('kv', k); return r ? r.v : dflt; },
  set: (k, v) => db.put('kv', { k, v }),
};

export function uid(prefix = '') {
  const r = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const n = (Math.random() * 16) | 0; return (c === 'x' ? n : (n & 0x3) | 0x8).toString(16);
    });
  return prefix + r;
}
