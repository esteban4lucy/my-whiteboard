import { chromium } from 'playwright-core';
import fs from 'fs';
const BASE = 'http://127.0.0.1:8765/my-whiteboard/';
const res = []; const ok = (n, c, i = '') => { res.push([c ? 'PASS' : 'FAIL', n, i]); console.log(c ? 'PASS' : 'FAIL', n, i); };
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
const cdp = await ctx.newCDPSession(p);
const ev = (fn, a) => p.evaluate(fn, a);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i, radiusX: 5, radiusY: 5, force: 1 })) });
async function swipe(a, z, steps = 10) {
  await touch('touchStart', [a]);
  for (let i = 1; i <= steps; i++) await touch('touchMove', [[a[0] + (z[0] - a[0]) * i / steps, a[1] + (z[1] - a[1]) * i / steps]]);
  await touch('touchEnd', []); await p.waitForTimeout(80);
}
const tap = async (x, y) => { await touch('touchStart', [[x, y]]); await touch('touchEnd', []); await p.waitForTimeout(60); };

await p.goto(BASE + '?mock=1');
await p.waitForFunction(() => window.__wb && __wb.S.board);
await p.screenshot({ path: '/tmp/m1.png' });
// toolbar fits, buttons >= 38px
const tb = await ev(() => { const t = document.querySelector('#toolbar'); return { sw: t.scrollWidth, cw: t.clientWidth, minBtn: Math.min(...[...t.querySelectorAll('button')].map((x) => Math.min(x.offsetWidth, x.offsetHeight))) }; });
ok('Phone toolbar fits without scrolling, buttons ≥38px', tb.sw <= tb.cw + 1 && tb.minBtn >= 38, JSON.stringify(tb));
await p.tap('.toolbar [data-tool=pen]');
await swipe([100, 300], [250, 400]);
ok('Finger drawing (pen)', await ev(() => __wb.S.board.items.filter((i) => i.type === 'stroke').length === 1));
// pinch zoom with two fingers
const s0 = await ev(() => __wb.S.view.scale);
await touch('touchStart', [[150, 400], [240, 400]]);
for (let i = 1; i <= 10; i++) await touch('touchMove', [[150 - i * 8, 400], [240 + i * 8, 400]]);
await touch('touchEnd', []); await p.waitForTimeout(100);
const s1 = await ev(() => __wb.S.view.scale);
ok('Two-finger pinch zooms (and does not draw)', s1 > s0 * 1.5 && (await ev(() => __wb.S.board.items.length)) === 1, `${s0.toFixed(2)} -> ${s1.toFixed(2)}`);
// two-finger pan
const v0 = await ev(() => ({ ...__wb.S.view }));
await touch('touchStart', [[150, 400], [240, 400]]);
for (let i = 1; i <= 10; i++) await touch('touchMove', [[150, 400 + i * 10], [240, 400 + i * 10]]);
await touch('touchEnd', []); await p.waitForTimeout(100);
const v1 = await ev(() => ({ ...__wb.S.view }));
ok('Two-finger pan', v1.y - v0.y > 80, `${v0.y.toFixed(0)} -> ${v1.y.toFixed(0)}`);
await p.waitForTimeout(400); await ev(() => document.querySelector('#zoomFit').click()); await ev(() => { __wb.S.view = { x: 195, y: 300, scale: 1 }; });
// sticky note by tap, type, move by finger, double-tap to edit
await p.tap('.toolbar [data-tool=note]'); await tap(195, 500);
await p.keyboard.type('Phone note'); await tap(40, 700);
const n = await ev(() => __wb.S.board.items.find((i) => i.type === 'note'));
ok('Tap to add sticky note & type', n && n.text === 'Phone note', JSON.stringify(n) + ' active=' + await ev(() => document.activeElement.id + ' ' + JSON.stringify(__wb.S.board.items.map(i=>i.type))));
const c = await ev((n) => __wb.toScreen({ x: n.x + n.w / 2, y: n.y + n.h / 2 }), n);
await swipe([c.x, c.y], [c.x + 60, c.y - 120]);
const n2 = await ev(() => __wb.S.board.items.find((i) => i.type === 'note'));
ok('Drag note with finger', Math.abs(n2.y - n.y) > 30, `${n.y.toFixed(0)} -> ${n2.y.toFixed(0)}`);
const c2 = await ev((n) => __wb.toScreen({ x: n.x + n.w / 2, y: n.y + n.h / 2 }), n2);
await tap(c2.x, c2.y); await tap(c2.x, c2.y); await p.waitForTimeout(100);
ok('Double-tap note opens editor', await ev(() => !document.querySelector('#editor').hidden));
await p.keyboard.type(' edited'); await tap(40, 700);
ok('Edit saved', (await ev(() => __wb.S.board.items.find((i) => i.type === 'note').text)) === 'Phone note edited');
await p.screenshot({ path: '/tmp/m2.png' });
// drawer & template picker on phone
await p.tap('#btnBoards'); await p.waitForTimeout(250); await p.screenshot({ path: '/tmp/m3.png' });
await p.tap('#btnNewBoard'); await p.waitForSelector('.tpl-main'); await p.waitForTimeout(200); await p.screenshot({ path: '/tmp/m4.png' });
await p.tap('#modalClose'); await p.tap('#drawerClose');

// --- "new device": wipe local app data, keep (mock) Drive, reload → everything comes back from Drive
await p.waitForTimeout(3500);
await p.waitForFunction(() => document.querySelector('#syncPill').textContent === 'Synced', null, { timeout: 10000 });
// add an uploaded picture so we can check it is downloaded on the new device
fs.writeFileSync('/tmp/test2.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEJMDGgAcQGAG4FAwFd2cg8AAAAAElFTkSuQmCC', 'base64'));
await p.setInputFiles('#fileImage', '/tmp/test2.png'); await p.waitForTimeout(300);
await ev(() => __wb.sync.syncNow()); await ev(() => __wb.sync.syncNow());
await ev(() => new Promise((r) => { indexedDB.deleteDatabase('my-whiteboard').onsuccess = r; setTimeout(r, 1500); }));
await ev(() => { localStorage.clear(); });
await p.reload(); await p.waitForFunction(() => window.__wb && __wb.S.board); await p.waitForTimeout(1500);
ok('New device: board pulled from Drive on first run', await ev(() => __wb.S.boards.some((b) => b.items.some((i) => i.text === 'Phone note edited'))));
ok('New device: uploaded picture downloaded for offline use', await ev(async () => { const bs = await __wb.db.all('blobs'); return bs.some((x) => x.blob && x.driveId); }));

// --- dark mode on phone
await p.tap('#btnMore'); await p.tap('.popover >> text=Dark mode'); await p.waitForTimeout(150);
await p.screenshot({ path: '/tmp/m5.png' });
ok('Dark mode via menu on phone', (await ev(() => document.documentElement.dataset.theme)) === 'dark');
ok('No uncaught errors', errs.length === 0, errs.join('|'));
await b.close();
fs.writeFileSync('/tmp/wb-touch-results.json', JSON.stringify(res, null, 1));
console.log(`${res.filter((r) => r[0] === 'PASS').length}/${res.length} passed`);
