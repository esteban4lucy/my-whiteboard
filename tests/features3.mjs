// Batch 3: copy/paste/duplicate across boards (incl. clipboard pictures), camera capture + dictated notes,
// board picker (thumbnails, pins, tags, filter), handwriting smoothing + shape recognition, Drive inbox – desktop + 390px phone.
import { chromium } from 'playwright-core';
const BASE = 'http://127.0.0.1:8765/my-whiteboard/';
const res = []; const ok = (n, c, i = '') => { res.push([c ? 'PASS' : 'FAIL', n, i]); console.log(c ? 'PASS' : 'FAIL', n, i); };
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const errs = [];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC', 'base64');
const mockSR = () => {
  window.SpeechRecognition = window.webkitSpeechRecognition = class { start() { window.__srStarted = (window.__srStarted || 0) + 1; setTimeout(() => { this.onresult && this.onresult({ results: [[{ transcript: 'buy oat milk' }]] }); }, 60); setTimeout(() => this.onend && this.onend(), 120); } stop() { window.__srStopped = (window.__srStopped || 0) + 1; this.onend && this.onend(); } };
};

// ================= DESKTOP =================
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push('desk: ' + e.message));
  const ev = (fn, a) => p.evaluate(fn, a);
  const scr = (x, y) => ev(([x, y]) => __wb.toScreen({ x, y }), [x, y]);
  const items = () => ev(() => __wb.S.board.items);
  const closePops = async () => { if (await p.$('.popover')) { await p.mouse.click(1000, 700); await p.waitForTimeout(80); } };
  const blank = async (name, its = []) => { await ev(([n, its]) => __wb.createBoard({ name: n, items: its }, n), [name, its]); await p.waitForTimeout(200); await ev(() => { __wb.S.view = { x: 300, y: 200, scale: 1 }; __wb.setTool('select'); }); return ev(() => __wb.S.board.id); };
  const paste = (text) => ev((t) => { const dt = new DataTransfer(); dt.setData('text/plain', t); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, text);
  await p.goto(BASE + '?mock=1&nosw'); await p.waitForFunction(() => window.__wb && __wb.S.board);

  // ---- (f) copy / paste / duplicate across boards
  const src = await blank('Source', [
    { id: 'n1', type: 'note', x: 0, y: 0, w: 200, h: 160, text: 'Alpha', color: '#fff59d', fontSize: 20 },
    { id: 'n2', type: 'note', x: 400, y: 0, w: 200, h: 160, text: 'Beta', color: '#b3e5fc', fontSize: 20, groupId: 'g1' },
    { id: 'r1', type: 'rect', x1: 400, y1: 200, x2: 600, y2: 260, color: 'ink', size: 3, groupId: 'g1' },
    { id: 'a1', type: 'arrow', x1: 206, y1: 80, x2: 394, y2: 80, from: 'n1', to: 'n2', color: 'ink', size: 3 },
  ]);
  await ev(() => __wb.setSel(__wb.S.board.items.map((i) => i.id)));
  const srcIds = await ev(() => __wb.S.board.items.map((i) => i.id));
  await p.keyboard.press('Control+c');
  const clip = await ev(() => __wb.readClip());
  ok('Ctrl+C copies the selection to the app clipboard', clip && clip.items.length === 4, clip && clip.items.length);
  ok('Ctrl+C also puts the text on the system clipboard', (await ev(() => navigator.clipboard.readText())).includes('Alpha'));
  const tgt = await blank('Target');
  await paste(clip.sig); await p.waitForTimeout(100);
  let it = await items();
  const pn = it.filter((i) => i.type === 'note'), pa = it.find((i) => i.type === 'arrow'), pr = it.find((i) => i.type === 'rect');
  ok('Paste on another board creates the copies', it.length === 4 && pn.length === 2 && !it.some((i) => srcIds.includes(i.id)), JSON.stringify(it.map((i) => i.id)));
  ok('Pasted arrow stays connected to the pasted notes', pa && pn.some((n) => n.id === pa.from) && pn.some((n) => n.id === pa.to));
  ok('Pasted group stays a group (new group id)', pr.groupId && pr.groupId !== (await ev(() => 0)) && pn.find((n) => n.text === 'Beta').groupId === pr.groupId);
  ok('Pasted items are selected', (await ev(() => __wb.S.sel.length)) === 4);
  await p.click('#btnUndo'); ok('Undo removes the paste', (await items()).length === 0);
  await p.click('#btnRedo'); ok('Redo pastes again', (await items()).length === 4);
  await paste('Plain text from elsewhere'); await p.waitForTimeout(100);
  ok('Pasting other text still creates a text item', (await items()).some((i) => (i.text || '').includes('Plain text from elsewhere')));
  // Ctrl+X / Ctrl+D
  const alpha = (await items()).find((i) => i.text === 'Alpha');
  await ev((id) => __wb.setSel([id]), alpha.id); await p.keyboard.press('Control+x');
  ok('Ctrl+X cuts', !(await items()).some((i) => i.id === alpha.id) && (await ev(() => __wb.readClip().items[0].text)) === 'Alpha');
  await p.click('#btnUndo'); ok('Undo cut brings it back', (await items()).some((i) => i.id === alpha.id));
  await ev((id) => __wb.setSel([id]), alpha.id); const n0 = (await items()).length; await p.keyboard.press('Control+d');
  ok('Ctrl+D duplicates', (await items()).length === n0 + 1 && (await items()).filter((i) => i.text === 'Alpha').length === 2);
  // Copy to another board (context bar › Copy menu › Copy to another board…)
  await ev((id) => __wb.setSel([id]), alpha.id); await p.waitForTimeout(60);
  await p.click('#ctxbar [data-act=clip]'); await p.click('.popover [data-clip=send]');
  await p.click(`.result[data-board="${src}"]`); await p.waitForTimeout(300);
  const srcRec = await ev((id) => __wb.db.get('boards', id), src);
  const sent = srcRec.items.filter((i) => i.text === 'Alpha');
  ok('Copy to another board adds a copy below that board\'s content', srcRec.items.length === 5 && sent.length === 2 && Math.max(...sent.map((i) => i.y)) >= 260, JSON.stringify(sent.map((i) => [i.x, i.y])));
  ok('Copy to another board leaves this board unchanged', (await items()).length === n0 + 1 && (await ev(() => __wb.S.board.id)) === tgt);
  ok('Other board is marked for sync', srcRec.dirty === true);
  // clipboard picture (+ › Paste)
  await ev(async (b64) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bin], { type: 'image/png' }) })]); }, PNG.toString('base64'));
  await p.click('#btnInsert'); await p.click('.popover >> text=Paste (copied items, picture or text)'); await p.waitForTimeout(500);
  ok('+ › Paste inserts a picture from the system clipboard', (await items()).some((i) => i.type === 'image'));
  await p.click('#btnUndo'); ok('Undo removes the pasted picture', !(await items()).some((i) => i.type === 'image'));
  // paste event with an image file
  await ev(async (b64) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bin], 'x.png', { type: 'image/png' })); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, PNG.toString('base64'));
  await p.waitForTimeout(500);
  ok('Ctrl+V with a copied picture inserts it', (await items()).some((i) => i.type === 'image'));

  // ---- (g) camera + dictation
  const cam = await ev(() => { const e = document.getElementById('fileCamera'); return e && [e.getAttribute('capture'), e.accept]; });
  ok('Camera input exists (capture=environment, images)', cam && cam[0] === 'environment' && cam[1] === 'image/*', JSON.stringify(cam));
  await p.click('#btnInsert'); ok('+ menu offers Take a photo and Dictate', await p.isVisible('.popover >> text=Take a photo') && await p.isVisible('.popover >> text=Dictate a sticky note'));
  await closePops();
  const imgs0 = (await items()).filter((i) => i.type === 'image').length;
  await p.setInputFiles('#fileCamera', { name: 'photo.png', mimeType: 'image/png', buffer: PNG }); await p.waitForTimeout(600);
  ok('A camera photo is placed on the board', (await items()).filter((i) => i.type === 'image').length === imgs0 + 1);
  await ev(mockSR);
  await ev(() => __wb.dictateNote()); await p.waitForTimeout(250);
  ok('Dictation: speech fills the note text', (await p.inputValue('.dict-text')) === 'buy oat milk');
  await p.click('.dict-create'); await p.waitForTimeout(100);
  let dn = (await items()).find((i) => i.type === 'note' && i.text === 'buy oat milk');
  ok('Dictation: Create note adds a sticky note', !!dn);
  await p.click('#btnUndo'); ok('Undo removes the dictated note', !(await items()).some((i) => i.text === 'buy oat milk'));
  await ev(() => __wb.dictateNote()); await p.waitForTimeout(80); await p.keyboard.press('Escape'); await p.click('#modal .sheet [aria-label=Close]').catch(() => {}); await p.waitForTimeout(80);
  ok('Closing the dictation dialog stops listening', (await ev(() => window.__srStopped || 0)) >= 1);
  await ev(() => { delete window.webkitSpeechRecognition; delete window.SpeechRecognition; });
  await ev(() => __wb.dictateNote()); await p.waitForTimeout(100);
  ok('No speech API: friendly fallback (keyboard microphone hint)', (await p.textContent('.dict-status')).includes('keyboard'));
  await p.fill('.dict-text', 'typed instead'); await p.click('.dict-create');
  ok('Fallback: typed text becomes a note', (await items()).some((i) => i.text === 'typed instead'));

  // ---- (i) handwriting smoothing + shape recognition
  await blank('Ink'); await ev(() => { __wb.S.view = { x: 300, y: 150, scale: 0.6 }; });
  await p.click('.toolbar [data-tool=pen]');
  const stroke = async (pts) => { const s = await Promise.all(pts.map(([x, y]) => scr(x, y))); await p.mouse.move(s[0].x, s[0].y); await p.mouse.down(); for (const q of s.slice(1)) await p.mouse.move(q.x, q.y, { steps: 6 }); await p.mouse.up(); await p.waitForTimeout(100); };
  const wobble = (pts) => pts.map(([x, y], i) => [x + ((i * 7) % 5) - 2, y + ((i * 11) % 5) - 2]);
  const rectPts = wobble([[0, 0], [100, 2], [200, 0], [202, 60], [200, 120], [100, 122], [0, 120], [2, 60], [3, 4]]);
  await stroke(rectPts);
  it = await items();
  ok('Smoothing on (default): stroke is kept as smoothed ink', it.length === 1 && it[0].type === 'stroke', JSON.stringify(it.map((i) => i.type)));
  await p.click('.toolbar [data-tool=pen]'); await p.click('.popover >> text=Shape recognition: off');
  ok('Pen menu toggles shape recognition', await ev(() => __wb.PREF.shapes === true && localStorage.getItem('wb-shapes') === '1'));
  await stroke(rectPts.map(([x, y]) => [x, y + 300]));
  it = await items(); let last = it[it.length - 1];
  ok('Rough box → clean rectangle', last.type === 'rect' && Math.abs(last.x2 - last.x1 - 200) < 25 && Math.abs(last.y2 - last.y1 - 120) < 25, JSON.stringify(last));
  await p.click('#btnUndo'); it = await items(); last = it[it.length - 1];
  ok('Undo once keeps the hand-drawn stroke', it.length === 2 && last.type === 'stroke');
  await p.click('#btnRedo'); ok('Redo makes it a rectangle again', (await items()).slice(-1)[0].type === 'rect');
  const circ = []; for (let a = 0; a <= 360; a += 20) { const r = 80 + (a % 40 ? 3 : -3); circ.push([500 + r * Math.cos(a * Math.PI / 180), 100 + r * Math.sin(a * Math.PI / 180)]); }
  await stroke(circ); ok('Rough circle → clean ellipse', (await items()).slice(-1)[0].type === 'ellipse', (await items()).slice(-1)[0].type);
  await stroke(wobble([[0, 600], [100, 603], [200, 598], [300, 602]])); ok('Rough line → straight line', (await items()).slice(-1)[0].type === 'line', (await items()).slice(-1)[0].type);
  await stroke([[0, 800], [150, 800], [300, 800], [260, 770], [300, 800], [262, 832]]); ok('Line with a head → arrow', (await items()).slice(-1)[0].type === 'arrow', (await items()).slice(-1)[0].type);
  await stroke([[600, 400], [640, 470], [660, 410], [700, 480], [720, 400], [760, 470]]); ok('Scribble stays ink', (await items()).slice(-1)[0].type === 'stroke');
  await p.click('#btnMore'); await p.click('.popover >> text=Shape recognition'); await closePops();
  ok('More menu toggles shape recognition off', await ev(() => __wb.PREF.shapes === false));
  await stroke(rectPts.map(([x, y]) => [x + 900, y])); ok('Recognition off: box stays ink', (await items()).slice(-1)[0].type === 'stroke');
  const cnt = await ev(() => __wb.S.board.items.slice(-1)[0].points.length);
  await p.click('.toolbar [data-tool=pen]'); await p.click('.popover >> text=Smooth handwriting: on');
  await stroke(rectPts.map(([x, y]) => [x + 900, y + 300]));
  const cnt2 = await ev(() => __wb.S.board.items.slice(-1)[0].points.length);
  ok('Smoothing simplifies the stroke; off keeps raw points', cnt < cnt2, `${cnt} vs ${cnt2}`);
  await p.click('.toolbar [data-tool=pen]'); await p.click('.popover >> text=Smooth handwriting: off'); await ev(() => __wb.setTool('select'));

  // ---- (h) board picker: thumbnails, pins, tags, filter
  await p.click('#btnBoards'); await p.waitForTimeout(300);
  const nb = await ev(() => __wb.S.boards.length);
  ok('Every board row has a thumbnail', (await p.locator('#boardList canvas.board-thumb').count()) === nb, nb);
  const painted = await ev((id) => { const c = document.querySelector(`.board-row[data-board="${id}"] canvas`); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const seen = new Set(); for (let i = 0; i < d.length; i += 16) seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]); return seen.size; }, src);
  ok('Thumbnail shows the board content', painted > 3, painted);
  await p.click(`.board-row[data-board="${src}"] .pin`); await p.waitForTimeout(200);
  ok('★ pins a board (shown first, under Pinned)', (await ev((id) => __wb.db.get('boards', id).then((r) => r.pinned), src)) === true && (await p.locator('#boardList .board-row').first().getAttribute('data-board')) === src && await p.isVisible('.list-head >> text=Pinned'));
  await p.click(`.board-row[data-board="${tgt}"] [aria-label^="Actions for"]`); await p.click('.popover >> text=Tags…');
  await p.fill('#modal input[name=tags]', 'work, #weekly, work'); await p.click('#modal button[type=submit]'); await p.waitForTimeout(250);
  const tr = await ev((id) => __wb.db.get('boards', id).then((r) => r.tags), tgt);
  ok('Tags… saves de-duplicated tags', JSON.stringify(tr) === '["work","weekly"]', JSON.stringify(tr));
  ok('Tag chips appear', await p.isVisible('.tag-chip[data-tag=work]') && await p.isVisible('.board-row .mini-tag >> text=#work'));
  await p.click('.tag-chip[data-tag=work]');
  ok('Tag chip filters the list', (await p.locator('#boardList .board-row').count()) === 1 && (await p.locator('#boardList .board-row').first().getAttribute('data-board')) === tgt);
  await p.click('.tag-chip[data-tag="★"]');
  ok('★ Pinned chip shows only pinned boards', (await p.locator('#boardList .board-row').count()) === 1 && (await p.locator('#boardList .board-row').first().getAttribute('data-board')) === src);
  await p.click('.tag-chip[data-tag=""]'); await p.fill('#boardSearch', 'ink');
  ok('Search filters by name', (await p.locator('#boardList .board-row').count()) === 1);
  await p.fill('#boardSearch', 'weekly'); ok('Search also matches tags', (await p.locator('#boardList .board-row').count()) === 1);
  await p.fill('#boardSearch', ''); ok('Clearing the filter shows all boards', (await p.locator('#boardList .board-row').count()) === nb);
  await p.click('#drawerClose');
  await ev(() => __wb.saveChainDone()); await ev(() => __wb.sync.syncNow().then(() => __wb.sync.syncNow()));
  const remote = await ev(async () => { const all = await __wb.adapter._all(); return all.filter((f) => f.folder === 'boards' && !f.trashed).map((f) => JSON.parse(f.content)); });
  ok('Pin and tags sync to Drive', remote.some((r) => r.name === 'Source' && r.pinned === true) && remote.some((r) => r.name === 'Target' && JSON.stringify(r.tags) === '["work","weekly"]'));
  // a second device receives them
  const p2 = await ctx.newPage(); p2.on('pageerror', (e) => errs.push('desk2: ' + e.message));
  await p2.goto(BASE + '?mock=1&nosw'); await p2.waitForFunction(() => window.__wb && __wb.S.board);
  await p2.evaluate(() => __wb.db.get('boards', 'nonexistent'));
  await p2.close();

  // ---- (j) Drive inbox
  const inbox = (name, content) => ev(([n, c]) => __wb.adapter.createFile('inbox', n, c, 'application/json'), [name, content]);
  const doSync = () => ev(() => __wb.sync.syncNow().then(() => __wb.sync.syncNow()));
  const nBefore = await ev(() => __wb.db.all('boards').then((a) => a.filter((b) => !b.deleted).length));
  const spec = { type: 'new-board', name: 'Weekly Review – {{date}}', id: 'weekly-2026-11-16', template: 'Weekly Review', replace: { '{{date}}': '16 Nov 2026' }, notes: ['Ship batch 3', { text: 'Plan {{date}}', color: '#c8e6c9', tags: ['plan'], due: '2026-11-20' }], tags: ['weekly'], pinned: true };
  await inbox('weekly.json', JSON.stringify(spec));
  await doSync();
  const wb = await ev(() => __wb.db.get('boards', 'b-inbox-weekly-2026-11-16'));
  ok('Inbox JSON creates a board on sync', !!wb && wb.name === 'Weekly Review – 16 Nov 2026', wb && wb.name);
  ok('Board is built from the named template with {{date}} replaced', wb && wb.items.some((i) => (i.text || '').includes('Weekly Review – 16 Nov 2026')) && !wb.items.some((i) => /\{\{/.test(i.text || '') || /\{\{/.test(i.title || '')));
  ok('Extra notes are added (text, colour, tags, due)', wb && wb.items.some((i) => i.text === 'Ship batch 3') && wb.items.some((i) => i.text === 'Plan 16 Nov 2026' && i.color === '#c8e6c9' && i.tags[0] === 'plan' && i.due === '2026-11-20'));
  ok('Board tags + pinned from the file', wb && wb.pinned === true && wb.tags[0] === 'weekly');
  let files = await ev(() => __wb.adapter._all());
  ok('Processed inbox file is moved to the Drive bin', files.filter((f) => f.folder === 'inbox' && f.name === 'weekly.json').every((f) => f.trashed));
  ok('New board is uploaded to Drive boards/', files.some((f) => f.folder === 'boards' && !f.trashed && JSON.parse(f.content).id === 'b-inbox-weekly-2026-11-16'));
  await inbox('weekly-again.json', JSON.stringify(spec)); await doSync();
  const nAfter = await ev(() => __wb.db.all('boards').then((a) => a.filter((b) => !b.deleted).length));
  ok('Idempotent: same "id" again does not create a second board', nAfter === nBefore + 1, `${nBefore} → ${nAfter}`);
  files = await ev(() => __wb.adapter._all());
  ok('…and the duplicate file is still cleaned up', files.filter((f) => f.folder === 'inbox' && f.name === 'weekly-again.json').every((f) => f.trashed));
  await inbox('bad.json', '{ not json'); await inbox('notype.json', '{"name":"x"}'); await inbox('tpl.json', '{"type":"new-board","name":"X","template":"Nope"}');
  await doSync(); files = await ev(() => __wb.adapter._all());
  const errNames = files.filter((f) => f.folder === 'inbox' && !f.trashed).map((f) => f.name);
  ok('Invalid JSON is renamed ERROR – … and left in the inbox', errNames.some((n) => n.startsWith('ERROR – not valid JSON – bad.json')), JSON.stringify(errNames));
  ok('Missing "type" is reported', errNames.some((n) => n.startsWith('ERROR') && n.includes('"type" must be "new-board"') && n.endsWith('notype.json')));
  ok('Unknown template is reported with the valid names', errNames.some((n) => n.startsWith('ERROR') && n.includes('unknown template') && n.includes('Weekly Review') && n.endsWith('tpl.json')));
  await doSync(); files = await ev(() => __wb.adapter._all());
  ok('ERROR files are skipped on later syncs (not renamed twice)', files.filter((f) => f.folder === 'inbox' && !f.trashed && f.name.startsWith('ERROR – ERROR')).length === 0);
  await inbox('plain.json', '{"type":"new-board","name":"Notes {{date}}"}'); await doSync();
  const today = await ev(() => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }));
  const plain = await ev(() => __wb.db.all('boards').then((a) => a.find((b) => b.name.startsWith('Notes '))));
  ok('Minimal file: blank board, {{date}} defaults to today', plain && plain.name === 'Notes ' + today && plain.id.startsWith('b-inbox-'), plain && plain.name);
  await p.click('#btnBoards'); await p.waitForTimeout(200);
  ok('Inbox board shows in the picker (pinned)', await p.isVisible('.board-row[data-board="b-inbox-weekly-2026-11-16"]'));
  await p.click('.board-row[data-board="b-inbox-weekly-2026-11-16"] .board-open'); await p.waitForTimeout(300);
  ok('Inbox board opens', (await ev(() => __wb.S.board.name)) === 'Weekly Review – 16 Nov 2026');
  await p.screenshot({ path: '/tmp/f3-desk.png' });
  // a template edited on Drive (e.g. the updated Weekly Review copy) reaches devices that already have it
  const tf = await ev(() => __wb.adapter.createFile('templates', 'Mine.template.json', { app: 'my-whiteboard', kind: 'template', id: 'tpl-mine', name: 'Mine', items: [] }, 'application/json'));
  await doSync(); ok('Template from Drive is pulled', (await ev(() => __wb.db.get('templates', 'tpl-mine').then((t) => t && t.items.length))) === 0);
  await p.waitForTimeout(20);
  await ev((id) => __wb.adapter.updateFile(id, 'Mine.template.json', { app: 'my-whiteboard', kind: 'template', id: 'tpl-mine', name: 'Mine', items: [{ id: 'x', type: 'text', x: 0, y: 0, text: 'v2 {{date}}', fontSize: 20, color: 'ink' }] }, 'application/json'), tf.id);
  await doSync(); ok('Template edited on Drive is re-pulled', (await ev(() => __wb.db.get('templates', 'tpl-mine').then((t) => t.items.length))) === 1);
  // template from the UI also fills {{date}}
  await ev(() => __wb.createBoard(__wb.BUILTIN_TEMPLATES.find((t) => t.name === 'Meeting Notes'))); await p.waitForTimeout(200);
  ok('New board from a template fills {{date}} with today', (await items()).some((i) => (i.text || '').includes('Date: ' + today)));
  await ctx.close();
}

// ================= PHONE 390px =================
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push('phone: ' + e.message));
  const ev = (fn, a) => p.evaluate(fn, a);
  const scr = (x, y) => ev(([x, y]) => __wb.toScreen({ x, y }), [x, y]);
  const items = () => ev(() => __wb.S.board.items);
  const cdp = await ctx.newCDPSession(p);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i })) });
  const tap = async (q) => { await touch('touchStart', [[q.x, q.y]]); await touch('touchEnd', []); await p.waitForTimeout(150); };
  const tapEl = async (sel) => { const r = await p.locator(sel).first().boundingBox(); await tap({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); };
  const stroke = async (pts) => { const s = await Promise.all(pts.map(([x, y]) => scr(x, y))); await touch('touchStart', [[s[0].x, s[0].y]]); for (let i = 1; i < s.length; i++) for (let k = 1; k <= 5; k++) { await touch('touchMove', [[s[i - 1].x + (s[i].x - s[i - 1].x) * k / 5, s[i - 1].y + (s[i].y - s[i - 1].y) * k / 5]]); } await p.waitForTimeout(250); await touch('touchEnd', []); await p.waitForTimeout(150); };
  await p.addInitScript(mockSR);
  await p.goto(BASE + '?mock=1&nosw'); await p.waitForFunction(() => window.__wb && __wb.S.board);
  await ev(() => __wb.createBoard({ name: 'Phone A', items: [{ id: 'pa', type: 'note', x: 0, y: 0, w: 200, h: 160, text: 'Phone note', color: '#fff59d', fontSize: 20 }] }, 'Phone A')); await p.waitForTimeout(200);
  const A = await ev(() => __wb.S.board.id);
  await ev(() => { __wb.S.view = { x: 90, y: 250, scale: 1 }; __wb.setTool('select'); });
  await tap(await scr(100, 80));
  ok('Phone: tap selects the note', (await ev(() => __wb.S.sel)).length === 1);
  const bar = await p.locator('#ctxbar').boundingBox();
  ok('Phone: context bar fits the 390px screen', bar.x >= 0 && bar.x + bar.width <= 390, JSON.stringify(bar));
  await tapEl('#ctxbar [data-act=clip]'); await p.waitForSelector('.popover [data-clip=copy]'); await tapEl('.popover [data-clip=copy]');
  ok('Phone: Copy from the context bar', (await ev(() => __wb.readClip() && __wb.readClip().items.length)) === 1);
  await ev(() => __wb.createBoard({ name: 'Phone B', items: [] }, 'Phone B')); await p.waitForTimeout(200);
  await tapEl('#btnInsert'); await p.waitForSelector('.popover >> text=Paste (copied items, picture or text)'); await tapEl('.popover >> text=Paste (copied items, picture or text)'); await p.waitForTimeout(300);
  ok('Phone: + › Paste puts it on another board', (await items()).some((i) => i.text === 'Phone note'));
  await tapEl('#btnInsert'); await p.waitForSelector('.popover >> text=Take a photo');
  const [chooser] = await Promise.all([p.waitForEvent('filechooser'), tapEl('.popover >> text=Take a photo')]);
  ok('Phone: Take a photo opens the camera picker', chooser && chooser.element && (await chooser.element().getAttribute('capture')) === 'environment');
  await chooser.setFiles({ name: 'cam.png', mimeType: 'image/png', buffer: PNG }); await p.waitForTimeout(600);
  ok('Phone: photo lands on the board', (await items()).some((i) => i.type === 'image'));
  await tapEl('#btnInsert'); await p.waitForSelector('.popover >> text=Dictate a sticky note'); await tapEl('.popover >> text=Dictate a sticky note'); await p.waitForTimeout(300);
  ok('Phone: dictation fills the text', (await p.inputValue('.dict-text')) === 'buy oat milk');
  await tapEl('.dict-create'); await p.waitForTimeout(150);
  ok('Phone: dictated note created', (await items()).some((i) => i.type === 'note' && i.text === 'buy oat milk'));
  // shape recognition with a finger
  await ev(() => { __wb.setTool('pen'); __wb.PREF.shapes = true; __wb.S.view = { x: 60, y: 300, scale: 1 }; });
  await stroke([[0, 0], [130, 2], [260, 0], [262, 80], [260, 160], [130, 162], [0, 160], [2, 80], [3, 3]]);
  ok('Phone: finger-drawn box becomes a rectangle', (await items()).slice(-1)[0].type === 'rect', (await items()).slice(-1)[0].type);
  await tapEl('#btnUndo'); ok('Phone: undo keeps the drawing', (await items()).slice(-1)[0].type === 'stroke');
  await ev(() => { __wb.PREF.shapes = false; __wb.setTool('select'); });
  // drawer on phone
  await tapEl('#btnBoards'); await p.waitForTimeout(350);
  const rowA = `.board-row[data-board="${A}"]`;
  const rb = await p.locator(rowA).boundingBox();
  ok('Phone: board rows fit, with thumbnail and pin', rb.x >= 0 && rb.x + rb.width <= 390 && await p.isVisible(rowA + ' canvas.board-thumb') && await p.isVisible(rowA + ' .pin'), JSON.stringify(rb));
  const pin = await p.locator(rowA + ' .pin').boundingBox();
  ok('Phone: pin button is a comfortable tap target', pin.width >= 36 && pin.height >= 36, JSON.stringify(pin));
  await tapEl(rowA + ' .pin'); await p.waitForTimeout(250);
  ok('Phone: tap ★ pins the board', (await ev((id) => __wb.db.get('boards', id).then((r) => r.pinned), A)) === true && (await p.locator('#boardList .board-row').first().getAttribute('data-board')) === A);
  await tapEl('.tag-chip[data-tag="★"]'); ok('Phone: Pinned chip filters', (await p.locator('#boardList .board-row').count()) === 1);
  await p.screenshot({ path: '/tmp/f3-phone-drawer.png' });
  await tapEl('.tag-chip[data-tag=""]');
  await ctx.close();
}

await b.close();
ok('No page errors', errs.length === 0, errs.join(' | '));
const f = res.filter((r) => r[0] === 'FAIL');
console.log(`${res.length - f.length}/${res.length} passed`);
process.exit(f.length ? 1 : 0);
