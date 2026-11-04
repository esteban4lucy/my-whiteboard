import { chromium } from 'playwright-core';
import fs from 'fs';
const BASE = 'http://127.0.0.1:8765/my-whiteboard/';
const results = [];
const ok = (name, cond, info = '') => { results.push([cond ? 'PASS' : 'FAIL', name, info]); console.log(cond ? 'PASS' : 'FAIL', name, info); };
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
const ev = (fn, arg) => p.evaluate(fn, arg);
const items = () => ev(() => __wb.S.board.items.map((i) => i.type));
async function drag(a, z, steps = 12) { await p.mouse.move(a[0], a[1]); await p.mouse.down(); await p.mouse.move(z[0], z[1], { steps }); await p.mouse.up(); await p.waitForTimeout(80); }
const pill = () => p.textContent('#syncPill');
async function waitPill(re, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (re.test(await pill())) return true; await p.waitForTimeout(150); } return false; }
const mockFiles = (folder) => ev((f) => __wb.adapter._all().then((a) => a.filter((x) => x.folder === f && !x.trashed).map((x) => ({ id: x.id, name: x.name, app: x.appProperties }))), folder);

await p.goto(BASE + '?mock=1');
await p.waitForFunction(() => window.__wb && __wb.S.board);
await ev(() => navigator.serviceWorker.ready);
await p.reload(); await p.waitForFunction(() => window.__wb && __wb.S.board);
ok('App loads under /my-whiteboard/ subpath, title', (await p.title()).includes('My Whiteboard'));
ok('Service worker controls page', await ev(() => !!navigator.serviceWorker.controller));
ok('Shell cached in Cache Storage', await ev(async () => { const k = (await caches.keys()).find((x) => x.startsWith('wb-shell')); return k && (await (await caches.open(k)).keys()).length >= 15; }));

