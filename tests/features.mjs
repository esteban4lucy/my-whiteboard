// Lock / multi-select / group / text formatting / Kanban template – desktop + 390px phone.
import { chromium } from 'playwright-core';
import fs from 'fs';
const BASE = 'http://127.0.0.1:8765/my-whiteboard/';
const res = []; const ok = (n, c, i = '') => { res.push([c ? 'PASS' : 'FAIL', n, i]); console.log(c ? 'PASS' : 'FAIL', n, i); };
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const errs = [];

// ================= DESKTOP =================
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push('desk: ' + e.message));
  const ev = (fn, a) => p.evaluate(fn, a);
  const scr = (x, y) => ev(([x, y]) => __wb.toScreen({ x, y }), [x, y]);
  const items = () => ev(() => __wb.S.board.items);
  const sel = () => ev(() => __wb.S.sel.length);
  async function drag(a, z, steps = 10, mods = []) { for (const m of mods) await p.keyboard.down(m); await p.mouse.move(a.x, a.y); await p.mouse.down(); await p.mouse.move(z.x, z.y, { steps }); await p.mouse.up(); for (const m of mods) await p.keyboard.up(m); await p.waitForTimeout(80); }
  await p.goto(BASE + '?mock=1&nosw'); await p.waitForFunction(() => window.__wb && __wb.S.board);

  // Kanban template
  await p.click('#btnBoards'); await p.click('#btnNewBoard'); await p.click('.tpl-main:has-text("Kanban")'); await p.click('button[type=submit]'); await p.waitForTimeout(300);
  await ev(() => { __wb.S.view = { x: 80, y: 140, scale: 0.75 }; }); await p.waitForTimeout(50);
  let it = await items();
  const locked = it.filter((i) => i.locked), groups = new Set(locked.map((i) => i.groupId));
  ok('Kanban template: 4 locked column groups (frame + bold header)', locked.length === 8 && groups.size === 4 && locked.some((i) => i.type === 'text' && i.bold));
  const col = it.find((i) => i.type === 'rect' && i.x1 === 320); // "To do" column frame
  await p.click('.toolbar [data-tool=select]');
  // drag on locked column (empty area) → pans
  const v0 = await ev(() => ({ ...__wb.S.view }));
  const empty = await scr(col.x1 + 150, 700);
  await drag(empty, { x: empty.x + 80, y: empty.y - 40 });
  const v1 = await ev(() => ({ ...__wb.S.view }));
  it = await items();
  ok('Dragging on a locked column pans (column stays, nothing selected)', v1.x !== v0.x && it.find((i) => i.id === col.id).x1 === 320 && (await sel()) === 0);
  // drag a note across a column
  const note = it.find((i) => i.type === 'note' && i.x === 350);
  const nc = await scr(note.x + 120, note.y + 75);
  const dst = await scr(670 + 120, 600);
  await drag(nc, dst);
  it = await items();
  const moved = it.find((i) => i.id === note.id);
  ok('Sticky note drags over/between locked columns', moved.x > 600 && it.find((i) => i.id === col.id).x1 === 320, `${note.x}->${moved.x}`);
  // eraser can't erase locked frame
  await p.click('.toolbar [data-tool=eraser]');
  const edge = await scr(col.x1, 300); await drag({ x: edge.x, y: edge.y - 30 }, { x: edge.x, y: edge.y + 30 });
  ok('Eraser does not erase locked items', (await items()).some((i) => i.id === col.id));
  await p.click('.toolbar [data-tool=select]');
  // long-press locked column → selects its group, shows Locked + Unlock
  const lp = await scr(col.x1 + 150, 720);
  await p.mouse.move(lp.x, lp.y); await p.mouse.down(); await p.waitForTimeout(750); await p.mouse.up(); await p.waitForTimeout(100);
  ok('Long-press on locked item selects it (whole group) with lock indicator', (await sel()) === 2 && (await p.textContent('#ctxbar')).includes('Locked') && await p.isVisible('#ctxbar [data-act=unlock]'));
  await p.screenshot({ path: '/tmp/f-locked.png' });
  // a locked selection cannot be dragged or deleted
  await drag(lp, { x: lp.x + 50, y: lp.y }); await p.keyboard.press('Delete');
  ok('Locked selection cannot be moved or deleted', (await items()).find((i) => i.id === col.id).x1 === 320);
  await p.mouse.move(lp.x, lp.y); await p.mouse.down(); await p.waitForTimeout(750); await p.mouse.up(); await p.waitForTimeout(100);
  await p.click('#ctxbar [data-act=unlock]');
  ok('Unlock button unlocks the group', !(await items()).filter((i) => i.groupId === col.groupId).some((i) => i.locked));
  await p.click('#btnUndo'); ok('Undo re-locks', (await items()).filter((i) => i.groupId === col.groupId).every((i) => i.locked));
  await p.click('#btnRedo'); ok('Redo unlocks again', !(await items()).filter((i) => i.groupId === col.groupId).some((i) => i.locked));
  // move the now-unlocked column (group) – frame + header move together
  const hdr0 = (await items()).find((i) => i.groupId === col.groupId && i.type === 'text');
  const cc = await scr(col.x1 + 150, 730); await drag(cc, { x: cc.x, y: cc.y + 60 });
  const hdr1 = (await items()).find((i) => i.id === hdr0.id), col1 = (await items()).find((i) => i.id === col.id);
  ok('Grouped column moves together once unlocked', col1.y1 > 20 && Math.abs((hdr1.y - hdr0.y) - (col1.y1 - col.y1)) < 0.01, `dy frame ${col1.y1 - col.y1}, header ${hdr1.y - hdr0.y}`);
  await p.click('#btnUndo');
  // lock it back via ctxbar
  await p.mouse.click(cc.x, cc.y); await p.click('#ctxbar [data-act=lock]');
  ok('Lock button locks selection & deselects', (await items()).filter((i) => i.groupId === col.groupId).every((i) => i.locked) && (await sel()) === 0);
  // Unlock all via ⋯ menu
  await p.click('#btnMore'); await p.click('.popover >> text=Unlock all items');
  ok('⋯ › Unlock all unlocks every item', !(await items()).some((i) => i.locked));
  await p.click('#btnUndo'); ok('Undo of Unlock all re-locks', (await items()).filter((i) => i.locked).length === 8);

  // ---- multi-select + group on a fresh blank board
  await ev(() => __wb.createBoard(__wb.BUILTIN_TEMPLATES[0], 'Group test')); await p.waitForTimeout(200);
  await ev(() => { __wb.S.view = { x: 0, y: 0, scale: 1 }; __wb.commit(() => __wb.S.board.items.push(
    { id: 'n1', type: 'note', x: 200, y: 200, w: 200, h: 160, text: 'Alpha', color: '#fff59d', fontSize: 20 },
    { id: 'n2', type: 'note', x: 450, y: 200, w: 200, h: 160, text: 'Beta', color: '#ffcc80', fontSize: 20 },
    { id: 't1', type: 'text', x: 200, y: 450, text: 'Heading', fontSize: 28, color: 'ink' },
    { id: 'r1', type: 'rect', x1: 700, y1: 200, x2: 850, y2: 350, color: 'ink', size: 2 })); });
  await p.mouse.click(300, 280); await p.keyboard.down('Shift'); await p.mouse.click(550, 280); await p.keyboard.up('Shift');
  ok('Shift-click adds to selection', (await sel()) === 2);
  await p.keyboard.down('Shift'); await p.mouse.click(550, 280); await p.keyboard.up('Shift');
  ok('Shift-click again removes from selection', (await sel()) === 1);
  // marquee
  await ev(() => __wb.setSel([]));
  await drag({ x: 150, y: 150 }, { x: 680, y: 400 }, 10, ['Shift']);
  ok('Shift+drag box-select (marquee)', (await ev(() => __wb.S.sel.slice().sort().join(','))) === 'n1,n2', await ev(() => __wb.S.sel.join(',')));
  await p.click('#ctxbar [data-act=group]');
  it = await items();
  ok('Group: items share a groupId', it.find((i) => i.id === 'n1').groupId && it.find((i) => i.id === 'n1').groupId === it.find((i) => i.id === 'n2').groupId);
  await ev(() => __wb.setSel([])); await p.mouse.click(300, 280);
  ok('Clicking one member selects the whole group', (await sel()) === 2);
  await drag({ x: 300, y: 280 }, { x: 300, y: 380 });
  it = await items();
  ok('Group moves together', it.find((i) => i.id === 'n1').y === 300 && it.find((i) => i.id === 'n2').y === 300);
  // group resize via handle at bottom-right of group bounds
  const gb = { x: 650 + 6, y: 460 + 6 };
  await drag(gb, { x: gb.x + 225, y: gb.y + 80 });
  it = await items();
  const n1 = it.find((i) => i.id === 'n1'), n2 = it.find((i) => i.id === 'n2');
  ok('Group resizes together (uniform scale)', n1.w > 260 && Math.abs(n1.w - n2.w) < 0.01 && n2.x > 500, `w=${n1.w.toFixed(0)} n2.x=${n2.x.toFixed(0)}`);
  await p.click('#btnUndo'); it = await items();
  ok('Undo group resize', it.find((i) => i.id === 'n1').w === 200);
  // lock group, sync, check JSON in Drive
  await p.mouse.click(300, 380); await p.click('#ctxbar [data-act=lock]');
  await ev(() => __wb.saveChainDone()); await ev(() => __wb.sync.syncNow().then(() => __wb.sync.syncNow()));
  const remote = await ev(() => __wb.adapter._all().then((a) => JSON.parse(a.find((f) => f.folder === 'boards' && !f.trashed && f.name === 'Group test.board.json').content)));
  const rn1 = remote.items.find((i) => i.id === 'n1');
  ok('Lock + group persist in board JSON and sync to Drive', rn1.locked === true && !!rn1.groupId && remote.items.find((i) => i.id === 'n2').groupId === rn1.groupId);
  await p.reload(); await p.waitForFunction(() => window.__wb && __wb.S.board); await ev(() => { __wb.S.view = { x: 0, y: 0, scale: 1 }; });
  ok('Lock + group survive reload', (await items()).filter((i) => i.locked && i.groupId).length === 2);
  await p.click('.toolbar [data-tool=select]'); await p.keyboard.press('Escape');
  await p.mouse.click(300, 380);
  ok('Locked group is not selectable by normal click', (await sel()) === 0);
  // keyboard: Ctrl+A selects only unlocked; Ctrl+L toggles; Ctrl+G / Ctrl+Shift+G
  await p.keyboard.press('Control+a'); ok('Ctrl+A selects all unlocked items', (await sel()) === 2, JSON.stringify(await ev(() => __wb.S.sel.map((id) => __wb.S.board.items.find((i) => i.id === id)))));
  await p.keyboard.press('Control+g'); it = await items();
  ok('Ctrl+G groups', it.find((i) => i.id === 't1').groupId && it.find((i) => i.id === 't1').groupId === it.find((i) => i.id === 'r1').groupId);
  await p.keyboard.press('Control+Shift+g'); it = await items();
  ok('Ctrl+Shift+G ungroups', !it.find((i) => i.id === 't1').groupId && !it.find((i) => i.id === 'r1').groupId);
  await ev(() => __wb.setSel(['r1'])); await p.keyboard.press('Control+l');
  ok('Ctrl+L locks', (await items()).find((i) => i.id === 'r1').locked === true);
  await p.click('#btnUndo');
  // ---- text formatting
  await ev(() => __wb.setSel(['t1'])); await p.click('#ctxbar [data-act=format]');
  await p.click('.popover [data-size=XL]'); await p.click('.popover .fmt-b'); await p.click('.popover .fmt-i'); await p.click('.popover .fmt-color >> nth=1');
  let t1 = (await items()).find((i) => i.id === 't1');
  ok('Free text: size XL, bold, italic, colour', t1.fontSize === 64 && t1.bold && t1.italic && t1.color === '#e53935', JSON.stringify(t1));
  await p.click('#btnUndo'); t1 = (await items()).find((i) => i.id === 't1');
  ok('Undo text colour', t1.color === 'ink' && t1.bold);
  await p.click('#btnMore'); await p.click('.popover >> text=Unlock all items');
  await ev(() => __wb.setSel(['n1', 'n2']));
  await p.click('#ctxbar [data-act=format]'); await p.click('.popover [data-size=L]'); await p.click('.popover .fmt-b'); await p.click('.popover .fmt-color >> nth=5');
  it = await items();
  ok('Sticky notes (multi): size L, bold, text colour', ['n1', 'n2'].every((id) => { const n = it.find((i) => i.id === id); return n.fontSize === 26 && n.bold && n.textColor === '#1e88e5'; }));
  await p.keyboard.press('Escape'); await ev(() => __wb.setSel(['n1'])); await p.keyboard.press('Control+b');
  ok('Ctrl+B toggles bold', !(await items()).find((i) => i.id === 'n1').bold);
  // editor overlay reflects formatting
  await ev(() => __wb.setSel(['t1'])); await p.click('#ctxbar [data-act=edit]');
  ok('Text editor shows bold formatting', (await ev(() => getComputedStyle(document.querySelector('#editor')).fontWeight)) === '700');
  await p.keyboard.press('Escape');
  // export renders formatting: bold vs normal PNG differ
  const diff = await ev(async () => {
    const { renderBoardToCanvas } = await import('./js/export.js');
    const env = { theme: 'light', getImage: () => null };
    const mk = (bold) => renderBoardToCanvas({ background: 'solid', items: [{ id: 'x', type: 'note', x: 0, y: 0, w: 300, h: 160, text: 'Bold check WWW', color: '#fff59d', fontSize: 30, bold, textColor: '#e53935' }] }, env, { scale: 1 }).toDataURL();
    return mk(true) !== mk(false);
  });
  ok('PNG/PDF export renders bold/colour formatting', diff);
  const d = p.waitForEvent('download'); await p.click('#btnMore'); await p.click('.popover >> text=Export as PDF'); const pdf = fs.readFileSync(await (await d).path());
  ok('PDF export still valid with formatted/locked items', pdf.slice(0, 5).toString() === '%PDF-' && pdf.length > 2000);
  // backward compatibility: v1 board JSON without new fields
  fs.writeFileSync('/tmp/v1board.json', JSON.stringify({ app: 'my-whiteboard', schema: 1, name: 'Old v1 board', background: 'grid', items: [{ id: 'o1', type: 'note', x: 100, y: 100, w: 200, h: 160, text: 'Old note', color: '#fff59d' }, { id: 'o2', type: 'text', x: 100, y: 320, text: 'Old text', fontSize: 28, color: 'ink' }] }));
  await p.setInputFiles('#fileJSON', '/tmp/v1board.json'); await p.waitForTimeout(300);
  await ev(() => { __wb.S.view = { x: 0, y: 0, scale: 1 }; });
  await p.mouse.click(200, 180);
  ok('Old (v1) board JSON imports and items are selectable/movable', (await sel()) === 1);
  await p.screenshot({ path: '/tmp/f-desk.png' });
  await ctx.close();
}

