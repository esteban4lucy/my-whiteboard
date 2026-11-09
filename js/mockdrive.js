// Fake Drive used ONLY for automated tests / demos (open the app with ?mock=1).
// Same interface as GoogleDriveAdapter; files live in a separate IndexedDB ("wb-mockdrive").
// It refuses every call while the browser is offline, like the real API would.
const NAME = 'wb-mockdrive';
let dbp;
function open() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
function op(mode, fn) {
  return open().then((d) => new Promise((res, rej) => {
    const t = d.transaction('files', mode); const r = fn(t.objectStore('files')); let out;
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error);
  }));
}
let seq = 0;
const stamp = () => new Date(Date.now() + (seq++)).toISOString();

export class MockDriveAdapter {
  constructor() { this.kind = 'mock'; this.email = 'test@example.com'; this.calls = []; }
  isConfigured() { return true; }
  isAuthed() { return true; }
  hasSignedInBefore() { return true; }
  async signIn() { return this.email; }
  signOut() {}
  check(name) {
    this.calls.push(name);
    if (!navigator.onLine) throw new Error('Mock Drive: network unavailable');
  }
  async ensureReady() { this.check('ensureReady'); return { root: 'mock-root' }; }
  async listFiles(folderKey) {
    this.check('listFiles');
    const all = await op('readonly', (s) => s.getAll());
    return all.filter((f) => f.folder === folderKey && !f.trashed).map(({ content, ...m }) => m);
  }
  async readJSON(id) { this.check('readJSON'); const f = await op('readonly', (s) => s.get(id)); return JSON.parse(f.content); }
  async readBlob(id) { this.check('readBlob'); const f = await op('readonly', (s) => s.get(id)); return f.content; }
  async createFile(folder, name, body, mime = 'application/json', appProperties = {}) {
    this.check('createFile');
    const now = stamp();
    const f = { id: 'mock-' + Math.random().toString(36).slice(2), folder, name, mimeType: mime, appProperties, createdTime: now, modifiedTime: now,
      content: body instanceof Blob ? body : (typeof body === 'string' ? body : JSON.stringify(body)), webViewLink: 'https://example.com/mock' };
    await op('readwrite', (s) => s.put(f));
    const { content, ...m } = f; return m;
  }
  async updateFile(id, name, body, mime, appProperties = {}) {
    this.check('updateFile');
    const f = await op('readonly', (s) => s.get(id));
    Object.assign(f, { name, appProperties: { ...f.appProperties, ...appProperties }, modifiedTime: stamp(), content: typeof body === 'string' ? body : JSON.stringify(body) });
    await op('readwrite', (s) => s.put(f));
    const { content, ...m } = f; return m;
  }
  async renameFile(id, name) { this.check('renameFile'); const f = await op('readonly', (s) => s.get(id)); f.name = name; await op('readwrite', (s) => s.put(f)); return { id, name }; }
  async trash(id) { this.check('trash'); const f = await op('readonly', (s) => s.get(id)); f.trashed = true; await op('readwrite', (s) => s.put(f)); return { id }; }
  async fileState(id) { this.check('fileState'); const f = await op('readonly', (s) => s.get(id)); return f && !f.trashed ? 'ok' : 'gone'; }
  consumeRootChanged() { return false; }
  folderUrl() { return null; }

  // ---- test helpers (simulate another device editing Drive) ----
  async _all() { return op('readonly', (s) => s.getAll()); }
  async _editRemote(boardId, mutate) {
    const all = await this._all();
    const f = all.find((x) => x.folder === 'boards' && x.appProperties && x.appProperties.boardId === boardId && !x.trashed);
    const data = JSON.parse(f.content); mutate(data); data.updatedAt = Date.now();
    f.content = JSON.stringify(data); f.modifiedTime = stamp(); f.appProperties.updatedAt = String(data.updatedAt);
    await op('readwrite', (s) => s.put(f));
    return f.modifiedTime;
  }
}