// --- drawing tools
await p.click('.toolbar [data-tool=pen]');
await drag([300, 300], [500, 380]);
ok('Pen stroke', (await items()).filter((t) => t === 'stroke').length === 1);
await p.click('.toolbar [data-tool=highlighter]');
await drag([300, 420], [500, 420]);
ok('Highlighter stroke', await ev(() => __wb.S.board.items.some((i) => i.tool === 'highlighter')));
await p.click('.toolbar [data-tool=shape]'); // first time opens shape menu
await p.keyboard.press('Escape');
await drag([600, 200], [760, 300]);
ok('Rectangle shape', (await items()).includes('rect'));
await p.click('.toolbar [data-tool=shape]'); await p.click('.popover [aria-label=arrow]');
await drag([600, 400], [800, 450]);
ok('Arrow shape', (await items()).includes('arrow'));
await p.click('.toolbar [data-tool=shape]'); await p.click('.popover [aria-label=ellipse]');
await drag([850, 200], [950, 300]);
ok('Ellipse shape', (await items()).includes('ellipse'));
await p.click('.toolbar [data-tool=text]'); await p.mouse.click(300, 550);
await p.keyboard.type('Hello free text Zanzibar');
await p.mouse.click(1100, 650); await p.waitForTimeout(100);
ok('Text item', await ev(() => __wb.S.board.items.some((i) => i.type === 'text' && i.text === 'Hello free text Zanzibar')));
await p.click('.toolbar [data-tool=note]'); await p.mouse.click(700, 600);
await p.keyboard.type('Sticky Kumquat idea'); await p.keyboard.press('Escape'); await p.waitForTimeout(100);
const note = await ev(() => __wb.S.board.items.find((i) => i.type === 'note'));
ok('Sticky note created & edited', note && note.text === 'Sticky Kumquat idea');
// move note
const sc = await ev((n) => __wb.toScreen({ x: n.x + 100, y: n.y + 80 }), note);
await p.click('.toolbar [data-tool=select]');
await drag([sc.x, sc.y], [sc.x + 100, sc.y - 50]);
const moved = await ev(() => __wb.S.board.items.find((i) => i.type === 'note'));
ok('Note moved', Math.abs(moved.x - note.x - 100 / (await ev(() => __wb.S.view.scale))) < 2, `${note.x}->${moved.x}`);
// resize note via handle
const hd = await ev((n) => __wb.toScreen({ x: n.x + n.w + 6, y: n.y + n.h + 6 }), moved);
await drag([hd.x, hd.y], [hd.x + 60, hd.y + 40]);
const resized = await ev(() => __wb.S.board.items.find((i) => i.type === 'note'));
ok('Note resized', resized.w > moved.w + 30 && resized.h > moved.h + 20, `${moved.w}x${moved.h} -> ${resized.w}x${resized.h}`);
// recolour via ctxbar
await p.click('#ctxbar .chip >> nth=3');
ok('Note recoloured', (await ev(() => __wb.S.board.items.find((i) => i.type === 'note').color)) === '#b3e5fc');
// eraser
const before = (await items()).filter((t) => t === 'stroke').length;
await p.click('.toolbar [data-tool=eraser]'); await drag([400, 280], [400, 400], 20);
ok('Eraser removes strokes', (await items()).filter((t) => t === 'stroke').length < before);
// undo / redo
const n0 = (await items()).length;
await p.click('#btnUndo'); const n1 = (await items()).length;
await p.click('#btnRedo'); const n2 = (await items()).length;
ok('Undo/redo', n1 > n0 && n2 === n0, `${n0} ${n1} ${n2}`);
await p.keyboard.press('Control+z'); ok('Ctrl+Z undo', (await items()).length === n1);
await p.keyboard.press('Control+Shift+z'); ok('Ctrl+Shift+Z redo', (await items()).length === n0);
// zoom
const s0 = await ev(() => __wb.S.view.scale);
await p.click('#zoomIn'); const s1 = await ev(() => __wb.S.view.scale);
await p.mouse.move(640, 400); await p.keyboard.down('Control'); await p.mouse.wheel(0, 200); await p.keyboard.up('Control');
const s2 = await ev(() => __wb.S.view.scale);
ok('Zoom buttons & ctrl+wheel', s1 > s0 && s2 < s1, `${s0} ${s1} ${s2}`);
const v0 = await ev(() => ({ ...__wb.S.view })); await p.mouse.wheel(100, 50); const v1 = await ev(() => ({ ...__wb.S.view }));
ok('Wheel pan', v1.x !== v0.x && v1.y !== v0.y);
// background
await p.click('#btnMore'); await p.click('.popover button:has-text("Dots")');
ok('Background dots', (await ev(() => __wb.S.board.background)) === 'dots');

