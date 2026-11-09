// Batch 2: connectors, Kanban notes (column snap, tags, due dates, checklists), frames + mini-map + present mode,
// align/distribute + snap to grid, layers + lock background – desktop + 390px phone.
import { chromium } from 'playwright-core';
import fs from 'fs';
const BASE = 'http://127.0.0.1:8765/my-whiteboard/';
const res = []; const ok = (n, c, i = '') => { res.push([c ? 'PASS' : 'FAIL', n, i]); console.log(c ? 'PASS' : 'FAIL', n, i); };
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const errs = [];
const near = (a, b, t = 1) => Math.abs(a - b) <= t;

// ================= DESKTOP =================
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push('desk: ' + e.message));
  const ev = (fn, a) => p.evaluate(fn, a);
  const scr = (x, y) => ev(([x, y]) => __wb.toScreen({ x, y }), [x, y]);
  const items = () => ev(() => __wb.S.board.items);
  const get = async (id) => (await items()).find((i) => i.id === id);
  const sel = () => ev(() => __wb.S.sel.slice());
  async function drag(a, z, steps = 12) { await p.mouse.move(a.x, a.y); await p.mouse.down(); await p.mouse.move(z.x, z.y, { steps }); await p.mouse.up(); await p.waitForTimeout(80); }
  async function dragW(a, z) { await drag(await scr(a.x, a.y), await scr(z.x, z.y)); }
  async function clickW(x, y) { const q = await scr(x, y); await p.mouse.click(q.x, q.y); await p.waitForTimeout(60); }
  const blank = async (name, its = []) => { await ev(([n, its]) => __wb.createBoard({ name: n, items: its }, n), [name, its]); await p.waitForTimeout(200); await ev(() => { __wb.S.view = { x: 100, y: 150, scale: 1 }; }); await p.click('.toolbar [data-tool=select]').catch(() => {}); await ev(() => __wb.setTool('select')); };
  await p.goto(BASE + '?mock=1&nosw'); await p.waitForFunction(() => window.__wb && __wb.S.board);

  // ---- (a) connectors
  await blank('Connectors', [
    { id: 'A', type: 'note', x: 0, y: 0, w: 200, h: 160, text: 'A', color: '#fff59d', fontSize: 20 },
    { id: 'B', type: 'note', x: 500, y: 0, w: 200, h: 160, text: 'B', color: '#b3e5fc', fontSize: 20 },
  ]);
  const idA = (await items())[0].id, idB = (await items())[1].id;
  await p.click('.toolbar [data-tool=shape]'); await p.click('.toolbar [data-tool=shape]'); await p.click('.popover [aria-label=arrow]');
  await dragW({ x: 100, y: 80 }, { x: 600, y: 80 });
  let arr = (await items()).find((i) => i.type === 'arrow');
  ok('Arrow drawn from note to note attaches both ends', arr && arr.from === idA && arr.to === idB, JSON.stringify(arr));
  ok('Attached arrow ends sit on the note edges', arr && near(arr.x1, 206, 2) && near(arr.x2, 494, 2), `${arr && arr.x1},${arr && arr.x2}`);
  await ev(() => __wb.setTool('select'));
  await dragW({ x: 600, y: 120 }, { x: 600, y: 420 });
  arr = await get(arr.id);
  ok('Arrow follows when a connected note moves', arr.y2 > 250 && arr.to === idB, `y2=${arr.y2}`);
  await p.click('#btnUndo'); await p.waitForTimeout(50); arr = await get(arr.id);
  ok('Undo moves the arrow back with the note', near(arr.y2, 80, 2), `y2=${arr.y2}`);
  await p.click('#btnRedo'); await p.click('#btnUndo');
  // drag the arrow's end handle into empty space → detaches
  await ev((id) => __wb.setSel([id]), arr.id); await p.waitForTimeout(50);
  await dragW({ x: arr.x2, y: arr.y2 }, { x: 420, y: 400 });
  arr = await get(arr.id);
  ok('Dragging an arrow end into empty space detaches it', !arr.to && arr.from === idA && near(arr.x2, 420, 3), JSON.stringify(arr));
  await dragW({ x: arr.x2, y: arr.y2 }, { x: 600, y: 60 });
  arr = await get(arr.id);
  ok('Dropping the end on a note re-attaches it', arr.to === idB, JSON.stringify(arr));
  // connect via context bar
  await ev(([a, b2]) => __wb.setSel([a, b2]), [idA, idB]); await p.waitForTimeout(50);
  await p.click('#ctxbar [data-act=connect]');
  const arrows = (await items()).filter((i) => i.type === 'arrow');
  ok('Context bar “Connect” adds an attached arrow', arrows.length === 2 && arrows[1].from === idA && arrows[1].to === idB);
  // duplicate notes + arrow → copy is wired to the copies
  await ev(([a, b2, c]) => __wb.setSel([a, b2, c]), [idA, idB, arrows[1].id]); await p.click('#ctxbar [data-act=copy]');
  let it = await items(); const dup = it[it.length - 1];
  const dupIds = new Set(it.slice(-3).map((i) => i.id));
  ok('Duplicating notes + arrow keeps the copy connected to the copies', dup.type === 'arrow' && dupIds.has(dup.from) && dupIds.has(dup.to), JSON.stringify(dup));
  await p.click('#btnUndo');
  // persisted through sync
  await ev(() => __wb.saveChainDone()); await ev(() => __wb.sync.syncNow());
  const remote = await ev(() => __wb.adapter._all().then((a) => JSON.parse(a.find((f) => f.folder === 'boards' && !f.trashed && f.name === 'Connectors.board.json').content)));
  ok('Connector attachments saved in board JSON on Drive', remote.items.filter((i) => i.type === 'arrow' && i.from && i.to).length === 2);
  await p.screenshot({ path: '/tmp/f2-connectors.png' });

  // ---- (b) Kanban notes: column snap, tags, due, checklist
  await p.click('#btnBoards'); await p.click('#btnNewBoard'); await p.click('.tpl-main:has-text("Kanban")'); await p.click('button[type=submit]'); await p.waitForTimeout(300);
  await ev(() => { __wb.S.view = { x: 40, y: 120, scale: 0.75 }; __wb.setTool('select'); }); await p.waitForTimeout(50);
  it = await items();
  const backlog = it.filter((i) => i.type === 'note' && i.x === 30);
  const doing = it.find((i) => i.type === 'rect' && i.x1 === 640);
  const doingNotes0 = it.filter((i) => i.type === 'note' && i.x >= 640 && i.x < 940);
  await dragW({ x: backlog[0].x + 120, y: backlog[0].y + 75 }, { x: 700, y: 300 });
  let n1 = await get(backlog[0].id);
  ok('Note dropped on a column snaps to its centre', n1.x === 640 + (300 - n1.w) / 2, `x=${n1.x}`);
  const overl = (a, c) => a.y < c.y + c.h && a.y + a.h > c.y && a.x < c.x + c.w && a.x + a.w > c.x;
  ok('…and does not overlap the notes already there', doingNotes0.every((o) => !overl(n1, o)), JSON.stringify([n1.y, doingNotes0.map((o) => o.y)]));
  await dragW({ x: backlog[1].x + 120, y: backlog[1].y + 75 }, { x: n1.x + 100, y: n1.y + 60 });
  const n2 = await get(backlog[1].id);
  ok('Second note dropped on the first stacks below it', n2.x === n1.x && n2.y >= n1.y + n1.h, `n1.y=${n1.y} n2.y=${n2.y}`);
  await p.click('#btnUndo'); await p.click('#btnUndo');
  ok('Undo returns snapped notes to their column', (await get(backlog[0].id)).x === 30 && (await get(backlog[1].id)).x === 30);
  // turn column snap off → free placement
  await p.click('#btnMore'); await p.click('.popover >> text=Snap notes into columns: on');
  await dragW({ x: backlog[0].x + 120, y: backlog[0].y + 75 }, { x: 705, y: 300 });
  n1 = await get(backlog[0].id);
  ok('Column snap can be switched off', n1.x !== 670, `x=${n1.x}`);
  await p.click('#btnUndo'); await p.click('#btnMore'); await p.click('.popover >> text=Snap notes into columns: off');
  // tags + due date
  await ev((id) => __wb.setSel([id]), backlog[0].id); await p.click('#ctxbar [data-act=tag]');
  await p.fill('.nd-tags', 'urgent, #client, urgent'); await p.fill('.nd-due', '2020-01-15'); await p.click('.nd-save');
  n1 = await get(backlog[0].id);
  ok('Tags + due date saved on a note (deduplicated, # stripped)', JSON.stringify(n1.tags) === '["urgent","client"]' && n1.due === '2020-01-15', JSON.stringify(n1));
  await p.click('#btnUndo'); n1 = await get(backlog[0].id);
  ok('Undo removes tags + due date', !n1.tags && !n1.due);
  await p.click('#btnRedo');
  await p.screenshot({ path: '/tmp/f2-kanban.png' });
  // checklist
  await ev((id) => __wb.commit(() => { __wb.S.board.items.find((i) => i.id === id).text = '[ ] Buy milk\n[x] Call Ann\nplain line'; }), backlog[1].id);
  const nb = await get(backlog[1].id);
  await ev(() => __wb.setSel([]));
  await clickW(nb.x + 12 + 8, nb.y + 12 + 12);
  ok('Tapping a checklist box ticks it', (await get(backlog[1].id)).text.startsWith('[x] Buy milk'), (await get(backlog[1].id)).text);
  await p.waitForTimeout(450);
  await clickW(nb.x + 12 + 8, nb.y + 12 + 25 + 12);
  ok('Tapping a ticked box unticks it', (await get(backlog[1].id)).text.includes('[ ] Call Ann'), (await get(backlog[1].id)).text);
  await p.click('#btnUndo');
  ok('Undo checklist tick', (await get(backlog[1].id)).text.includes('[x] Call Ann'));
  // add checklist item via menu
  await ev((id) => __wb.setSel([id]), backlog[0].id); await p.click('#ctxbar [data-act=tag]'); await p.click('.nd-check');
  await p.keyboard.type('New task'); await p.keyboard.press('Escape');
  ok('“Add checklist item” appends a [ ] line and opens the editor', (await get(backlog[0].id)).text.endsWith('[ ] New task'), (await get(backlog[0].id)).text);
  // search finds tags
  await p.click('#btnSearch'); await p.fill('.search-input', 'client'); await p.waitForTimeout(250);
  ok('Search finds notes by tag', (await p.textContent('.results')).includes('#client'));
  await p.click('#modalClose');
  // export with formatted notes renders without error
  const dlP = p.waitForEvent('download'); await p.click('#btnMore'); await p.click('.popover >> text=Export as PNG'); const dl = await dlP;
  ok('PNG export with tags/due/checklists works', (await dl.path()) && fs.statSync(await dl.path()).size > 5000);

  // ---- (c) frames, mini-map, present mode
  await blank('Frames', [
    { id: 'f1', type: 'frame', x: 0, y: 0, w: 600, h: 400, title: 'Intro', color: '#c7d2fe' },
    { id: 'f2', type: 'frame', x: 700, y: 0, w: 600, h: 400, title: 'Plan', color: '#bbf7d0' },
    { id: 'n1', type: 'note', x: 50, y: 100, w: 200, h: 160, text: 'inside', color: '#fff59d', fontSize: 20 },
    { id: 'n2', type: 'note', x: 300, y: 500, w: 200, h: 160, text: 'outside', color: '#fff59d', fontSize: 20 },
  ]);
  await ev(() => { __wb.S.view = { x: 40, y: 120, scale: 0.8 }; });
  const ids = Object.fromEntries((await items()).map((i) => [i.text || i.title, i.id]));
  await clickW(300, 200); // empty frame interior: not selectable (pans)
  ok('Frame interior does not grab (only its title bar)', (await sel()).length === 0);
  await dragW({ x: 200, y: 20 }, { x: 200, y: 120 });
  it = await items();
  ok('Dragging a frame title moves the frame and its contents', it.find((i) => i.id === ids.Intro).y === 100 && it.find((i) => i.id === ids.inside).y === 200 && it.find((i) => i.id === ids.outside).y === 500);
  await p.click('#btnUndo');
  await ev((id) => __wb.setSel([id]), ids.Intro); await p.click('#ctxbar [data-act=collapse]');
  ok('Collapse frame hides its contents', (await get(ids.Intro)).collapsed === true);
  await clickW(150, 180);
  ok('Hidden items cannot be selected', !(await sel()).includes(ids.inside));
  await clickW(600 - 20, 22); // chevron
  ok('Tapping the chevron expands the frame', !(await get(ids.Intro)).collapsed);
  await ev((id) => __wb.setSel([id]), ids.outside); await p.click('#ctxbar [data-act=frame]');
  it = await items(); const nf = it.find((i) => i.type === 'frame' && i.id !== ids.Intro && i.id !== ids.Plan);
  const ob = it.find((i) => i.id === ids.outside);
  ok('“Put in a frame” wraps the selection', nf && nf.x < ob.x && nf.y < ob.y && nf.x + nf.w > ob.x + ob.w && nf.y + nf.h > ob.y + ob.h);
  await p.click('#btnUndo');
  await p.click('#btnInsert'); await p.click('.popover >> text=Frame / section');
  ok('+ › Frame / section inserts a frame', (await items()).filter((i) => i.type === 'frame').length === 3);
  await p.click('#btnUndo');
  // mini-map
  await p.click('#btnMap'); await p.waitForTimeout(100);
  ok('Mini-map toggles on', await p.isVisible('#minimap'));
  const v0 = await ev(() => ({ ...__wb.S.view })); const mb = await p.locator('#miniCanvas').boundingBox();
  await p.mouse.click(mb.x + mb.width - 10, mb.y + mb.height - 10); await p.waitForTimeout(80);
  const v1 = await ev(() => ({ ...__wb.S.view }));
  ok('Tapping the mini-map jumps the view', v1.x !== v0.x || v1.y !== v0.y);
  // present mode
  await p.click('#btnFrames'); await p.click('.popover >> text=Present from the start');
  ok('Present mode starts on frame 1 and hides the UI', (await ev(() => document.body.classList.contains('presenting'))) && (await p.textContent('#presLabel')).startsWith('1 / 2 · Intro') && !(await p.isVisible('#toolbar')));
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(50);
  const pv = await ev(() => __wb.S.view);
  ok('Arrow key goes to the next frame (fitted on screen)', (await p.textContent('#presLabel')).startsWith('2 / 2 · Plan') && pv.x + 700 * pv.scale >= 0 && pv.x + 1300 * pv.scale <= 1280);
  await p.click('#presPrev');
  ok('◀ button goes back', (await p.textContent('#presLabel')).startsWith('1 / 2'));
  await p.keyboard.press('Escape');
  const v2 = await ev(() => ({ ...__wb.S.view }));
  ok('Esc leaves present mode and restores the view', !(await ev(() => document.body.classList.contains('presenting'))) && v2.x === v1.x && v2.scale === v1.scale);
  await p.click('#btnMap');
  ok('Mini-map toggles off', !(await p.isVisible('#minimap')));

  // ---- (d) align / distribute / snap to grid
  await blank('Align', [
    { id: 'a', type: 'note', x: 0, y: 0, w: 100, h: 100, text: '1', color: '#fff59d', fontSize: 20 },
    { id: 'b', type: 'note', x: 130, y: 60, w: 100, h: 100, text: '2', color: '#fff59d', fontSize: 20 },
    { id: 'c', type: 'note', x: 600, y: 30, w: 100, h: 100, text: '3', color: '#fff59d', fontSize: 20 },
  ]);
  await ev(() => __wb.setSel(__wb.S.board.items.map((i) => i.id))); await p.click('#ctxbar [data-act=align]');
  await p.click('.popover [data-align=top]'); it = await items();
  ok('Align top', it.every((i) => i.y === 0));
  await p.click('.popover [data-align=dist-h]'); it = await items();
  const xs = it.map((i) => i.x).sort((a, c) => a - c);
  ok('Distribute horizontally = equal gaps', xs[0] === 0 && xs[2] === 600 && near(xs[1], 300, 1), xs.join(','));
  await p.click('.popover [data-align=left]'); it = await items();
  ok('Align left', it.every((i) => i.x === 0));
  await p.click('#btnUndo'); it = await items();
  ok('Undo align', it.map((i) => i.x).sort((a, c) => a - c).join() === xs.join());
  await p.keyboard.press('Escape');
  await p.click('#btnMore'); await p.click('.popover >> text=Snap to grid: off');
  await ev(() => __wb.setSel([]));
  await dragW({ x: 50, y: 50 }, { x: 50 + 37, y: 50 + 23 });
  const sa = (await items()).find((i) => i.text === '1');
  ok('Snap to grid: dragged note lands on the 20px grid', sa.x % 20 === 0 && sa.y % 20 === 0 && sa.x === 40 && sa.y === 20, `${sa.x},${sa.y}`);
  await p.click('.toolbar [data-tool=shape]'); await p.click('.toolbar [data-tool=shape]'); await p.click('.popover [aria-label=rect]');
  await dragW({ x: 203, y: 307 }, { x: 389, y: 451 });
  const rr = (await items()).find((i) => i.type === 'rect');
  ok('Snap to grid: new shapes snap too', [rr.x1, rr.y1, rr.x2, rr.y2].every((v) => v % 20 === 0), JSON.stringify([rr.x1, rr.y1, rr.x2, rr.y2]));
  await p.click('#btnMore'); await p.click('.popover >> text=Snap to grid: on');
  ok('Snap to grid toggles off again', (await ev(() => __wb.PREF.grid)) === false);

  // ---- (e) layers + lock background
  await blank('Layers', [
    { id: 'bgimg', type: 'rect', x1: 0, y1: 0, x2: 600, y2: 400, color: 'ink', size: 2, fill: '#e3f2fd' },
    { id: 'top', type: 'note', x: 100, y: 100, w: 200, h: 160, text: 'top', color: '#fff59d', fontSize: 20 },
    { id: 'under', type: 'note', x: 150, y: 150, w: 200, h: 160, text: 'under', color: '#ffcc80', fontSize: 20 },
  ]);
  await ev(() => __wb.setTool('select'));
  const L = Object.fromEntries((await items()).map((i) => [i.text || 'rect', i.id]));
  await ev((id) => __wb.setSel([id]), L.under); await p.click('#ctxbar [data-act=layers]'); await p.click('.popover [data-layer=backward]');
  ok('Send backward moves one step down', (await items()).map((i) => i.id).join() === [L.rect, L.under, L.top].join());
  await p.click('#ctxbar [data-act=layers]'); await p.click('.popover [data-layer=front]');
  ok('Bring to front', (await items()).map((i) => i.id).pop() === L.under);
  await p.click('#ctxbar [data-act=layers]'); await p.click('.popover [data-layer=back]');
  ok('Send to back', (await items())[0].id === L.under);
  await p.click('#btnUndo'); await p.click('#btnUndo'); await p.click('#btnUndo');
  // rectangle at the end of the list, then moved to background layer: drawn beneath notes
  await ev((id) => __wb.commit(() => { const a = __wb.S.board.items; a.push(a.splice(a.findIndex((i) => i.id === id), 1)[0]); }), L.rect);
  await ev((id) => __wb.setSel([id]), L.rect); await p.click('#ctxbar [data-act=layers]'); await p.click('.popover [data-layer=bg]');
  ok('Move to background layer', (await get(L.rect)).layer === 'bg');
  await clickW(220, 200);
  ok('Background-layer item is drawn/hit beneath notes', (await sel()).includes(L.top) || (await sel()).includes(L.under), JSON.stringify(await sel()));
  await ev((id) => __wb.setSel([id]), L.rect); await p.click('#ctxbar [data-act=layers]'); await p.click('.popover [data-layer=bglock]');
  ok('Lock background layer', (await ev(() => __wb.S.board.bgLocked)) === true && (await sel()).length === 0);
  const vb = await ev(() => ({ ...__wb.S.view }));
  await dragW({ x: 500, y: 350 }, { x: 450, y: 300 });
  ok('Locked background: dragging on it pans, it stays put', (await get(L.rect)).x1 === 0 && (await ev(() => __wb.S.view.x)) !== vb.x);
  await ev(() => { __wb.S.view = { x: 100, y: 150, scale: 1 }; });
  await dragW({ x: 120, y: 120 }, { x: 420, y: 120 });
  ok('Notes still move over a locked background', (await get(L.top)).x === 400);
  await p.click('#btnUndo');
  await ev(() => __wb.saveChainDone()); await ev(() => __wb.sync.syncNow());
  const rl = await ev(() => __wb.adapter._all().then((a) => JSON.parse(a.find((f) => f.folder === 'boards' && !f.trashed && f.name === 'Layers.board.json').content)));
  ok('Layer + background lock saved in board JSON', rl.bgLocked === true && rl.items.find((i) => i.id === 'bgimg' || i.type === 'rect').layer === 'bg');
  await p.click('#btnUndo');
  ok('Undo unlocks the background', !(await ev(() => __wb.S.board.bgLocked)));
  await p.click('#btnRedo');
  await p.click('#btnMore'); await p.click('.popover >> text=Unlock background layer');
  ok('⋯ › Unlock background layer', !(await ev(() => __wb.S.board.bgLocked)));
  // backward compatibility: a v1 board without any new fields renders and edits fine
  await blank('Old', [{ id: 'o1', type: 'note', x: 0, y: 0, w: 200, h: 160, text: 'old', color: '#fff59d' }, { id: 'o2', type: 'arrow', x1: 0, y1: 300, x2: 200, y2: 300, color: 'ink', size: 3 }]);
  await dragW({ x: 100, y: 300 }, { x: 100, y: 400 });
  const o2 = (await items()).find((i) => i.type === 'arrow');
  ok('Old (unattached) arrows still move freely', o2.y1 === 400 && !o2.from && !o2.to);
  await p.screenshot({ path: '/tmp/f2-desk.png' });
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
  const get = async (id) => (await items()).find((i) => i.id === id);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i, radiusX: 5, radiusY: 5, force: 1 })) });
  async function swipe(a, z, steps = 10) { await touch('touchStart', [[a.x, a.y]]); for (let i = 1; i <= steps; i++) await touch('touchMove', [[a.x + (z.x - a.x) * i / steps, a.y + (z.y - a.y) * i / steps]]); await touch('touchEnd', []); await p.waitForTimeout(80); }
  const tap = async (q) => { await touch('touchStart', [[q.x, q.y]]); await touch('touchEnd', []); await p.waitForTimeout(120); };
  const tapEl = async (sel) => { const r = await p.locator(sel).first().boundingBox(); await tap({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); };
  await p.goto(BASE + '?mock=1&nosw'); await p.waitForFunction(() => window.__wb && __wb.S.board);
  await tapEl('#btnBoards'); await p.waitForTimeout(250); await tapEl('#btnNewBoard'); await p.waitForSelector('.tpl-main:has-text("Kanban")');
  await tapEl('.tpl-main:has-text("Kanban")'); await p.waitForSelector('button[type=submit]'); await tapEl('button[type=submit]'); await p.waitForTimeout(300);
  await ev(() => { __wb.S.view = { x: 10, y: 120, scale: 0.5 }; __wb.setTool('select'); });
  let it = await items();
  const bl = it.filter((i) => i.type === 'note' && i.x === 30);
  const from = await scr(bl[0].x + 120, bl[0].y + 75), to = await scr(345 + 120, 300);
  await swipe(from, to, 14);
  let n = await get(bl[0].id);
  ok('Phone: finger-drag a note into another column snaps it in', n.x === 320 + (300 - n.w) / 2, `x=${n.x}`);
  // checklist tick by tap
  await ev((id) => __wb.commit(() => { __wb.S.board.items.find((i) => i.id === id).text = '[ ] Ship it'; }), bl[1].id);
  await ev(() => __wb.setSel([]));
  const nb = await get(bl[1].id);
  await tap(await scr(nb.x + 20, nb.y + 24));
  ok('Phone: tap a checklist box ticks it', (await get(bl[1].id)).text === '[x] Ship it', (await get(bl[1].id)).text);
  // tags/due on phone
  await ev((id) => __wb.setSel([id]), bl[1].id); await p.waitForTimeout(50);
  await tapEl('#ctxbar [data-act=tag]'); await p.waitForSelector('.nd-tags');
  await p.fill('.nd-tags', 'phone'); await tapEl('.popover >> text=Tomorrow'); await tapEl('.nd-save');
  n = await get(bl[1].id);
  ok('Phone: tags + due date (quick “Tomorrow”)', n.tags && n.tags[0] === 'phone' && /^\d{4}-\d\d-\d\d$/.test(n.due || ''), JSON.stringify(n));
  const sb = await p.locator('#ctxbar').boundingBox();
  ok('Phone: context bar wraps to fit the screen', sb.x >= 0 && sb.x + sb.width <= 390, JSON.stringify(sb));
  // connect two notes via multi-select
  await ev(() => __wb.setSel([]));
  await tapEl('.toolbar [data-tool=select]'); await p.waitForSelector('.popover >> text=Multi-select'); await tapEl('.popover >> text=Multi-select');
  it = await items(); const two = it.filter((i) => i.type === 'note' && i.x === 350).slice(0, 1).concat(it.filter((i) => i.type === 'note' && i.x === 670).slice(0, 1));
  await ev(() => { __wb.S.view = { x: 5, y: 120, scale: 0.35 }; }); await p.waitForTimeout(50);
  for (const q of two) await tap(await scr(q.x + 120, q.y + 100));
  await tapEl('#ctxbar [data-act=connect]');
  const ar = (await items()).find((i) => i.type === 'arrow');
  ok('Phone: multi-select two notes › Connect', ar && ar.from === two[0].id && ar.to === two[1].id && !(await p.isVisible('#multiBanner')));
  // align popover touch targets
  await ev((ids) => __wb.setSel(ids), two.map((q) => q.id)); await p.waitForTimeout(50);
  await tapEl('#ctxbar [data-act=align]'); await p.waitForSelector('.popover [data-align=top]');
  const ab = await p.locator('.popover [data-align=top]').boundingBox();
  ok('Phone: align buttons ≥44px', ab.width >= 44 && ab.height >= 44, `${ab.width}x${ab.height}`);
  await tapEl('.popover [data-align=top]');
  it = await items();
  ok('Phone: align top works', it.find((i) => i.id === two[0].id).y === it.find((i) => i.id === two[1].id).y);
  // frames + present on phone
  await tapEl('#btnInsert'); await p.waitForSelector('.popover >> text=Frame / section'); await tapEl('.popover >> text=Frame / section');
  await ev(() => { const f = __wb.S.board.items.filter((i) => i.type === 'frame'); __wb.commit(() => { Object.assign(f[0], { x: 0, y: 900, w: 600, h: 400, title: 'Slide A' }); __wb.S.board.items.unshift({ id: 'fz', type: 'frame', x: 700, y: 900, w: 600, h: 400, title: 'Slide B' }); }); });
  ok('Phone: + › Frame / section', (await items()).filter((i) => i.type === 'frame').length === 2);
  await tapEl('#btnFrames'); await p.waitForSelector('.popover >> text=Present from the start');
  await tapEl('.popover >> text=Present from the start');
  ok('Phone: present mode starts', (await p.textContent('#presLabel')).startsWith('1 / 2 · Slide A'));
  const nx = await p.locator('#presNext').boundingBox();
  ok('Phone: present buttons are large (≥48px)', nx.width >= 48 && nx.height >= 48);
  { const a = { x: 300, y: 400 }, z = { x: 80, y: 400 }; await touch('touchStart', [[a.x, a.y]]); for (let i = 1; i <= 10; i++) await touch('touchMove', [[a.x + (z.x - a.x) * i / 10, a.y]]); await p.waitForTimeout(250); await touch('touchEnd', []); await p.waitForTimeout(150); } // swipe without a fling
  ok('Phone: swipe left = next frame', (await p.textContent('#presLabel')).startsWith('2 / 2 · Slide B'));
  await p.waitForTimeout(200); { const r = await p.locator('#presPrev').boundingBox(); await p.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2); await p.waitForTimeout(120); }
  ok('Phone: ◀ = previous frame', (await p.textContent('#presLabel')).startsWith('1 / 2'), (await p.textContent('#presLabel')) + JSON.stringify(await p.locator('#presPrev').boundingBox()) + await ev(() => document.querySelector('#presPrev').disabled));
  await p.screenshot({ path: '/tmp/f2-phone-present.png' });
  await tapEl('#presExit');
  ok('Phone: ✕ leaves present mode', !(await ev(() => document.body.classList.contains('presenting'))) && await p.isVisible('#toolbar'));
  // mini-map
  await tapEl('#btnMap'); await p.waitForTimeout(100);
  const mm = await p.locator('#minimap').boundingBox(), tb = await p.locator('#toolbar').boundingBox(), zb = await p.locator('.zoom').boundingBox();
  ok('Phone: mini-map shows without covering the toolbar/zoom', mm && mm.y + mm.height <= zb.y + 1 && mm.y + mm.height <= tb.y, JSON.stringify([mm, zb]));
  const v0 = await ev(() => ({ ...__wb.S.view }));
  await tap({ x: mm.x + 10, y: mm.y + 10 });
  ok('Phone: tap the mini-map to jump', (await ev(() => __wb.S.view.x)) !== v0.x || (await ev(() => __wb.S.view.y)) !== v0.y);
  const zl = await p.locator('.zoom').boundingBox(), hl = await p.locator('.history').boundingBox();
  ok('Phone: zoom + history clusters do not overlap', hl.x + hl.width <= zl.x, JSON.stringify([hl, zl]));
  await p.screenshot({ path: '/tmp/f2-phone.png' });
  await ctx.close();
}
ok('No uncaught JS errors', errs.length === 0, errs.join(' | '));
await b.close();
fs.writeFileSync('/tmp/wb-feature2-results.json', JSON.stringify(res, null, 1));
console.log(`${res.filter((r) => r[0] === 'PASS').length}/${res.length} passed`);
