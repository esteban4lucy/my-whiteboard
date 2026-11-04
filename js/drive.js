// Google Drive adapter: Google Identity Services (token model) + Drive REST API v3 via fetch.
// Interface (shared with mockdrive.js):
//   isConfigured(), isAuthed(), signIn(), signOut(), email
//   ensureReady()                     -> resolves folder ids
//   listFiles(folderKey)              -> [{id,name,mimeType,modifiedTime,createdTime,appProperties,webViewLink}]
//   readJSON(id), readBlob(id)
//   createFile(folderKey, name, body, mime, appProperties) -> {id, modifiedTime, webViewLink}
//   updateFile(id, name, body, mime, appProperties)        -> {id, modifiedTime}
//   trash(id)
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
// Full Drive scope: needed so the app can see the "Whiteboard" folder (created outside the app)
// and open any Drive document you link on a board. See README › "Why the drive scope".
const SCOPE = 'https://www.googleapis.com/auth/drive';
export const SUBFOLDERS = ['boards', 'versions', 'images', 'templates', 'documents', 'source'];
const FIELDS = 'id,name,mimeType,modifiedTime,createdTime,appProperties,webViewLink';

export class AuthError extends Error {}

let gisPromise = null;
function loadGIS() {
  if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = () => resolve(); s.onerror = () => { gisPromise = null; reject(new Error('Could not load Google sign-in (offline?)')); };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

export class GoogleDriveAdapter {
  constructor(cfg) {
    this.cfg = cfg;
    this.kind = 'google';
    const t = JSON.parse(localStorage.getItem('wb-token') || 'null');
    this.token = t;
    this.email = localStorage.getItem('wb-email') || '';
    this.folders = JSON.parse(localStorage.getItem('wb-folders') || 'null');
  }
  isConfigured() { return !!this.cfg.CLIENT_ID && !/^YOUR_/.test(this.cfg.CLIENT_ID); }
  isAuthed() { return !!(this.token && Date.now() < this.token.exp - 60_000); }
  hasSignedInBefore() { return !!this.email; }

  async signIn() {
    await loadGIS();
    const tok = await new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: this.cfg.CLIENT_ID,
        scope: SCOPE,
        login_hint: this.cfg.ALLOWED_EMAIL || this.email || undefined,
        callback: (r) => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r)),
        error_callback: (e) => reject(new Error(e.message || e.type || 'Sign-in cancelled')),
      });
      client.requestAccessToken({ prompt: this.email ? '' : 'consent' });
    });
    this.token = { access_token: tok.access_token, exp: Date.now() + (tok.expires_in || 3600) * 1000 };
    const about = await this.api('/about?fields=user(emailAddress,displayName)');
    const email = (about.user && about.user.emailAddress) || '';
    if (this.cfg.ALLOWED_EMAIL && email.toLowerCase() !== this.cfg.ALLOWED_EMAIL.toLowerCase()) {
      try { google.accounts.oauth2.revoke(tok.access_token); } catch { /* ignore */ }
      this.token = null;
      throw new AuthError(`This whiteboard is private. ${email} is not allowed.`);
    }
    this.email = email;
    localStorage.setItem('wb-email', email);
    localStorage.setItem('wb-token', JSON.stringify(this.token));
    return email;
  }
  signOut() {
    if (this.token && window.google && google.accounts) { try { google.accounts.oauth2.revoke(this.token.access_token); } catch { /* ignore */ } }
    this.token = null; this.email = ''; this.folders = null;
    ['wb-token', 'wb-email', 'wb-folders'].forEach((k) => localStorage.removeItem(k));
  }

  async api(path, opts = {}, base = API) {
    if (!this.isAuthed()) throw new AuthError('Signed out');
    const res = await fetch(base + path, { ...opts, headers: { Authorization: `Bearer ${this.token.access_token}`, ...(opts.headers || {}) } });
    if (res.status === 401) { this.token = null; localStorage.removeItem('wb-token'); throw new AuthError('Session expired'); }
    if (!res.ok) throw new Error(`Drive ${res.status}: ${(await res.text()).slice(0, 200)}`);
    if (opts.raw) return res;
    const ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? res.json() : res.text();
  }
  q(s) { return encodeURIComponent(s); }

  async findFolder(name, parent) {
    const r = await this.api(`/files?q=${this.q(`name='${name.replace(/'/g, "\\'")}' and mimeType='${FOLDER}' and '${parent}' in parents and trashed=false`)}&fields=files(id)&spaces=drive`);
    return r.files && r.files[0] ? r.files[0].id : null;
  }
  async createFolder(name, parent) {
    const r = await this.api('/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }) });
    return r.id;
  }
  async ensureReady() {
    if (this.folders && this.folders.root) {
      if (Date.now() - (this._checkedAt || 0) < 30_000) return this.folders;
      // Re-check the root folder once per sync: it may have been deleted or trashed in Drive.
      const st = await this.fileState(this.folders.root);
      this._checkedAt = Date.now();
      if (st === 'ok') return this.folders;
      this.folders = null; localStorage.removeItem('wb-folders'); this.rootChanged = true;
    }
    let root = null;
    if (this.cfg.ROOT_FOLDER_ID) {
      try { const f = await this.api(`/files/${this.cfg.ROOT_FOLDER_ID}?fields=id,trashed`); if (!f.trashed) root = f.id; } catch (e) { if (e instanceof AuthError) throw e; }
    }
    if (!root) root = (await this.findFolder(this.cfg.FOLDER_NAME || 'Whiteboard', 'root')) || (await this.createFolder(this.cfg.FOLDER_NAME || 'Whiteboard', 'root'));
    const folders = { root };
    for (const s of SUBFOLDERS) folders[s] = (await this.findFolder(s, root)) || (await this.createFolder(s, root));
    const prev = localStorage.getItem('wb-last-root');
    if (prev && prev !== root) this.rootChanged = true;
    localStorage.setItem('wb-last-root', root);
    this.folders = folders; this._checkedAt = Date.now();
    localStorage.setItem('wb-folders', JSON.stringify(folders));
    return folders;
  }
  // 'ok' | 'gone' (deleted or in the bin)
  async fileState(id) {
    try { const f = await this.api(`/files/${id}?fields=id,trashed`); return f.trashed ? 'gone' : 'ok'; }
    catch (e) { if (e instanceof AuthError) throw e; if (/Drive 404/.test(e.message)) return 'gone'; throw e; }
  }
  consumeRootChanged() { const c = !!this.rootChanged; this.rootChanged = false; return c; }
  async listFiles(folderKey) {
    const f = await this.ensureReady();
    let out = [], pageToken = '';
    do {
      const r = await this.api(`/files?q=${this.q(`'${f[folderKey]}' in parents and trashed=false and mimeType!='${FOLDER}'`)}&fields=nextPageToken,files(${FIELDS})&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`);
      out = out.concat(r.files || []); pageToken = r.nextPageToken || '';
    } while (pageToken);
    return out;
  }
  async readJSON(id) { const t = await this.api(`/files/${id}?alt=media`, { raw: true }); return JSON.parse(await t.text()); }
  async readBlob(id) { const r = await this.api(`/files/${id}?alt=media`, { raw: true }); return r.blob(); }

  multipart(meta, body, mime) {
    const b = 'wb' + Math.random().toString(36).slice(2);
    const content = body instanceof Blob ? body : new Blob([typeof body === 'string' ? body : JSON.stringify(body)], { type: mime });
    return {
      headers: { 'Content-Type': `multipart/related; boundary=${b}` },
      body: new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${mime}\r\n\r\n`, content, `\r\n--${b}--`]),
    };
  }
  async createFile(folderKey, name, body, mime = 'application/json', appProperties = {}) {
    const f = await this.ensureReady();
    const mp = this.multipart({ name, parents: [f[folderKey]], appProperties, mimeType: mime }, body, mime);
    return this.api(`/files?uploadType=multipart&fields=${FIELDS}`, { method: 'POST', ...mp }, UPLOAD);
  }
  async updateFile(id, name, body, mime = 'application/json', appProperties = {}) {
    const mp = this.multipart({ name, appProperties }, body, mime);
    return this.api(`/files/${id}?uploadType=multipart&fields=${FIELDS}`, { method: 'PATCH', ...mp }, UPLOAD);
  }
  async trash(id) {
    return this.api(`/files/${id}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
  }
  folderUrl() { return this.folders && this.folders.root ? `https://drive.google.com/drive/folders/${this.folders.root}` : null; }
}