// --- link card
await p.click('#btnInsert'); await p.click('.popover >> text=Link a document');
await p.fill('input[name=url]', 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit');
await p.fill('input[name=title]', 'Quarterly Plan Doc');
await p.click('button[type=submit]'); await p.waitForTimeout(200);
const link = await ev(() => __wb.S.board.items.find((i) => i.type === 'link'));
ok('Link card (Google Doc kind)', link && link.kind === 'doc' && link.title === 'Quarterly Plan Doc');
const popupP = ctx.waitForEvent('page', { timeout: 3000 }).catch(() => null);
const or = await ev((l) => __wb.toScreen({ x: l.x + l.w - 48, y: l.y + l.h - 23 }), link);
await p.click('.toolbar [data-tool=select]'); await p.mouse.click(or.x, or.y);
const popup = await popupP;
ok('Clicking "Open" on link card opens the original', !!popup && popup.url().includes('docs.google.com/document'), popup ? popup.url() : 'no popup');
if (popup) await popup.close();

// --- image upload
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEJMDGgAcQGAG4FAwFd2cg8AAAAAElFTkSuQmCC', 'base64');
fs.writeFileSync('/tmp/test.png', png);
await p.setInputFiles('#fileImage', '/tmp/test.png'); await p.waitForTimeout(500);
const img = await ev(() => __wb.S.board.items.find((i) => i.type === 'image'));
ok('Image uploaded (stored locally)', img && img.blobKey && !!(await ev((k) => __wb.db.get('blobs', k), img.blobKey)));
// image from URL (same-origin so CORS works)
await p.click('#btnInsert'); await p.click('.popover >> text=Picture from URL');
await p.fill('input[name=url]', BASE + 'icons/icon-192.png'); await p.click('button[type=submit]'); await p.waitForTimeout(500);
ok('Image from URL (cached locally)', await ev(() => __wb.S.board.items.some((i) => i.type === 'image' && i.src && i.blobKey)));

// --- sync to mock Drive
await p.waitForTimeout(3500); await waitPill(/^Synced$/);
ok('Pill shows Synced', (await pill()) === 'Synced', await pill());
let bf = await mockFiles('boards');
ok('Board JSON pushed to Drive boards/', bf.length === 1 && bf[0].name === 'My first board.board.json', JSON.stringify(bf.map((f) => f.name)));
const imgs = await mockFiles('images');
ok('Uploaded picture pushed to Drive images/ (URL pictures not uploaded)', imgs.length === 1);
ok('Board JSON in Drive maps picture -> Drive file (imageFiles)', await ev(() => __wb.adapter._all().then((a) => { const f = a.find((x) => x.folder === 'boards'); const d = JSON.parse(f.content); return Object.keys(d.imageFiles || {}).length === 1; })));

// --- repeated edit/sync cycles must not produce false conflicts
for (let i = 0; i < 3; i++) {
  await ev((i) => __wb.commit(() => __wb.S.board.items.push({ id: 'cyc' + i, type: 'text', x: 0, y: -300 - i * 40, text: 'cycle ' + i, fontSize: 20, color: 'ink' })), i);
  await ev(() => __wb.saveChainDone()); await ev(() => __wb.sync.syncNow());
}
ok('Edit → sync → edit cycles: no false conflict notice / versions', !(await p.textContent('#toasts')).includes('another device') && !(await ev(() => __wb.sync.listVersions(__wb.S.board.id))).some((v) => /overwritten/.test(v.appProperties.reason)));
ok('Edit → sync cycles: Drive has latest content', await ev(() => __wb.adapter._all().then((a) => JSON.parse(a.find((x) => x.folder === 'boards' && !x.trashed).content).items.some((i) => i.text === 'cycle 2'))));

// --- boards: new from template, rename, duplicate, delete
await p.click('#btnBoards'); await p.click('#btnNewBoard');
await p.click('.tpl-main:has-text("Meeting Notes")'); await p.fill('input[name=name]', 'Team sync'); await p.click('button[type=submit]');
await p.waitForTimeout(300);
ok('New board from Meeting Notes template', (await ev(() => __wb.S.board.name)) === 'Team sync' && (await ev(() => __wb.S.board.items.some((i) => i.type === 'text' && /Agenda/.test(i.text)))));
for (const t of ['Blank', 'Brainstorm', 'Project Plan', 'Weekly Review']) {
  await p.click('#btnMore'); await p.click('.popover >> text=New board…');
  await p.click(`.tpl-main:has-text("${t}")`); await p.click('button[type=submit]'); await p.waitForTimeout(200);
}
ok('All 5 starter templates create boards', (await ev(() => __wb.S.boards.length)) === 6, String(await ev(() => __wb.S.boards.map((b) => b.name).join(', '))));
await p.click('#boardName'); await p.fill('input[name=name]', 'Weekly review renamed'); await p.click('button[type=submit]'); await p.waitForTimeout(200);
ok('Rename board', (await p.textContent('#boardName')) === 'Weekly review renamed');
await p.click('#btnMore'); await p.click('.popover >> text=Duplicate this board'); await p.waitForTimeout(300);
ok('Duplicate board', (await ev(() => __wb.S.board.name)) === 'Weekly review renamed (copy)');
await p.click('#btnBoards'); await p.click('.board-row.current [aria-label^="Actions"]'); await p.click('.popover >> text=Delete'); await p.click('.btn.danger'); await p.waitForTimeout(300);
ok('Delete board', !(await ev(() => __wb.S.boards.some((b) => b.name.endsWith('(copy)')))));
await p.click('.board-open:has-text("Team sync")'); await p.waitForTimeout(200);
ok('Switch board', (await ev(() => __wb.S.board.name)) === 'Team sync');
// save as template
await p.click('#btnMore'); await p.click('.popover >> text=Save board as template'); await p.fill('input[name=name]', 'My standup'); await p.click('button[type=submit]'); await p.waitForTimeout(200);
await p.click('#btnMore'); await p.click('.popover >> text=New board…');
ok('Custom template listed', !!(await p.waitForSelector('.tpl-main:has-text("My standup")', { timeout: 3000 }).catch(() => null)));
await p.click('#modalClose');

// --- search
await p.click('#btnSearch'); await p.fill('.search-input', 'kumquat'); await p.waitForTimeout(200);
ok('Search finds sticky note & shows its board', (await p.textContent('.results')).includes('My first board') && (await p.textContent('.results')).toLowerCase().includes('kumquat'));
await p.fill('.search-input', 'zanzibar'); await p.waitForTimeout(150);
ok('Search finds free text', (await p.textContent('.results')).includes('My first board'));
await p.fill('.search-input', 'team sync'); await p.waitForTimeout(150);
ok('Search finds board name', (await p.textContent('.results')).includes('Board name'));
await p.fill('.search-input', 'kumquat'); await p.waitForTimeout(150);
await p.click('.result'); await p.waitForTimeout(200);
ok('Search result opens the board & selects item', (await ev(() => __wb.S.board.name)) === 'My first board' && (await ev(() => __wb.S.board.items.find((i) => i.id === __wb.S.sel)?.type)) === 'note');

// --- exports
async function dl(label) { const d = p.waitForEvent('download'); await p.click('#btnMore'); await p.click(`.popover >> text=${label}`); const x = await d; const path = await x.path(); return { name: x.suggestedFilename(), buf: fs.readFileSync(path) }; }
const ePng = await dl('Export as PNG'); ok('Export PNG', ePng.name.endsWith('.png') && ePng.buf.slice(1, 4).toString() === 'PNG', `${ePng.buf.length} bytes`);
const ePdf = await dl('Export as PDF'); ok('Export PDF', ePdf.buf.slice(0, 5).toString() === '%PDF-' && ePdf.buf.includes('%%EOF'), `${ePdf.buf.length} bytes`);
fs.writeFileSync('/tmp/export.pdf', ePdf.buf); fs.writeFileSync('/tmp/export.png', ePng.buf);
const eJson = await dl('Export as JSON'); const j = JSON.parse(eJson.buf.toString());
ok('Export JSON', j.app === 'my-whiteboard' && j.items.length > 5);
fs.writeFileSync('/tmp/export.json', eJson.buf);
await p.setInputFiles('#fileJSON', '/tmp/export.json'); await p.waitForTimeout(300);
ok('Import JSON creates board', (await ev(() => __wb.S.board.items.length)) === j.items.length && (await ev(() => __wb.S.board.id)) !== j.id);

// --- theme persistence
const th0 = await ev(() => __wb.S.theme); await p.click('#btnTheme');
await p.reload(); await p.waitForFunction(() => window.__wb && __wb.S.board);
ok('Dark/light preference remembered', (await ev(() => __wb.S.theme)) !== th0 && (await ev(() => document.documentElement.dataset.theme)) !== th0);

// --- sync everything, then offline
await p.waitForTimeout(3000); await waitPill(/^Synced$/, 10000);
bf = await mockFiles('boards');
ok('All boards synced to Drive (deleted one trashed)', bf.length === (await ev(() => __wb.S.boards.length)), `${bf.length} files / ${await ev(() => __wb.S.boards.length)} boards`);
ok('Template synced to Drive templates/', (await mockFiles('templates')).some((f) => f.name === 'My standup.template.json'));

await ctx.setOffline(true);
await p.reload(); await p.waitForFunction(() => window.__wb && __wb.S.board, null, { timeout: 10000 });
ok('App reloads while OFFLINE (served by service worker)', true);
ok('Pill shows Offline', /^Offline/.test(await pill()), await pill());
const firstId = await ev(() => __wb.S.boards.find((b) => b.name === 'My first board').id);
await ev((id) => __wb.openBoard(id), firstId); await p.waitForTimeout(400);
ok('Uploaded image renders offline (local blob)', await ev(() => { const it = __wb.S.board.items.find((i) => i.type === 'image' && !i.src); return !!it; }));
await p.screenshot({ path: '/tmp/wb-offline.png' });
await p.click('.toolbar [data-tool=note]'); await p.mouse.click(200, 200); await p.keyboard.type('Written offline Quokka'); await p.keyboard.press('Escape');
await p.waitForTimeout(400);
ok('Offline edit saved to IndexedDB (dirty)', await ev(async (id) => { const r = await __wb.db.get('boards', id); return r.dirty && r.items.some((i) => i.text === 'Written offline Quokka'); }, firstId));
ok('Pill shows pending count offline', /Offline · \d/.test(await pill()), await pill());
await p.reload(); await p.waitForFunction(() => window.__wb && __wb.S.board);
ok('Offline edit survives offline reload', await ev(() => __wb.S.boards.some((b) => b.items.some((i) => i.text === 'Written offline Quokka'))));
// another device edits a different board while we are offline
const teamId = await ev(() => __wb.S.boards.find((b) => b.name === 'Team sync').id);
await ev((id) => __wb.adapter._editRemote(id, (d) => { d.items.push({ id: 'remote-1', type: 'note', x: 0, y: 700, w: 200, h: 160, text: 'From phone Wombat', color: '#fff59d' }); }), teamId);
await ctx.setOffline(false);
await waitPill(/^Synced$/, 10000); await p.waitForTimeout(500);
ok('Back online: auto-sync, pill Synced', (await pill()) === 'Synced', await pill());
const remoteFirst = await ev((id) => __wb.adapter._all().then((a) => JSON.parse(a.find((f) => f.folder === 'boards' && f.appProperties.boardId === id && !f.trashed).content)), firstId);
ok('Offline edit pushed to Drive', remoteFirst.items.some((i) => i.text === 'Written offline Quokka'));
ok('Remote change pulled into local replica', await ev((id) => __wb.db.get('boards', id).then((r) => r.items.some((i) => i.text === 'From phone Wombat') && !r.dirty), teamId));

// --- conflict 1: remote edited first, then local (local newer wins)
await ctx.setOffline(true); await p.waitForTimeout(200);
await ev((id) => __wb.adapter._editRemote(id, (d) => { d.items.push({ id: 'remote-2', type: 'text', x: 0, y: 900, text: 'Remote older edit', fontSize: 28, color: 'ink' }); }), firstId);
await p.waitForTimeout(30);
await ev((id) => __wb.openBoard(id), firstId);
await ev(() => __wb.commit(() => __wb.S.board.items.push({ id: 'local-2', type: 'text', x: 0, y: 1000, text: 'Local newer edit', fontSize: 28, color: 'ink' })));
await p.waitForTimeout(300);
await ctx.setOffline(false); await waitPill(/^Synced$/, 10000); await p.waitForTimeout(600);
let toasts = await p.textContent('#toasts');
ok('Conflict (local newer): notice shown', /also changed on another device/.test(toasts), toasts.slice(0, 160));
const r1 = await ev((id) => __wb.adapter._all().then((a) => JSON.parse(a.find((f) => f.folder === 'boards' && f.appProperties.boardId === id && !f.trashed).content)), firstId);
ok('Conflict (local newer): local wins in Drive', r1.items.some((i) => i.text === 'Local newer edit') && !r1.items.some((i) => i.text === 'Remote older edit'));
let vers = await ev((id) => __wb.sync.listVersions(id), firstId);
ok('Conflict (local newer): overwritten remote copy kept as version', vers.some((v) => v.appProperties.reason === 'overwritten-remote'));
await p.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

// --- conflict 2: local edited first, then remote (remote newer wins)
await ctx.setOffline(true); await p.waitForTimeout(200);
await ev(() => __wb.commit(() => __wb.S.board.items.push({ id: 'local-3', type: 'text', x: 0, y: 1100, text: 'Local older edit', fontSize: 28, color: 'ink' })));
await p.waitForTimeout(300);
await ev((id) => __wb.adapter._editRemote(id, (d) => { d.items.push({ id: 'remote-3', type: 'text', x: 0, y: 1200, text: 'Remote newer edit', fontSize: 28, color: 'ink' }); }), firstId);
await ctx.setOffline(false); await waitPill(/^Synced$/, 10000); await p.waitForTimeout(600);
toasts = await p.textContent('#toasts');
ok('Conflict (remote newer): notice shown', /newer changes from another device/.test(toasts), toasts.slice(0, 160));
ok('Conflict (remote newer): remote applied locally & live view refreshed', await ev(() => __wb.S.board.items.some((i) => i.text === 'Remote newer edit') && !__wb.S.board.items.some((i) => i.text === 'Local older edit')));
vers = await ev((id) => __wb.sync.listVersions(id), firstId);
ok('Conflict (remote newer): your offline edits kept as version', vers.some((v) => v.appProperties.reason === 'overwritten-local'));
await p.screenshot({ path: '/tmp/wb-conflict.png' });

// --- version pruning & restore
for (let i = 0; i < 7; i++) await ev(() => __wb.sync.saveVersion(__wb.S.board, 'manual'));
vers = await ev((id) => __wb.sync.listVersions(id), firstId);
ok('Only last 5 versions kept (older trashed)', vers.length === 5, `${vers.length}`);
await ev(() => __wb.commit(() => { __wb.S.board.items = []; }));
await p.click('#btnMore'); await p.click('.popover >> text=Version history'); await p.waitForSelector('.version-row');
await p.click('.version-row >> nth=0 >> button'); await p.click('.btn.primary:has-text("Restore")'); await p.waitForTimeout(600);
ok('Restore version from history', (await ev(() => __wb.S.board.items.length)) > 3);
vers = await ev((id) => __wb.sync.listVersions(id), firstId);
ok('Still 5 versions after restore (pre-restore snapshot added, oldest pruned)', vers.length === 5 && vers.some((v) => v.appProperties.reason === 'before-restore'));

// --- deleted on Drive side → removed locally
await p.waitForTimeout(3500); await waitPill(/^Synced$/, 8000);
const delId = await ev(() => __wb.S.boards.find((b) => b.name === 'Blank' || b.name === 'Untitled board').id);
await ev((id) => __wb.adapter._all().then(async (a) => { const f = a.find((x) => x.folder === 'boards' && x.appProperties.boardId === id && !x.trashed); await __wb.adapter.trash(f.id); }), delId);
await ev(() => __wb.sync.syncNow());
ok('Board deleted on another device is removed locally', !(await ev((id) => __wb.db.get('boards', id), delId)));

ok('No uncaught JS errors', errs.filter((e) => !/Mock Drive: network|Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(e)).length === 0, errs.join(' | ').slice(0, 400));
await b.close();
fs.writeFileSync('/tmp/wb-results.json', JSON.stringify(results, null, 1));
console.log(`\n${results.filter((r) => r[0] === 'PASS').length}/${results.length} passed`);