// ================= PHONE 390px =================
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push('phone: ' + e.message));
  const cdp = await ctx.newCDPSession(p);
  const ev = (fn, a) => p.evaluate(fn, a);
  const scr = (x, y) => ev(([x, y]) => __wb.toScreen({ x, y }), [x, y]);
  const items = () => ev(() => __wb.S.board.items);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i, radiusX: 5, radiusY: 5, force: 1 })) });
  async function swipe(a, z, steps = 10) { await touch('touchStart', [[a.x, a.y]]); for (let i = 1; i <= steps; i++) await touch('touchMove', [[a.x + (z.x - a.x) * i / steps, a.y + (z.y - a.y) * i / steps]]); await touch('touchEnd', []); await p.waitForTimeout(80); }
  const tap = async (q) => { await touch('touchStart', [[q.x, q.y]]); await touch('touchEnd', []); await p.waitForTimeout(120); };
  const tapEl = async (sel) => { const r = await p.locator(sel).first().boundingBox(); await tap({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); };
  await p.goto(BASE + '?mock=1&nosw'); await p.waitForFunction(() => window.__wb && __wb.S.board);
  await tapEl('#btnBoards'); await p.waitForTimeout(250); await tapEl('#btnNewBoard'); await p.waitForSelector('.tpl-main:has-text("Kanban")');
  await tapEl('.tpl-main:has-text("Kanban")'); await p.waitForSelector('button[type=submit]'); await tapEl('button[type=submit]'); await p.waitForTimeout(300);
  await ev(() => { __wb.S.view = { x: 20, y: 180, scale: 0.55 }; });
  await tapEl('.toolbar [data-tool=select]');
  let it = await items(); const col = it.find((i) => i.type === 'rect' && i.x1 === 0);
  const v0 = await ev(() => ({ ...__wb.S.view }));
  const e1 = await scr(150, 600); await swipe(e1, { x: e1.x + 40, y: e1.y - 60 });
  ok('Phone: one-finger drag on locked column pans the board', (await ev(() => __wb.S.view.y)) !== v0.y && (await items()).find((i) => i.id === col.id).x1 === 0);
  it = await items(); const note = it.find((i) => i.type === 'note' && i.x === 30);
  const nc = await scr(note.x + 120, note.y + 75); await swipe(nc, { x: nc.x + 180, y: nc.y });
  ok('Phone: finger-drag a note over locked columns', (await items()).find((i) => i.id === note.id).x > 200);
  // long-press locked column
  const lp = await scr(150, 700);
  await touch('touchStart', [[lp.x, lp.y]]); await p.waitForTimeout(750); await touch('touchEnd', []); await p.waitForTimeout(150);
  ok('Phone: long-press selects locked column; Unlock shown', (await ev(() => __wb.S.sel.length)) === 2 && await p.isVisible('#ctxbar [data-act=unlock]'));
  const ub = await p.locator('#ctxbar [data-act=unlock]').boundingBox();
  ok('Phone: Unlock button is a large touch target (≥40px)', ub.width >= 40 && ub.height >= 40, `${ub.width}x${ub.height}`);
  await tapEl('#ctxbar [data-act=unlock]');
  ok('Phone: tap Unlock unlocks', !(await items()).some((i) => i.id === col.id && i.locked));
  await tapEl('#btnUndo');
  // multi-select via Select tool menu
  await ev(() => __wb.setSel([]));
  await tapEl('.toolbar [data-tool=select]'); await p.waitForSelector('.popover >> text=Multi-select'); await tapEl('.popover >> text=Multi-select');
  ok('Phone: multi-select mode banner', await p.isVisible('#multiBanner'));
  it = await items(); const notes = it.filter((i) => i.type === 'note' && !i.locked).slice(1, 3);
  for (const n of notes) { const q = await scr(n.x + 120, n.y + 100); await tap(q); }
  ok('Phone: tap-to-add selects several notes', (await ev(() => __wb.S.sel.length)) === 2 && (await p.textContent('#multiBanner')).includes('2 selected'), JSON.stringify(await ev(() => __wb.S.sel)) + JSON.stringify(notes.map((n) => [n.x, n.y])) + JSON.stringify(await ev(() => __wb.S.view)));
  await p.screenshot({ path: '/tmp/f-phone-multi.png' });
  await tapEl('#ctxbar [data-act=group]');
  it = await items();
  ok('Phone: Group from context bar', it.find((i) => i.id === notes[0].id).groupId && it.find((i) => i.id === notes[0].id).groupId === it.find((i) => i.id === notes[1].id).groupId);
  await tapEl('#multiDone');
  ok('Phone: Done leaves multi-select mode', !(await p.isVisible('#multiBanner')));
  // format on phone
  await tapEl('#ctxbar [data-act=format]'); await p.waitForSelector('.popover [data-size=XL]');
  await tapEl('.popover [data-size=XL]'); await tapEl('.popover .fmt-b');
  it = await items();
  ok('Phone: format grouped notes XL + bold', notes.every((n) => { const x = it.find((i) => i.id === n.id); return x.fontSize === 34 && x.bold; }));
  const fb = await p.locator('.popover .fmt-b').boundingBox();
  ok('Phone: format buttons ≥44px', fb.width >= 44 && fb.height >= 44);
  await p.screenshot({ path: '/tmp/f-phone-format.png' });
  const cb = await ev(() => { const c = document.querySelector('#ctxbar'); return { w: c.offsetWidth, sw: c.scrollWidth }; });
  ok('Phone: context bar fits on screen (scrolls if needed)', cb.w <= 390 - 16 + 1, JSON.stringify(cb));
  await ctx.close();
}
ok('No uncaught JS errors', errs.length === 0, errs.join(' | '));
await b.close();
fs.writeFileSync('/tmp/wb-feature-results.json', JSON.stringify(res, null, 1));
console.log(`${res.filter((r) => r[0] === 'PASS').length}/${res.length} passed`);
