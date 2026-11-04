// Tests the REAL GoogleDriveAdapter (drive.js) against an emulated Drive v3 REST API + fake GIS script.
import { chromium } from 'playwright-core';
const BASE = 'http://127.0.0.1:8765/my-whiteboard/';
const res = []; const ok = (n, c, i = '') => { res.push([c ? 'PASS' : 'FAIL', n, i]); console.log(c ? 'PASS' : 'FAIL', n, i); };
const ROOT = '11C9mAo7-4w-oWULU_HL98k3_knVlI7jQ';
const FOLDER = 'application/vnd.google-apps.folder'; const FOLDER_T = FOLDER;
let files, seq, authOK, email;
function reset(mail) {
  files = new Map([[ROOT, { id: ROOT, name: 'Whiteboard', mimeType: FOLDER, parents: ['root'], trashed: false, modifiedTime: new Date().toISOString(), createdTime: new Date().toISOString(), appProperties: {} }]]);
  // pre-existing subfolder (like the ones created by the connector)
  files.set('sub-boards', { id: 'sub-boards', name: 'boards', mimeType: FOLDER, parents: [ROOT], trashed: false, appProperties: {} });
  seq = 0; authOK = true; email = mail;
}
const meta = (f) => { const { content, parents, trashed, ...m } = f; return { ...m, webViewLink: `https://drive.google.com/file/d/${f.id}/view` }; };
function matchQ(f, q) {
  const conds = q.split(' and ').map((c) => c.trim());
  return conds.every((c) => {
    let m;
    if ((m = c.match(/^name='(.*)'$/))) return f.name === m[1].replace(/\\'/g, "'");
    if ((m = c.match(/^mimeType='(.*)'$/))) return f.mimeType === m[1];
    if ((m = c.match(/^mimeType!='(.*)'$/))) return f.mimeType !== m[1];
    if ((m = c.match(/^'(.*)' in parents$/))) return f.parents.includes(m[1]);
    if (c === 'trashed=false') return !f.trashed;
    throw new Error('unsupported q: ' + c);
  });
}
function parseMultipart(buf, ct) {
  const boundary = ct.match(/boundary=(\S+)/)[1];
  const s = buf.toString('latin1');
  const parts = s.split('--' + boundary).slice(1, -1).map((p) => { const i = p.indexOf('\r\n\r\n'); return { head: p.slice(0, i), body: p.slice(i + 4, p.length - 2) }; });
  return { meta: JSON.parse(Buffer.from(parts[0].body, 'latin1').toString('utf8')), content: Buffer.from(parts[1].body, 'latin1'), mime: parts[1].head.match(/Content-Type: (\S+)/i)[1] };
}
const log = [];
async function driveRoute(route) {
  const req = route.request(); const u = new URL(req.url()); const method = req.method();
  log.push(`${method} ${u.pathname}`);
  if (req.headers()['authorization'] !== 'Bearer fake-token') return route.fulfill({ status: 401, body: 'no auth' });
  const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
  const now = () => new Date(Date.now() + seq++).toISOString();
  let m;
  if (u.pathname === '/drive/v3/about') return json({ user: { emailAddress: email, displayName: 'S' } });
  if (u.pathname === '/drive/v3/files' && method === 'GET') {
    const q = u.searchParams.get('q');
    return json({ files: [...files.values()].filter((f) => matchQ(f, q)).map(meta) });
  }
  if (u.pathname === '/drive/v3/files' && method === 'POST') {
    const b = JSON.parse(req.postData()); const id = 'f' + (++seq);
    files.set(id, { id, name: b.name, mimeType: b.mimeType, parents: b.parents, trashed: false, appProperties: {}, modifiedTime: now(), createdTime: now() });
    return json({ id });
  }
  if (u.pathname === '/upload/drive/v3/files' && method === 'POST') {
    if (u.searchParams.get('uploadType') !== 'multipart') return json({ error: 'bad uploadType' }, 400);
    const mp = parseMultipart(req.postDataBuffer(), req.headers()['content-type']); const id = 'f' + (++seq);
    const t = now();
    files.set(id, { id, name: mp.meta.name, mimeType: mp.meta.mimeType || mp.mime, parents: mp.meta.parents, trashed: false, appProperties: mp.meta.appProperties || {}, content: mp.content, modifiedTime: t, createdTime: t });
    return json(meta(files.get(id)));
  }
  if ((m = u.pathname.match(/^\/upload\/drive\/v3\/files\/([\w-]+)$/)) && method === 'PATCH') {
    const f = files.get(m[1]); if (!f) return json({}, 404);
    const mp = parseMultipart(req.postDataBuffer(), req.headers()['content-type']);
    Object.assign(f, { name: mp.meta.name, appProperties: { ...f.appProperties, ...mp.meta.appProperties }, content: mp.content, modifiedTime: now() });
    return json(meta(f));
  }
  if ((m = u.pathname.match(/^\/drive\/v3\/files\/([\w-]+)$/))) {
    const f = files.get(m[1]); if (!f) return json({ error: { code: 404 } }, 404);
    if (method === 'PATCH') { Object.assign(f, JSON.parse(req.postData())); return json({ id: f.id }); }
    if (u.searchParams.get('alt') === 'media') return route.fulfill({ status: 200, contentType: f.mimeType, body: f.content });
    return json({ ...meta(f), trashed: f.trashed });
  }
  return json({ error: 'unhandled ' + u.pathname }, 400);
}
const GIS = `window.google = { accounts: { oauth2: {
  initTokenClient: (c) => ({ requestAccessToken: (o) => { window.__gisReq = { scope: c.scope, prompt: o && o.prompt, hint: c.login_hint }; setTimeout(() => c.callback({ access_token: 'fake-token', expires_in: 3600 }), 10); } }),
  revoke: () => { window.__revoked = true; } } } };`;

async function run(mail, allowed) {
  reset(mail);
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ contentType: 'text/javascript', body: GIS }));
  await ctx.route(/googleapis\.com/, driveRoute);
  await ctx.route(/config\.js$/, async (r) => { const resp = await r.fetch(); let body = await resp.text(); body = body.replace("YOUR_CLIENT_ID.apps.googleusercontent.com", 'test-client.apps.googleusercontent.com').replace("ALLOWED_EMAIL: ''", `ALLOWED_EMAIL: '${allowed}'`); r.fulfill({ response: resp, body }); });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(BASE + '?nosw');
  await p.waitForFunction(() => window.__wb && __wb.S.board);
  return { b, p, errs };
}

{ // allowed account
  const { b, p, errs } = await run('stephane@example.com', 'Stephane@example.com');
  ok('Sign-in gate shown on first visit', await p.isVisible('text=Sign in with Google'));
  ok('Pill asks to sign in before auth', (await p.textContent('#syncPill')).startsWith('Sign in'));
  await p.click('text=Sign in with Google');
  await p.waitForFunction(() => document.querySelector('#syncPill').textContent === 'Synced', null, { timeout: 10000 });
  const gis = await p.evaluate(() => window.__gisReq);
  ok('GIS token request uses drive scope + consent on first sign-in', gis.scope === 'https://www.googleapis.com/auth/drive' && gis.prompt === 'consent', JSON.stringify(gis));
  const all = [...files.values()];
  const subs = all.filter((f) => f.mimeType === FOLDER && f.parents[0] === ROOT).map((f) => f.name).sort();
  ok('Uses existing Whiteboard folder (ROOT_FOLDER_ID), reuses existing subfolder, creates missing ones', subs.join(',') === 'boards,documents,images,source,templates,versions' && all.filter((f) => f.name === 'boards').length === 1, subs.join(','));
  const board = all.find((f) => f.parents[0] === 'sub-boards' && !f.trashed);
  ok('Board JSON uploaded via multipart into boards/ with appProperties', board && board.name === 'My first board.board.json' && board.appProperties.boardId && JSON.parse(board.content.toString()).app === 'my-whiteboard');
  // edit & push update
  await p.evaluate(() => __wb.commit(() => __wb.S.board.items.push({ id: 'n1', type: 'note', x: 0, y: 0, w: 200, h: 160, text: 'Real adapter ✓ àéü', color: '#fff59d' })));
  await p.evaluate(() => __wb.saveChainDone()); await p.evaluate(() => __wb.sync.syncNow().then(() => __wb.sync.syncNow()));
  ok('Update pushed with PATCH (UTF-8 preserved)', JSON.parse(board.content.toString('utf8')).items.some((i) => i.text === 'Real adapter ✓ àéü'));
  // remote change pulled
  const d = JSON.parse(board.content.toString('utf8')); d.items.push({ id: 'n2', type: 'text', x: 0, y: 300, text: 'Edited elsewhere', fontSize: 28, color: 'ink' }); d.updatedAt = Date.now();
  board.content = Buffer.from(JSON.stringify(d)); board.modifiedTime = new Date(Date.now() + 99999).toISOString();
  await p.evaluate(() => __wb.sync.syncNow().then(() => __wb.sync.syncNow()));
  ok('Remote change pulled via alt=media', await p.evaluate(() => __wb.S.board.items.some((i) => i.text === 'Edited elsewhere')));
  // versions + prune via real adapter
  for (let i = 0; i < 7; i++) await p.evaluate(() => __wb.sync.saveVersion(__wb.S.board, 'manual'));
  const vers = [...files.values()].filter((f) => f.parents[0] !== ROOT && files.get(f.parents[0])?.name === 'versions');
  ok('Versions: 5 kept, rest trashed (real adapter)', vers.filter((v) => !v.trashed).length === 5 && vers.filter((v) => v.trashed).length >= 3, `${vers.filter((v) => !v.trashed).length} live / ${vers.filter((v) => v.trashed).length} trashed`);
  // token expiry → 401 → pill "Sign in"
  await p.evaluate(() => { __wb.adapter.token.access_token = 'expired'; });
  await p.evaluate(() => __wb.commit(() => __wb.S.board.items.push({ id: 'n3', type: 'note', x: 300, y: 0, w: 200, h: 160, text: 'after expiry', color: '#fff59d' })));
  await p.evaluate(() => __wb.saveChainDone()); await p.evaluate(() => __wb.sync.syncNow().then(() => __wb.sync.syncNow()));
  ok('Expired token → pill shows "Sign in" with pending count, edits kept locally', /^Sign in · \d/.test(await p.textContent('#syncPill')), await p.textContent('#syncPill'));
  await p.click('#syncPill'); await p.waitForFunction(() => document.querySelector('#syncPill').textContent === 'Synced', null, { timeout: 10000 });
  ok('Tap pill → silent re-auth (no consent prompt) and sync', (await p.evaluate(() => window.__gisReq.prompt)) === '' && JSON.parse(board.content.toString('utf8')).items.some((i) => i.text === 'after expiry'));
  // user trashes the whole Whiteboard folder → app sets up a new one and re-uploads, without deleting local boards
  for (const f of files.values()) f.trashed = true;
  await p.evaluate(() => { __wb.adapter._checkedAt = 0; });
  await p.evaluate(() => __wb.sync.syncNow().then(() => __wb.sync.syncNow()));
  const newRoot = [...files.values()].find((f) => f.name === 'Whiteboard' && !f.trashed && f.mimeType === FOLDER_T);
  ok('Folder trashed in Drive → new Whiteboard folder created, boards re-uploaded, nothing lost locally',
    !!newRoot && [...files.values()].some((f) => !f.trashed && f.name === 'My first board.board.json') && (await p.evaluate(() => __wb.S.boards.length)) >= 1 && (await p.textContent('#toasts')).includes('was missing'));
  ok('No uncaught errors', errs.length === 0, errs.join('|'));
  await b.close();
}
{ // wrong account
  const { b, p } = await run('someone.else@example.com', 'stephane@example.com');
  await p.click('text=Sign in with Google'); await p.waitForTimeout(800);
  ok('Other Google account rejected (ALLOWED_EMAIL) & token revoked', (await p.textContent('#toasts')).includes('is not allowed') && (await p.evaluate(() => window.__revoked === true)) && ![...files.values()].some((f) => f.content));
  await b.close();
}
console.log(`${res.filter((r) => r[0] === 'PASS').length}/${res.length} passed`);
import('fs').then((fs) => fs.writeFileSync('/tmp/wb-real-results.json', JSON.stringify(res, null, 1)));
