// My Whiteboard – main app. Offline-first: every change is written to IndexedDB first,
// then pushed to Google Drive by the sync engine when online.
import { db, kv, uid } from './db.js';
import * as R from './render.js';
import { BUILTIN_TEMPLATES } from './templates.js';
import { createSync } from './sync.js';
import { GoogleDriveAdapter } from './drive.js';
import { exportPNG, exportPDF, exportJSON } from './export.js';
import { $, h, esc, ICONS, toast, openModal, closeModal, ask, confirmDlg, popover, closePopover, fmtTime } from './ui.js';

const cfg = window.WB_CONFIG || {};
const params = new URLSearchParams(location.search);
const MOCK = params.has('mock') || localStorage.getItem('wb-mock') === '1';

const S = {
  board: null, boards: [], view: { x: 0, y: 0, scale: 1 },
  tool: 'pen', shape: 'rect', color: 'ink', size: 4, noteColor: R.NOTE_COLORS[0],
  sel: [], multiMode: false, undo: [], redo: [], editingId: null, theme: 'light',
  syncState: 'local', syncMsg: '', pending: 0,
};
let adapter = null, sync = null;
const canvas = $('#board'), ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;

// ---------- theme ----------
function applyTheme(t) {
  S.theme = t; document.documentElement.dataset.theme = t;
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = t === 'dark' ? '#16171a' : '#ffffff';
  requestRender();
}
function initTheme() {
  const saved = localStorage.getItem('wb-theme');
  applyTheme(saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
}
function toggleTheme() { const t = S.theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('wb-theme', t); applyTheme(t); }

// ---------- images (local blob cache, Drive fallback) ----------
const imgCache = new Map();
function imageKey(it) { return it.blobKey || it.src; }
function getImage(it) {
  const k = imageKey(it); if (!k) return null;
  const c = imgCache.get(k);
  if (c) return c.img && c.ok ? c.img : null;
  const entry = { img: null, ok: false }; imgCache.set(k, entry);
  (async () => {
    let url = null;
    if (it.blobKey) {
      let rec = await db.get('blobs', it.blobKey);
      const driveId = (rec && rec.driveId) || it.driveId;
      if ((!rec || !rec.blob) && driveId && adapter && adapter.isAuthed() && navigator.onLine) {
        try { const blob = await adapter.readBlob(driveId); rec = { ...(rec || {}), key: it.blobKey, blob, mime: blob.type, driveId }; await db.put('blobs', rec); } catch { /* retry later */ }
      }
      if (rec && rec.blob) url = URL.createObjectURL(rec.blob);
    }
    if (!url && it.src) url = it.src;
    if (!url) { it.status = navigator.onLine ? 'error' : 'pending'; requestRender(); setTimeout(() => imgCache.delete(k), 10000); return; }
    const img = new Image();
    img.onload = () => { entry.img = img; entry.ok = true; requestRender(); };
    img.onerror = () => { it.status = 'error'; requestRender(); setTimeout(() => imgCache.delete(k), 15000); };
    img.src = url;
  })();
  return null;
}
const env = () => ({ tc: R.themeColors(S.theme), getImage, editingId: S.editingId, theme: S.theme });

// ---------- canvas / view ----------
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 3);
  W = canvas.clientWidth; H = canvas.clientHeight;
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  requestRender();
}
let raf = 0;
function requestRender() { if (!raf) raf = requestAnimationFrame(render); }
const toWorld = (p) => ({ x: (p.x - S.view.x) / S.view.scale, y: (p.y - S.view.y) / S.view.scale });
const toScreen = (p) => ({ x: p.x * S.view.scale + S.view.x, y: p.y * S.view.scale + S.view.y });
const HANDLE = 22;

function render() {
  raf = 0;
  if (!S.board) return;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const e = env();
  R.drawBoard(ctx, S.board, S.view, W, H, e);
  ctx.save(); ctx.translate(S.view.x, S.view.y); ctx.scale(S.view.scale, S.view.scale);
  if (G && G.draft) R.drawItem(ctx, G.draft, e);
  if (G && G.type === 'marquee') {
    ctx.fillStyle = 'rgba(37,99,235,0.08)'; ctx.strokeStyle = e.tc.sel; ctx.lineWidth = 1.5 / S.view.scale; ctx.setLineDash([5 / S.view.scale, 4 / S.view.scale]);
    const x = Math.min(G.p0.x, G.cur.x), y = Math.min(G.p0.y, G.cur.y), w = Math.abs(G.cur.x - G.p0.x), hh = Math.abs(G.cur.y - G.p0.y);
    ctx.fillRect(x, y, w, hh); ctx.strokeRect(x, y, w, hh); ctx.setLineDash([]);
  }
  const sel = selItems();
  if (sel.length) {
    const pad = 6 / S.view.scale, k = 1 / S.view.scale;
    ctx.strokeStyle = e.tc.sel; ctx.lineWidth = 2 * k; ctx.setLineDash([6 * k, 4 * k]);
    if (sel.length > 1) { ctx.globalAlpha = 0.45; for (const it of sel) { const b = R.bounds(it); ctx.strokeRect(b.x - pad / 2, b.y - pad / 2, b.w + pad, b.h + pad); } ctx.globalAlpha = 1; }
    const b = R.boardBounds(sel);
    ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2); ctx.setLineDash([]);
    if (sel.some((i) => i.locked)) drawLockBadge(ctx, b.x + b.w + pad, b.y - pad, k, e.tc.sel);
    else for (const hd of handles(sel)) {
      const s = HANDLE * k;
      ctx.fillStyle = '#fff'; ctx.strokeStyle = e.tc.sel; ctx.lineWidth = 2 * k;
      ctx.beginPath(); ctx.arc(hd.x, hd.y, s / 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
  ctx.restore();
  $('#zoomPct').textContent = Math.round(S.view.scale * 100) + '%';
  positionCtxBar();
}
function drawLockBadge(c, x, y, k, color) { // small padlock shown on selected locked items
  const r = 13 * k;
  c.save(); c.fillStyle = color; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  c.strokeStyle = '#fff'; c.fillStyle = '#fff'; c.lineWidth = 2 * k;
  c.beginPath(); c.arc(x, y - 2 * k, 4 * k, Math.PI, 0); c.stroke();
  c.fillRect(x - 6 * k, y - 2 * k, 12 * k, 8 * k); c.restore();
}
function handles(sel) {
  if (sel.length !== 1) { const b = R.boardBounds(sel), pad = 6 / S.view.scale; return [{ k: 'gbr', x: b.x + b.w + pad, y: b.y + b.h + pad }]; }
  const it = sel[0];
  if (it.type === 'line' || it.type === 'arrow') return [{ k: 'p1', x: it.x1, y: it.y1 }, { k: 'p2', x: it.x2, y: it.y2 }];
  if (it.type === 'stroke') return [];
  const b = R.bounds(it), pad = 6 / S.view.scale;
  return [{ k: 'br', x: b.x + b.w + pad, y: b.y + b.h + pad }];
}
function zoomAt(factor, sp) {
  const ns = Math.min(8, Math.max(0.1, S.view.scale * factor));
  const w = toWorld(sp); S.view.scale = ns;
  S.view.x = sp.x - w.x * ns; S.view.y = sp.y - w.y * ns;
  saveViewSoon(); requestRender();
}
function fitView() {
  if (!S.board.items.length) { S.view = { x: W / 2, y: H / 2, scale: 1 }; saveViewSoon(); requestRender(); return; }
  const b = R.boardBounds(S.board.items), pad = 60;
  const s = Math.min(2, Math.max(0.1, Math.min((W - pad * 2) / Math.max(b.w, 1), (H - 200) / Math.max(b.h, 1))));
  S.view.scale = s; S.view.x = W / 2 - (b.x + b.w / 2) * s; S.view.y = (H - 60) / 2 + 20 - (b.y + b.h / 2) * s;
  saveViewSoon(); requestRender();
}
function centerOn(it) {
  const b = R.bounds(it); const s = Math.max(S.view.scale, 0.6);
  S.view.scale = s; S.view.x = W / 2 - (b.x + b.w / 2) * s; S.view.y = H / 2 - (b.y + b.h / 2) * s; requestRender();
}
let viewT = 0;
function saveViewSoon() { clearTimeout(viewT); viewT = setTimeout(() => S.board && localStorage.setItem('wb-view:' + S.board.id, JSON.stringify(S.view)), 300); }

// ---------- model ----------
const byId = (id) => (S.board ? S.board.items.find((i) => i.id === id) : null);
// Selection = list of item ids; selecting one member of a group selects the whole group.
function expandGroups(ids) {
  const set = new Set(ids);
  const gids = new Set(S.board.items.filter((i) => set.has(i.id) && i.groupId).map((i) => i.groupId));
  if (gids.size) for (const i of S.board.items) if (i.groupId && gids.has(i.groupId)) set.add(i.id);
  return [...set];
}
function setSel(ids) { S.sel = S.board ? expandGroups(ids).filter((id) => byId(id)) : []; showCtxBar(); requestRender(); }
const selItems = () => (S.board ? S.board.items.filter((i) => S.sel.includes(i.id)) : []);
const selItem = () => { const a = selItems(); return a.length === 1 ? a[0] : null; };
const isGroupSel = () => { const a = selItems(); return a.length > 1 && !!a[0].groupId && a.every((i) => i.groupId === a[0].groupId); };
const snap = () => JSON.stringify({ items: S.board.items, background: S.board.background });
function pushUndo(s) { S.undo.push(s); if (S.undo.length > 100) S.undo.shift(); S.redo = []; updateUndoBtns(); }
function commit(fn) { const s = snap(); fn(); if (snap() !== s) { pushUndo(s); save(); } requestRender(); }
function restore(s) { const d = JSON.parse(s); S.board.items = d.items; S.board.background = d.background; S.sel = S.sel.filter((id) => byId(id)); save(); requestRender(); showCtxBar(); }
function undo() { if (!S.undo.length) return; finishEdit(); const cur = snap(); restore(S.undo.pop()); S.redo.push(cur); updateUndoBtns(); }
function redo() { if (!S.redo.length) return; finishEdit(); const cur = snap(); restore(S.redo.pop()); S.undo.push(cur); updateUndoBtns(); }
function updateUndoBtns() { $('#btnUndo').disabled = !S.undo.length; $('#btnRedo').disabled = !S.redo.length; }

let saveChain = Promise.resolve();
function save() {
  const b = S.board; if (!b) return;
  b.updatedAt = Date.now(); b.dirty = true;
  const copy = JSON.parse(JSON.stringify(b));
  // Sync metadata (Drive file id / modifiedTime) is owned by the sync engine: keep the stored values.
  saveChain = saveChain.then(() => db.update('boards', copy.id, (cur) => ({ ...copy, driveFileId: cur ? cur.driveFileId : undefined, driveModifiedTime: cur ? cur.driveModifiedTime : undefined }))).then(refreshPending).catch((e) => toast('Could not save locally: ' + e.message, { kind: 'error' }));
  sync && sync.schedule();
  return saveChain;
}
async function refreshPending() {
  const all = await db.all('boards');
  S.boards = all.filter((b) => !b.deleted).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  S.pending = all.filter((b) => b.dirty).length + (await db.all('templates')).filter((t) => t.dirty || (t.deleted)).length;
  renderSyncPill();
}

function newBoardFrom(tpl, name) {
  const fresh = JSON.parse(JSON.stringify(tpl.items || []));
  const gmap = new Map();
  for (const it of fresh) { it.id = uid('i-'); if (it.groupId) { if (!gmap.has(it.groupId)) gmap.set(it.groupId, uid('g-')); it.groupId = gmap.get(it.groupId); } }
  const now = Date.now();
  return { id: uid('b-'), name: name || tpl.name, background: tpl.background || 'grid', items: fresh, createdAt: now, updatedAt: now, dirty: true, deleted: false };
}
async function createBoard(tpl, name) {
  const b = newBoardFrom(tpl, name);
  await db.put('boards', b);
  await openBoard(b.id, { fit: true });
  sync && sync.schedule(500);
  return b;
}
async function openBoard(id, { fit = false } = {}) {
  finishEdit();
  if (S.board) await saveChain;
  const b = await db.get('boards', id);
  if (!b || b.deleted) return false;
  S.board = b; S.sel = []; S.multiMode = false; S.undo = []; S.redo = []; updateUndoBtns();
  localStorage.setItem('wb-current', id);
  const v = JSON.parse(localStorage.getItem('wb-view:' + id) || 'null');
  if (v && !fit) S.view = v; else fitView();
  $('#boardName').textContent = b.name;
  document.title = `${b.name} · My Whiteboard`;
  showCtxBar(); await refreshPending(); renderDrawer(); requestRender();
  return true;
}
async function reloadCurrentFromDB() {
  if (!S.board) return;
  const b = await db.get('boards', S.board.id);
  if (!b || b.deleted) { const next = S.boards.find((x) => x.id !== S.board.id); if (next) openBoard(next.id); else createBoard(BUILTIN_TEMPLATES[0], 'My first board'); return; }
  if (b.updatedAt !== S.board.updatedAt || JSON.stringify(b.items) !== JSON.stringify(S.board.items)) {
    S.board = b; S.undo = []; S.redo = []; updateUndoBtns(); S.sel = S.sel.filter((id) => byId(id));
    $('#boardName').textContent = b.name; requestRender(); showCtxBar();
  } else { S.board.driveFileId = b.driveFileId; S.board.driveModifiedTime = b.driveModifiedTime; S.board.dirty = b.dirty; }
}

// ---------- pointer handling ----------
const pointers = new Map();
let G = null; // current gesture
let lastTap = { id: null, t: 0 };
let spaceDown = false;
const pt = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
const tol = () => 10 / S.view.scale;
// Locked items are skipped unless allowLocked (long-press to reach them).
function topHit(w, filter = () => true, allowLocked = false) {
  for (let i = S.board.items.length - 1; i >= 0; i--) {
    const it = S.board.items[i];
    if ((it.locked && !allowLocked) || !filter(it)) continue;
    if (R.hit(it, w.x, w.y, tol())) return it;
  }
  return null;
}
function handleHit(w) {
  const sel = selItems(); if (!sel.length || sel.some((i) => i.locked)) return null;
  if (sel.length === 1) {
    const it = sel[0];
    if (it.type !== 'line' && it.type !== 'arrow' && it.type !== 'stroke') { // presses inside the item act on the item (e.g. a link's Open button)
      const b = R.bounds(it); if (w.x > b.x && w.x < b.x + b.w && w.y > b.y && w.y < b.y + b.h) return null;
    }
  }
  for (const hd of handles(sel)) if (Math.hypot(hd.x - w.x, hd.y - w.y) <= (HANDLE / 2 + 8) / S.view.scale) return hd.k;
  return null;
}
const LONG_PRESS_MS = 550;

canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 2) return;
  e.preventDefault(); // keep focus in the text editor; suppress emulated mouse events
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, pt(e));
  closePopover();
  if (S.editingId) finishEdit();
  if (pointers.size === 2) {
    if (G && G.lp) clearTimeout(G.lp);
    if (G && G.type === 'move' && G.moved) restore(G.snap); // abandon a half-done drag
    const [a, b] = [...pointers.values()];
    G = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), s0: S.view.scale, m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, w0: toWorld({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }) };
    requestRender(); return;
  }
  if (pointers.size > 2) return;
  const p = pt(e), w = toWorld(p);
  if (e.button === 1 || spaceDown || S.tool === 'hand') { G = { type: 'pan', p0: p, v0: { ...S.view } }; return; }
  switch (S.tool) {
    case 'pen': case 'highlighter': {
      const hl = S.tool === 'highlighter';
      G = { type: 'draw', draft: { id: uid('i-'), type: 'stroke', tool: S.tool, color: hl ? (S.color === 'ink' ? '#fdd835' : S.color) : S.color, size: hl ? Math.max(12, S.size * 4) : S.size, points: [[r1(w.x), r1(w.y)]] } };
      break;
    }
    case 'eraser': G = { type: 'erase', snap: snap(), removed: 0 }; eraseAt(w); break;
    case 'shape': G = { type: 'shape', p0: w, draft: { id: uid('i-'), type: S.shape, x1: w.x, y1: w.y, x2: w.x, y2: w.y, color: S.color, size: Math.max(2, S.size) } }; break;
    case 'text': { const before = snap(); const it = { id: uid('i-'), type: 'text', x: w.x, y: w.y - 14, text: '', fontSize: 28, color: S.color }; S.board.items.push(it); setTool('select'); setSel([it.id]); startEdit(it, true, before); G = null; break; }
    case 'note': {
      const it = { id: uid('i-'), type: 'note', x: w.x - 100, y: w.y - 80, w: 200, h: 160, text: '', color: S.noteColor, fontSize: 20 };
      commit(() => S.board.items.push(it)); setTool('select'); setSel([it.id]); startEdit(it, false); G = null; break;
    }
    default: { // select
      const additive = e.shiftKey || e.ctrlKey || e.metaKey || S.multiMode;
      const hk = handleHit(w);
      if (hk) { const sel = selItems(); G = { type: 'resize', k: hk, snap: snap(), w0: w, orig: sel.map((i) => JSON.parse(JSON.stringify(i))), ob: R.boardBounds(sel) }; break; }
      const it = topHit(w);
      if (it) {
        let removeOnTap = null;
        if (additive) {
          const grp = expandGroups([it.id]);
          if (S.sel.includes(it.id)) removeOnTap = grp; else setSel([...S.sel, ...grp]);
        } else if (!S.sel.includes(it.id)) setSel([it.id]);
        let openLink = false;
        if (it.type === 'link' && S.sel.length === 1) { const o = R.linkOpenRect(it); openLink = w.x >= o.x && w.x <= o.x + o.w && w.y >= o.y && w.y <= o.y + o.h; }
        G = { type: 'move', ids: [...S.sel], tapId: it.id, last: w, p0: p, moved: false, snap: snap(), openLink, removeOnTap };
      } else if (additive) {
        G = { type: 'marquee', p0: w, cur: w, base: [...S.sel] };
      } else {
        setSel([]);
        G = { type: 'pan', p0: p, v0: { ...S.view } };
        const lockedIt = topHit(w, (x) => x.locked, true);
        if (lockedIt) { // long-press a locked item to select it (then Unlock)
          const g = G;
          g.lp = setTimeout(() => {
            if (G !== g || g.moved) return;
            G = null; setSel([lockedIt.id]);
            if (navigator.vibrate) navigator.vibrate(15);
          }, LONG_PRESS_MS);
        }
      }
      requestRender();
    }
  }
});
const r1 = (v) => Math.round(v * 10) / 10;

canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, pt(e));
  if (!G) return;
  const p = pt(e), w = toWorld(p);
  switch (G.type) {
    case 'pinch': {
      const [a, b] = [...pointers.values()]; if (!b) return;
      const d = Math.hypot(a.x - b.x, a.y - b.y), m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = Math.min(8, Math.max(0.1, G.s0 * d / Math.max(G.d0, 1)));
      S.view.scale = s; S.view.x = m.x - G.w0.x * s; S.view.y = m.y - G.w0.y * s; saveViewSoon(); requestRender(); break;
    }
    case 'pan':
      if (Math.hypot(p.x - G.p0.x, p.y - G.p0.y) > 8) { G.moved = true; if (G.lp) clearTimeout(G.lp); }
      S.view.x = G.v0.x + p.x - G.p0.x; S.view.y = G.v0.y + p.y - G.p0.y; saveViewSoon(); requestRender(); break;
    case 'marquee': G.cur = w; requestRender(); break;
    case 'draw': {
      const pts = G.draft.points, last = pts[pts.length - 1];
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs.length ? evs : [e]) {
        const ww = toWorld(pt(ev));
        if (Math.hypot(ww.x - last[0], ww.y - last[1]) > 1.2 / S.view.scale) pts.push([r1(ww.x), r1(ww.y)]);
      }
      requestRender(); break;
    }
    case 'erase': eraseAt(w); break;
    case 'shape': {
      let x2 = w.x, y2 = w.y;
      if (e.shiftKey && (S.shape === 'rect' || S.shape === 'ellipse')) { const s = Math.max(Math.abs(x2 - G.p0.x), Math.abs(y2 - G.p0.y)); x2 = G.p0.x + Math.sign(x2 - G.p0.x || 1) * s; y2 = G.p0.y + Math.sign(y2 - G.p0.y || 1) * s; }
      G.draft.x2 = x2; G.draft.y2 = y2; requestRender(); break;
    }
    case 'move': {
      if (!G.moved && Math.hypot(p.x - G.p0.x, p.y - G.p0.y) < 6) return;
      G.moved = true;
      const dx = w.x - G.last.x, dy = w.y - G.last.y;
      for (const id of G.ids) { const it = byId(id); if (it && !it.locked) R.moveItem(it, dx, dy); }
      G.last = w; requestRender();
      break;
    }
    case 'resize': {
      const dx = w.x - G.w0.x, dy = w.y - G.w0.y;
      if (G.k === 'gbr') { // several items / a group: scale uniformly from the top-left corner
        const ob = G.ob, s = Math.max(0.1, Math.max((ob.w + dx) / Math.max(ob.w, 1), (ob.h + dy) / Math.max(ob.h, 1)));
        for (const o of G.orig) { const it = byId(o.id); if (it) Object.assign(it, R.scaleItem(JSON.parse(JSON.stringify(o)), ob.x, ob.y, s)); }
        requestRender(); break;
      }
      const o = G.orig[0], it = byId(o.id); if (!it) return;
      if (G.k === 'p1') { it.x1 = o.x1 + dx; it.y1 = o.y1 + dy; }
      else if (G.k === 'p2') { it.x2 = o.x2 + dx; it.y2 = o.y2 + dy; }
      else if (it.type === 'rect' || it.type === 'ellipse') {
        if (o.x2 >= o.x1) it.x2 = o.x2 + dx; else it.x1 = o.x1 + dx;
        if (o.y2 >= o.y1) it.y2 = o.y2 + dy; else it.y1 = o.y1 + dy;
      } else if (it.type === 'text') {
        const ob = R.bounds(o); it.fontSize = Math.max(8, Math.round(o.fontSize * Math.max(0.2, (ob.w + dx) / ob.w)));
      } else if (it.type === 'image') {
        const ratio = o.h / o.w; it.w = Math.max(30, o.w + dx); it.h = e.shiftKey ? Math.max(30, o.h + dy) : it.w * ratio;
      } else { it.w = Math.max(it.type === 'link' ? 200 : 60, o.w + dx); it.h = Math.max(it.type === 'link' ? 100 : 60, o.h + dy); }
      requestRender(); break;
    }
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (G && G.type === 'pinch') { if (pointers.size === 0) G = null; return; }
  if (!G) return;
  const g = G; G = null;
  if (g.lp) clearTimeout(g.lp);
  switch (g.type) {
    case 'draw': if (g.draft.points.length) commit(() => S.board.items.push(g.draft)); break;
    case 'shape': {
      const d = g.draft;
      if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) > 4 / S.view.scale) { commit(() => S.board.items.push(d)); }
      requestRender(); break;
    }
    case 'erase': if (g.removed) { pushUndo(g.snap); save(); } break;
    case 'marquee': {
      const x1 = Math.min(g.p0.x, g.cur.x), y1 = Math.min(g.p0.y, g.cur.y), x2 = Math.max(g.p0.x, g.cur.x), y2 = Math.max(g.p0.y, g.cur.y);
      if (x2 - x1 > 3 / S.view.scale || y2 - y1 > 3 / S.view.scale) {
        const hits = S.board.items.filter((it) => { if (it.locked) return false; const b = R.bounds(it); return b.x < x2 && b.x + b.w > x1 && b.y < y2 && b.y + b.h > y1; }).map((i) => i.id);
        setSel([...g.base, ...hits]);
      }
      requestRender(); break;
    }
    case 'move': case 'resize': {
      if (g.type === 'move' && !g.moved) {
        if (g.removeOnTap) { setSel(S.sel.filter((id) => !g.removeOnTap.includes(id))); break; }
        const it = byId(g.tapId); const now = Date.now();
        if (it && g.openLink && it.type === 'link') openLink(it);
        else if (it && lastTap.id === it.id && now - lastTap.t < 400 && !S.multiMode) {
          if (it.type === 'note' || it.type === 'text') startEdit(it, false);
          else if (it.type === 'link') openLink(it);
        }
        lastTap = { id: it && it.id, t: now };
      } else if (snap() !== g.snap) { pushUndo(g.snap); save(); }
      showCtxBar(); requestRender(); break;
    }
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); if (G && G.lp) clearTimeout(G.lp); if (G && (G.type === 'draw' || G.type === 'marquee')) G = null; requestRender(); });
canvas.addEventListener('dblclick', (e) => {
  if (S.tool !== 'select' || S.multiMode) return;
  const it = topHit(toWorld(pt(e)));
  if (!it) return;
  if (it.type === 'note' || it.type === 'text') startEdit(it, false); else if (it.type === 'link') openLink(it);
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), pt(e));
  else { S.view.x -= e.deltaX; S.view.y -= e.deltaY; saveViewSoon(); requestRender(); }
}, { passive: false });

function eraseAt(w) {
  const victim = topHit(w, (it) => ['stroke', 'rect', 'ellipse', 'line', 'arrow'].includes(it.type)); // locked items are never erased
  if (victim) { S.board.items = S.board.items.filter((i) => i !== victim); G.removed++; requestRender(); }
}

// ---------- text editing overlay ----------
const editor = $('#editor');
let editState = null;
function startEdit(it, isNew, before) {
  finishEdit();
  S.editingId = it.id; if (!S.sel.includes(it.id)) S.sel = [it.id];
  editState = { id: it.id, before: before || snap(), isNew, orig: it.text };
  editor.value = it.text || '';
  editor.className = 'editor ' + it.type;
  editor.hidden = false; layoutEditor(); requestRender();
  const focusIt = () => { if (document.activeElement !== editor && S.editingId === it.id) { editor.focus({ preventScroll: true }); editor.setSelectionRange(editor.value.length, editor.value.length); } };
  focusIt(); // synchronous: needed for the on-screen keyboard on iOS/Android
  setTimeout(focusIt, 0);
}
function layoutEditor() {
  const it = S.board.items.find((i) => i.id === S.editingId); if (!it) return;
  const s = S.view.scale, p = toScreen({ x: it.x, y: it.y });
  editor.style.left = p.x + 'px'; editor.style.top = p.y + 'px';
  if (it.type === 'note') {
    Object.assign(editor.style, { width: it.w * s + 'px', height: it.h * s + 'px', fontSize: (it.fontSize || 20) * s + 'px', padding: 12 * s + 'px', background: it.color, color: R.noteTextColor(it) });
  } else {
    const lines = editor.value.split('\n');
    const b = R.bounds({ ...it, text: editor.value || 'Type…' });
    Object.assign(editor.style, { width: Math.max(160, (b.w + 40) * s) + 'px', height: lines.length * it.fontSize * 1.25 * s + 8 + 'px', fontSize: it.fontSize * s + 'px', padding: '0px', background: 'transparent', color: R.col(it.color, R.themeColors(S.theme)) });
  }
  editor.style.fontWeight = it.bold ? '700' : '400'; editor.style.fontStyle = it.italic ? 'italic' : 'normal';
}
editor.addEventListener('input', () => { const it = S.board.items.find((i) => i.id === S.editingId); if (it && it.type === 'text') layoutEditor(); });
editor.addEventListener('keydown', (e) => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); finishEdit(); } });
editor.addEventListener('blur', () => setTimeout(finishEdit, 0));
function finishEdit() {
  if (!editState) return;
  const st = editState; editState = null;
  const it = S.board.items.find((i) => i.id === st.id);
  editor.hidden = true; S.editingId = null;
  if (it) {
    it.text = editor.value;
    if (it.type === 'text' && !it.text.trim()) { S.board.items = S.board.items.filter((i) => i !== it); S.sel = S.sel.filter((id) => id !== it.id); }
  }
  if (snap() !== st.before) { pushUndo(st.before); save(); }
  showCtxBar(); requestRender();
}

// ---------- tools & toolbar ----------
function setTool(t) {
  S.tool = t;
  document.querySelectorAll('.toolbar [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  canvas.dataset.mode = t;
  if (t !== 'select') { S.sel = []; S.multiMode = false; showCtxBar(); requestRender(); }
}
function buildToolbar() {
  const tb = $('#toolbar');
  const tools = [['select', 'Select / move (V)'], ['pen', 'Pen (P)'], ['highlighter', 'Highlighter (H)'], ['eraser', 'Eraser (E)'], ['shape', 'Shapes (S)'], ['text', 'Text (T)'], ['note', 'Sticky note (N)']];
  for (const [t, label] of tools) {
    const b = h('button', { class: 'tool', 'data-tool': t, title: label, 'aria-label': label, html: ICONS[t === 'shape' ? S.shape : t] });
    b.addEventListener('click', () => {
      if (t === 'shape' && S.tool === 'shape') return shapeMenu(b);
      if (t === 'note' && S.tool === 'note') return noteColorMenu(b);
      if (t === 'select' && S.tool === 'select') return selectMenu(b);
      setTool(t);
      if (t === 'shape' && !localStorage.getItem('wb-shape-hint')) { localStorage.setItem('wb-shape-hint', '1'); shapeMenu(b); }
    });
    tb.append(b);
  }
  tb.append(h('button', { class: 'tool', id: 'btnInsert', title: 'Insert image or link', 'aria-label': 'Insert image or link', html: ICONS.plus, onclick: (e) => insertMenu(e.currentTarget) }));
  tb.append(h('button', { class: 'tool swatch-btn', id: 'btnColor', title: 'Colour & size', 'aria-label': 'Colour and size', onclick: (e) => colorMenu(e.currentTarget) }, h('span', { class: 'swatch', id: 'curSwatch' })));
  updateSwatch();
  setTool(S.tool);
}
function updateSwatch() {
  const sw = $('#curSwatch'); if (!sw) return;
  sw.style.background = S.color === 'ink' ? 'var(--fg)' : S.color;
  sw.style.transform = `scale(${0.55 + R.SIZES.indexOf(S.size) * 0.15})`;
}
function selectMenu(anchor) {
  const item = (icon, label, fn) => h('button', { class: 'menu-item', onclick: () => { closePopover(); fn(); } }, h('span', { html: ICONS[icon] }), label);
  const nLocked = S.board.items.filter((i) => i.locked).length;
  popover(anchor, h('div', { class: 'menu' },
    item('multi', S.multiMode ? 'Stop multi-select' : 'Multi-select (tap items to add)', () => setMultiMode(!S.multiMode)),
    item('select', 'Select all', selectAll),
    item('unlock', `Unlock all${nLocked ? ` (${nLocked} locked)` : ''}`, unlockAll)));
}
function shapeMenu(anchor) {
  const wrap = h('div', { class: 'pop-row' });
  for (const s of ['rect', 'ellipse', 'line', 'arrow']) wrap.append(h('button', { class: 'tool' + (S.shape === s ? ' active' : ''), 'aria-label': s, title: s, html: ICONS[s], onclick: () => { S.shape = s; anchor.innerHTML = ICONS[s]; setTool('shape'); closePopover(); } }));
  popover(anchor, wrap);
}
function noteColorMenu(anchor) {
  const wrap = h('div', { class: 'pop-row' });
  for (const c of R.NOTE_COLORS) wrap.append(h('button', { class: 'chip' + (S.noteColor === c ? ' active' : ''), style: `background:${c}`, 'aria-label': 'Note colour ' + c, onclick: () => { S.noteColor = c; closePopover(); } }));
  popover(anchor, h('div', {}, h('div', { class: 'pop-title' }, 'New note colour'), wrap));
}
function colorMenu(anchor) {
  const colors = h('div', { class: 'pop-row wrap' });
  for (const c of R.INK_COLORS) colors.append(h('button', { class: 'chip' + (S.color === c ? ' active' : ''), style: `background:${c === 'ink' ? 'var(--fg)' : c}`, 'aria-label': c === 'ink' ? 'Black/white' : c, onclick: () => { S.color = c; updateSwatch(); closePopover(); colorMenu(anchor); } }));
  const sizes = h('div', { class: 'pop-row' });
  for (const s of R.SIZES) sizes.append(h('button', { class: 'chip size' + (S.size === s ? ' active' : ''), 'aria-label': 'Size ' + s, onclick: () => { S.size = s; updateSwatch(); closePopover(); colorMenu(anchor); } }, h('span', { style: `width:${s + 4}px;height:${s + 4}px` })));
  popover(anchor, h('div', {}, h('div', { class: 'pop-title' }, 'Colour'), colors, h('div', { class: 'pop-title' }, 'Thickness'), sizes));
}
function insertMenu(anchor) {
  const item = (icon, label, fn) => h('button', { class: 'menu-item', onclick: () => { closePopover(); fn(); } }, h('span', { html: ICONS[icon] }), label);
  popover(anchor, h('div', { class: 'menu' },
    item('image', 'Upload picture (saved to Drive)', () => $('#fileImage').click()),
    item('link', 'Picture from URL', insertImageUrl),
    item('open', 'Link a document or web page', insertLinkDialog),
    item('note', 'Sticky note', () => { const c = toWorld({ x: W / 2, y: H / 2 }); const it = { id: uid('i-'), type: 'note', x: c.x - 100, y: c.y - 80, w: 200, h: 160, text: '', color: S.noteColor, fontSize: 20 }; commit(() => S.board.items.push(it)); setTool('select'); setSel([it.id]); startEdit(it, false); }),
  ));
}

// ---------- insert: images & links ----------
function viewCenter() { return toWorld({ x: W / 2, y: H / 2 }); }
async function downscale(file, max = 2000) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (k === 1 && file.size < 3e6) return { blob: file, w: bmp.width, h: bmp.height };
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((r) => c.toBlob(r, type, 0.88));
    return { blob, w: c.width, h: c.height };
  } catch { return { blob: file, w: 400, h: 300 }; }
}
async function insertImageFile(file, at) {
  if (!file || !/^image\//.test(file.type)) return toast('That file is not a picture.');
  const { blob, w, h: hh } = await downscale(file);
  const key = uid('img-');
  await db.put('blobs', { key, blob, mime: blob.type || file.type, name: file.name || `${key}.png`, driveId: null });
  const k = Math.min(1, 420 / Math.max(w, hh)), c = at || viewCenter();
  const it = { id: uid('i-'), type: 'image', blobKey: key, x: c.x - (w * k) / 2, y: c.y - (hh * k) / 2, w: w * k, h: hh * k, name: file.name || '' };
  commit(() => S.board.items.push(it)); setTool('select'); setSel([it.id]);
  toast(navigator.onLine ? 'Picture added. Uploading to Drive…' : 'Picture added. It will upload to Drive when you are back online.');
}
async function insertImageUrl(prefill = '') {
  const v = await ask('Picture from URL', [{ name: 'url', label: 'Image address (https://…)', type: 'url', value: prefill, required: true }], { ok: 'Insert' });
  if (!v || !v.url) return;
  await addImageFromUrl(v.url.trim());
}
async function addImageFromUrl(url, at) {
  let blobKey = null, w = 400, hh = 300;
  try { // cache a copy locally (works when the host allows CORS) so it shows offline
    const res = await fetch(url, { mode: 'cors' });
    if (res.ok) {
      const blob = await res.blob();
      if (/^image\//.test(blob.type)) {
        blobKey = uid('url-'); await db.put('blobs', { key: blobKey, blob, mime: blob.type, external: true, src: url });
        try { const bmp = await createImageBitmap(blob); w = bmp.width; hh = bmp.height; } catch { /* keep defaults */ }
      }
    }
  } catch { /* fall back to service-worker cache */ }
  if (!blobKey) {
    await new Promise((r) => { const im = new Image(); im.onload = () => { w = im.naturalWidth; hh = im.naturalHeight; r(); }; im.onerror = r; im.src = url; });
  }
  const k = Math.min(1, 420 / Math.max(w, hh)), c = at || viewCenter();
  const it = { id: uid('i-'), type: 'image', src: url, ...(blobKey ? { blobKey } : {}), x: c.x - (w * k) / 2, y: c.y - (hh * k) / 2, w: w * k, h: hh * k };
  commit(() => S.board.items.push(it)); setTool('select'); setSel([it.id]);
}
function driveIdFromUrl(url) { const m = url.match(/\/d\/([\w-]{20,})/) || url.match(/[?&]id=([\w-]{20,})/); return m ? m[1] : null; }
async function linkTitle(url) {
  const id = driveIdFromUrl(url);
  if (id && adapter && adapter.isAuthed && adapter.isAuthed() && navigator.onLine && adapter.api) {
    try { const f = await adapter.api(`/files/${id}?fields=name`); return f.name; } catch { /* ignore */ }
  }
  try { const u = new URL(url); return u.hostname + (u.pathname.length > 1 ? u.pathname : ''); } catch { return url; }
}
async function addLink(url, title, at) {
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const c = at || viewCenter();
  const it = { id: uid('i-'), type: 'link', url, kind: R.linkKind(url), title: title || (await linkTitle(url)), x: c.x - 150, y: c.y - 60, w: 300, h: 120 };
  commit(() => S.board.items.push(it)); setTool('select'); setSel([it.id]);
}
async function insertLinkDialog(existing) {
  const extra = h('div', { class: 'stack' });
  if (!existing) {
    const list = h('div', { class: 'doclist' });
    const pickBtn = h('button', { type: 'button', class: 'btn', onclick: async () => {
      if (!canDrive()) return toast('Connect to the internet and sign in to browse Drive.');
      list.textContent = 'Loading…';
      try {
        const files = await adapter.listFiles('documents');
        list.innerHTML = '';
        if (!files.length) list.textContent = 'Whiteboard/documents is empty. Upload a document or paste any Drive/Docs link above.';
        for (const f of files) list.append(h('button', { type: 'button', class: 'menu-item', onclick: () => { closeModal(null); addLink(f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`, f.name); } }, f.name));
      } catch (e) { list.textContent = 'Could not list documents: ' + e.message; }
    } }, 'Choose from Whiteboard/documents');
    const upBtn = h('button', { type: 'button', class: 'btn', onclick: () => {
      if (!canDrive()) return toast('Connect to the internet and sign in to upload documents.');
      const inp = h('input', { type: 'file' });
      inp.onchange = async () => {
        const f = inp.files[0]; if (!f) return;
        closeModal(null); toast(`Uploading “${f.name}” to Whiteboard/documents…`);
        try { const r = await adapter.createFile('documents', f.name, f, f.type || 'application/octet-stream', {}); await addLink(r.webViewLink || `https://drive.google.com/file/d/${r.id}/view`, f.name); toast('Document uploaded and linked.'); }
        catch (e) { toast('Upload failed: ' + e.message, { kind: 'error' }); }
      };
      inp.click();
    } }, 'Upload a document to Drive');
    extra.append(h('div', { class: 'row' }, pickBtn, upBtn), list);
  }
  const v = await ask(existing ? 'Edit link' : 'Link a document', [
    { name: 'url', label: 'Link (Google Doc/Sheet/Slides, Drive file or any https:// page)', type: 'url', value: existing ? existing.url : '', required: true },
    { name: 'title', label: 'Title (optional)', value: existing ? existing.title : '' },
  ], { ok: existing ? 'Save' : 'Add link', extra });
  if (!v || !v.url) return;
  if (existing) commit(() => { existing.url = v.url.trim(); existing.kind = R.linkKind(existing.url); existing.title = v.title || existing.title; });
  else await addLink(v.url.trim(), v.title.trim());
}
function openLink(it) { window.open(it.url, '_blank', 'noopener'); }
function previewLink(it) {
  if (!navigator.onLine) return toast('Preview needs an internet connection. The link card itself works offline.');
  const frame = h('iframe', { src: R.previewUrl(it.url), class: 'preview', allow: 'fullscreen', referrerpolicy: 'no-referrer' });
  openModal(it.title || 'Preview', h('div', { class: 'stack' }, frame, h('div', { class: 'row end' },
    h('span', { class: 'muted small' }, 'Blank? Some sites refuse to be embedded – use Open.'), h('button', { class: 'btn primary', onclick: () => openLink(it) }, 'Open original ↗'))), { wide: true });
}
const canDrive = () => adapter && adapter.isConfigured() && adapter.isAuthed() && navigator.onLine;

// ---------- context bar (selected item actions) ----------
const INK_TYPES = ['stroke', 'rect', 'ellipse', 'line', 'arrow', 'text'];
const FONT_SIZES = { text: { S: 18, M: 28, L: 40, XL: 64 }, note: { S: 16, M: 20, L: 26, XL: 34 } };
function showCtxBar() {
  const bar = $('#ctxbar'); const items = selItems();
  updateMultiBanner();
  if (!items.length || (S.tool !== 'select' && !S.editingId)) { bar.hidden = true; return; }
  bar.innerHTML = '';
  const btn = (icon, label, fn) => bar.append(h('button', { class: 'tool sm', title: label, 'aria-label': label, 'data-act': icon, html: ICONS[icon], onclick: fn }));
  if (items.every((i) => i.locked)) {
    bar.append(h('span', { class: 'ctx-label', html: `${ICONS.lock}<span>Locked${items.length > 1 ? ` (${items.length})` : ''}</span>` }));
    btn('unlock', 'Unlock', () => setLock(false));
    bar.hidden = false; positionCtxBar(); return;
  }
  const one = items.length === 1 ? items[0] : null;
  const notes = items.filter((i) => i.type === 'note'), inks = items.filter((i) => INK_TYPES.includes(i.type));
  const texts = items.filter((i) => i.type === 'note' || i.type === 'text');
  if (items.length > 1) bar.append(h('span', { class: 'ctx-count', title: 'Items selected' }, String(items.length)));
  if (notes.length) bar.append(h('button', { class: 'chip sm', 'data-act': 'notecolor', style: `background:${notes[0].color}`, 'aria-label': 'Note colour', title: 'Note colour', onclick: (e) => {
    const row = h('div', { class: 'pop-row wrap' });
    for (const c of R.NOTE_COLORS) row.append(h('button', { class: 'chip', style: `background:${c}`, 'aria-label': 'Note colour ' + c, onclick: () => { commit(() => notes.forEach((n) => { n.color = c; })); S.noteColor = c; closePopover(); showCtxBar(); } }));
    popover(e.currentTarget, row, { place: 'below' });
  } }));
  if (inks.length) bar.append(h('button', { class: 'chip sm', 'data-act': 'inkcolor', style: `background:${inks[0].color === 'ink' ? 'var(--fg)' : inks[0].color}`, 'aria-label': 'Colour', title: 'Colour', onclick: (e) => {
    const row = h('div', { class: 'pop-row wrap' });
    for (const c of R.INK_COLORS) row.append(h('button', { class: 'chip', style: `background:${c === 'ink' ? 'var(--fg)' : c}`, 'aria-label': 'Colour ' + c, onclick: () => { commit(() => inks.forEach((i) => { i.color = c; })); closePopover(); showCtxBar(); } }));
    popover(e.currentTarget, row, { place: 'below' });
  } }));
  if (texts.length) btn('format', 'Text: size, bold, italic, colour', (e) => formatMenu(e.currentTarget));
  if (one && (one.type === 'note' || one.type === 'text')) btn('edit', 'Edit text', () => startEdit(one, false));
  if (one && one.type === 'link') { btn('open', 'Open original', () => openLink(one)); btn('eye', 'Preview', () => previewLink(one)); btn('edit', 'Edit link', () => insertLinkDialog(one)); }
  if (one && one.type === 'image' && one.src) btn('open', 'Open picture source', () => window.open(one.src, '_blank', 'noopener'));
  btn('multi', S.multiMode ? 'Finish selecting' : 'Select more (tap items to add)', () => setMultiMode(!S.multiMode));
  if (items.length > 1 && !isGroupSel()) btn('group', 'Group', groupSelected);
  if (items.some((i) => i.groupId)) btn('ungroup', 'Ungroup', ungroupSelected);
  btn('lock', 'Lock (stays put)', () => setLock(true));
  btn('copy', 'Duplicate', duplicateSelected);
  btn('front', 'Bring to front', () => reorder(true));
  btn('back', 'Send to back', () => reorder(false));
  btn('trash', 'Delete', deleteSelected);
  bar.querySelector('[data-act=multi]').classList.toggle('active', S.multiMode);
  bar.hidden = false; positionCtxBar();
}
function positionCtxBar() {
  const bar = $('#ctxbar'); const items = selItems(); if (bar.hidden || !items.length) return;
  const b = R.boardBounds(items), p = toScreen({ x: b.x + b.w / 2, y: b.y });
  const bw = bar.offsetWidth;
  if (S.multiMode) { // docked above the toolbar so it never covers items you are tapping
    const tb = $('.toolbar').getBoundingClientRect();
    bar.style.left = Math.max(8, (W - bw) / 2) + 'px'; bar.style.top = Math.max(64, tb.top - bar.offsetHeight - 10) + 'px'; return;
  }
  const top = Math.max(64, p.y - bar.offsetHeight - 16);
  bar.style.left = Math.min(Math.max(8, p.x - bw / 2), W - bw - 8) + 'px'; bar.style.top = Math.min(top, H - 160) + 'px';
}
function deleteSelected() {
  const ids = new Set(selItems().filter((i) => !i.locked).map((i) => i.id)); if (!ids.size) return;
  commit(() => { S.board.items = S.board.items.filter((i) => !ids.has(i.id)); }); setSel([]);
}
function duplicateSelected() {
  const gmap = new Map();
  const copies = selItems().map((it) => {
    const c = JSON.parse(JSON.stringify(it)); c.id = uid('i-'); delete c.locked;
    if (c.groupId) { if (!gmap.has(c.groupId)) gmap.set(c.groupId, uid('g-')); c.groupId = gmap.get(c.groupId); }
    R.moveItem(c, 24, 24); return c;
  });
  commit(() => S.board.items.push(...copies)); setSel(copies.map((c) => c.id));
}
function reorder(toFront) {
  const ids = new Set(S.sel);
  commit(() => { const sel = S.board.items.filter((i) => ids.has(i.id)), rest = S.board.items.filter((i) => !ids.has(i.id)); S.board.items = toFront ? rest.concat(sel) : sel.concat(rest); });
}
function setLock(on) {
  const items = selItems(); if (!items.length) return;
  commit(() => items.forEach((i) => { if (on) i.locked = true; else delete i.locked; }));
  if (on) { setSel([]); toast(`Locked ${items.length > 1 ? items.length + ' items' : ''} – it stays put. To unlock: long-press it, or ⋯ › Unlock all.`, { ms: 3500 }); }
  else showCtxBar();
}
function unlockAll() {
  const locked = S.board.items.filter((i) => i.locked);
  if (!locked.length) return toast('Nothing is locked on this board.');
  commit(() => locked.forEach((i) => { delete i.locked; }));
  setTool('select'); setSel(locked.map((i) => i.id));
  toast(`Unlocked ${locked.length} item(s).`, { ms: 2500 });
}
function groupSelected() {
  const items = selItems(); if (items.length < 2) return;
  const gid = uid('g-'); commit(() => items.forEach((i) => { i.groupId = gid; })); showCtxBar();
}
function ungroupSelected() { commit(() => selItems().forEach((i) => { delete i.groupId; })); showCtxBar(); }
function selectAll() { setTool('select'); setSel(S.board.items.filter((i) => !i.locked).map((i) => i.id)); }
function setMultiMode(on) { S.multiMode = on; showCtxBar(); updateMultiBanner(); }
function updateMultiBanner() {
  const b = $('#multiBanner'); if (!b) return;
  b.hidden = !S.multiMode;
  if (S.multiMode) $('#multiCount').textContent = S.sel.length ? `${S.sel.length} selected` : 'Tap items to select · drag to box-select';
}
function formatMenu(anchor) {
  const texts = selItems().filter((i) => (i.type === 'note' || i.type === 'text') && !i.locked); if (!texts.length) return;
  const first = texts[0];
  const apply = (fn) => { commit(() => texts.forEach(fn)); closePopover(); showCtxBar(); const a = $('#ctxbar [data-act=format]'); if (a) formatMenu(a); };
  const sizeName = (it) => Object.entries(FONT_SIZES[it.type]).find(([, v]) => v === (it.fontSize || (it.type === 'note' ? 20 : 28)));
  const cur = sizeName(first);
  const sizes = h('div', { class: 'pop-row' }, ...['S', 'M', 'L', 'XL'].map((k) => h('button', { class: 'btn sm fmt-size' + (cur && cur[0] === k ? ' primary' : ''), 'data-size': k, 'aria-label': 'Text size ' + k, onclick: () => apply((i) => { i.fontSize = FONT_SIZES[i.type][k]; }) }, k)),
    h('button', { class: 'btn sm', 'aria-label': 'Smaller text', onclick: () => apply((i) => { i.fontSize = Math.max(8, Math.round((i.fontSize || 20) / 1.15)); }) }, 'A−'),
    h('button', { class: 'btn sm', 'aria-label': 'Larger text', onclick: () => apply((i) => { i.fontSize = Math.min(200, Math.round((i.fontSize || 20) * 1.15)); }) }, 'A+'));
  const allBold = texts.every((i) => i.bold), allItalic = texts.every((i) => i.italic);
  const style = h('div', { class: 'pop-row' },
    h('button', { class: 'btn sm fmt-b' + (allBold ? ' primary' : ''), 'aria-label': 'Bold', 'aria-pressed': String(allBold), style: 'font-weight:800', onclick: () => apply((i) => { if (allBold) delete i.bold; else i.bold = true; }) }, 'B'),
    h('button', { class: 'btn sm fmt-i' + (allItalic ? ' primary' : ''), 'aria-label': 'Italic', 'aria-pressed': String(allItalic), style: 'font-style:italic', onclick: () => apply((i) => { if (allItalic) delete i.italic; else i.italic = true; }) }, 'I'));
  const colors = h('div', { class: 'pop-row wrap' }, ...R.INK_COLORS.map((c) => h('button', { class: 'chip fmt-color', 'aria-label': 'Text colour ' + c, style: `background:${c === 'ink' ? 'var(--fg)' : c}`, onclick: () => apply((i) => { if (i.type === 'note') { if (c === 'ink') delete i.textColor; else i.textColor = c; } else i.color = c; }) })));
  popover(anchor, h('div', { class: 'fmt-menu' }, h('div', { class: 'pop-title' }, 'Text size'), sizes, h('div', { class: 'pop-title' }, 'Style'), style, h('div', { class: 'pop-title' }, 'Text colour'), colors), { place: 'below' });
}

// ---------- boards drawer ----------
function renderDrawer() {
  const list = $('#boardList'); if (!list) return;
  list.innerHTML = '';
  for (const b of S.boards) {
    const row = h('div', { class: 'board-row' + (S.board && b.id === S.board.id ? ' current' : '') },
      h('button', { class: 'board-open', onclick: () => { openBoard(b.id); toggleDrawer(false); } }, h('strong', {}, b.name), h('small', {}, `${b.items.length} items · ${fmtTime(b.updatedAt)}${b.dirty ? ' · not yet synced' : ''}`)),
      h('button', { class: 'tool sm', title: 'Board actions', 'aria-label': `Actions for ${b.name}`, html: ICONS.more, onclick: (e) => boardMenu(e.currentTarget, b) }));
    list.append(row);
  }
}
function boardMenu(anchor, b) {
  const item = (icon, label, fn) => h('button', { class: 'menu-item', onclick: () => { closePopover(); fn(); } }, h('span', { html: ICONS[icon] }), label);
  popover(anchor, h('div', { class: 'menu' },
    item('edit', 'Rename', () => renameBoard(b.id)),
    item('copy', 'Duplicate', () => duplicateBoard(b.id)),
    item('note', 'Save as template', () => saveAsTemplate(b.id)),
    item('trash', 'Delete', () => deleteBoard(b.id))), { place: 'below' });
}
function toggleDrawer(open) { const d = $('#drawer'); d.classList.toggle('open', open ?? !d.classList.contains('open')); $('#drawerScrim').classList.toggle('show', d.classList.contains('open')); if (d.classList.contains('open')) renderDrawer(); }
async function renameBoard(id) {
  const b = id === S.board.id ? S.board : await db.get('boards', id);
  const v = await ask('Rename board', [{ name: 'name', label: 'Board name', value: b.name, required: true }], { ok: 'Rename' });
  if (!v || !v.name.trim()) return;
  if (id === S.board.id) { S.board.name = v.name.trim(); $('#boardName').textContent = S.board.name; document.title = `${S.board.name} · My Whiteboard`; await save(); }
  else { b.name = v.name.trim(); b.updatedAt = Date.now(); b.dirty = true; await db.put('boards', b); sync && sync.schedule(); }
  await refreshPending(); renderDrawer();
}
async function duplicateBoard(id) {
  await saveChain;
  const b = await db.get('boards', id);
  await createBoard(b, `${b.name} (copy)`); toast('Board duplicated.');
}
async function deleteBoard(id) {
  const b = await db.get('boards', id);
  if (!(await confirmDlg('Delete board?', `“${b.name}” will be removed from this device and moved to the Drive bin (recoverable for 30 days). Its saved versions stay in Whiteboard/versions.`, 'Delete', true))) return;
  b.deleted = true; b.dirty = true; b.updatedAt = Date.now(); await db.put('boards', b);
  await refreshPending();
  if (S.board.id === id) { const next = S.boards[0]; if (next) await openBoard(next.id); else await createBoard(BUILTIN_TEMPLATES[0], 'My first board'); }
  renderDrawer(); sync && sync.schedule(500); toast('Board deleted.');
}

// ---------- templates ----------
async function allTemplates() {
  const user = (await db.all('templates')).filter((t) => !t.deleted);
  const ids = new Set(user.map((t) => t.id));
  const builtinIds = new Set(BUILTIN_TEMPLATES.map((t) => t.id));
  // A Drive copy of a built-in template (same id) replaces the built-in, so you can customise built-ins in Drive.
  return [...BUILTIN_TEMPLATES.map((t) => user.find((u) => u.id === t.id) || t), ...user.filter((t) => !builtinIds.has(t.id)).map((t) => ({ ...t, user: true }))];
}
async function newBoardDialog() {
  const grid = h('div', { class: 'tpl-grid' });
  for (const t of await allTemplates()) {
    const card = h('div', { class: 'tpl-card' },
      h('button', { class: 'tpl-main', onclick: async () => {
        const v = await ask('New board', [{ name: 'name', label: 'Board name', value: t.id === 'tpl-blank' ? 'Untitled board' : t.name, required: true }], { ok: 'Create' });
        if (v && v.name.trim()) { await createBoard(t, v.name.trim()); toggleDrawer(false); }
      } }, h('canvas', { class: 'tpl-thumb', 'data-tpl': t.id }), h('span', {}, t.name)),
      t.user ? h('button', { class: 'tool sm', title: 'Delete template', 'aria-label': `Delete template ${t.name}`, html: ICONS.trash, onclick: async () => {
        if (!(await confirmDlg('Delete template?', `Delete the template “${t.name}”? Boards made from it are not affected.`, 'Delete', true))) return;
        const rec = await db.get('templates', t.id); rec.deleted = true; await db.put('templates', rec); sync && sync.schedule(500); newBoardDialog();
      } }) : null);
    grid.append(card);
    requestAnimationFrame(() => thumb(card.querySelector('canvas'), t));
  }
  openModal('New board – choose a template', h('div', { class: 'stack' }, grid, h('p', { class: 'muted small' }, 'Tip: customise any board, then use ⋯ › “Save as template” to reuse it.')), { wide: true });
}
function thumb(c, t) {
  const w = 160, hh = 100; c.width = w * 2; c.height = hh * 2; const x = c.getContext('2d');
  const bb = R.boardBounds(t.items), s = Math.min((w * 2 - 20) / Math.max(bb.w, 1), (hh * 2 - 20) / Math.max(bb.h, 1), 0.6);
  R.drawBoard(x, { ...t, items: t.items }, { x: w - (bb.x + bb.w / 2) * s, y: hh - (bb.y + bb.h / 2) * s, scale: s }, w * 2, hh * 2, { ...env(), editingId: null });
}
async function saveAsTemplate(id) {
  await saveChain;
  const b = id ? await db.get('boards', id) : S.board;
  const v = await ask('Save as template', [{ name: 'name', label: 'Template name', value: b.name, required: true }], { ok: 'Save template' });
  if (!v || !v.name.trim()) return;
  const existing = (await db.all('templates')).find((t) => !t.deleted && t.name === v.name.trim());
  const t = { id: existing ? existing.id : uid('tpl-'), name: v.name.trim(), background: b.background, items: JSON.parse(JSON.stringify(b.items)), dirty: true, deleted: false, driveFileId: existing ? existing.driveFileId : null };
  await db.put('templates', t); sync && sync.schedule(500);
  toast(existing ? `Template “${t.name}” updated.` : `Saved template “${t.name}”. Find it under New board.`);
}

// ---------- search ----------
async function searchDialog() {
  const input = h('input', { type: 'search', placeholder: 'Search notes, text, links and board names…', class: 'search-input', 'aria-label': 'Search' });
  const out = h('div', { class: 'results' });
  const run = async () => {
    const q = input.value.trim().toLowerCase(); out.innerHTML = '';
    if (!q) return;
    const boards = (await db.all('boards')).filter((b) => !b.deleted);
    if (S.board) { const i = boards.findIndex((b) => b.id === S.board.id); if (i >= 0) boards[i] = S.board; }
    let n = 0;
    for (const b of boards) {
      const hits = [];
      if (b.name.toLowerCase().includes(q)) hits.push({ label: 'Board name', text: b.name });
      for (const it of b.items) {
        const txt = it.type === 'note' || it.type === 'text' ? it.text : it.type === 'link' ? `${it.title} ${it.url}` : '';
        if (txt && txt.toLowerCase().includes(q)) hits.push({ it, label: it.type === 'note' ? 'Sticky note' : it.type === 'text' ? 'Text' : 'Link', text: txt });
      }
      if (!hits.length) continue;
      const grp = h('div', { class: 'result-group' }, h('div', { class: 'result-board' }, `📋 ${b.name}`));
      for (const r of hits.slice(0, 20)) {
        const i = r.text.toLowerCase().indexOf(q), s = Math.max(0, i - 30);
        const snip = (s ? '…' : '') + esc(r.text.slice(s, i)) + '<mark>' + esc(r.text.slice(i, i + q.length)) + '</mark>' + esc(r.text.slice(i + q.length, i + q.length + 60));
        grp.append(h('button', { class: 'result', onclick: async () => {
          closeModal(null); if (!S.board || S.board.id !== b.id) await openBoard(b.id);
          if (r.it) { const live = S.board.items.find((x) => x.id === r.it.id); if (live) { setTool('select'); setSel([live.id]); centerOn(live); } }
        } }, h('small', {}, r.label), h('span', { html: snip })));
        n++;
      }
      out.append(grp);
    }
    if (!n) out.append(h('p', { class: 'muted' }, 'No matches.'));
  };
  input.addEventListener('input', run);
  openModal('Search all boards', h('div', { class: 'stack' }, input, out), { wide: true });
}

// ---------- versions ----------
async function versionsDialog() {
  const body = h('div', { class: 'stack' });
  const saveBtn = h('button', { class: 'btn', onclick: async () => {
    if (!canDrive()) return toast('Saving a version needs Drive (online and signed in).');
    await saveChain; await sync.saveVersion(S.board, 'manual'); toast('Version saved to Drive.'); closeModal(); versionsDialog();
  } }, 'Save version now');
  body.append(h('p', { class: 'muted small' }, `The last ${cfg.MAX_VERSIONS || 5} versions of each board are kept in Drive › Whiteboard/versions. A version is saved automatically at most every ${cfg.VERSION_INTERVAL_MINUTES ?? 10} minutes while you edit, whenever a sync conflict overwrites something, and before a restore.`), saveBtn);
  const list = h('div', { class: 'results' }, 'Loading…'); body.append(list);
  openModal(`Version history – ${S.board.name}`, body, { wide: true });
  if (!canDrive()) { list.textContent = 'Version history is stored in Drive – connect to the internet and sign in to view it.'; return; }
  try {
    const vs = await sync.listVersions(S.board.id);
    list.innerHTML = '';
    if (!vs.length) list.textContent = 'No versions yet.';
    const reasons = { auto: 'Automatic', manual: 'Saved manually', created: 'Board created', 'overwritten-remote': 'Copy from another device (overwritten)', 'overwritten-local': 'Your offline edits (overwritten)', 'before-restore': 'Before a restore' };
    for (const v of vs) {
      list.append(h('div', { class: 'version-row' }, h('div', {}, h('strong', {}, fmtTime(v.appProperties.savedAt)), h('br'), h('small', { class: 'muted' }, reasons[v.appProperties.reason] || v.appProperties.reason)),
        h('button', { class: 'btn', onclick: async () => {
          if (!(await confirmDlg('Restore this version?', 'The board will be replaced by this version. Its current state is saved as a version first, so you can undo this.', 'Restore'))) return;
          try {
            await saveChain; await sync.saveVersion(S.board, 'before-restore');
            const data = await adapter.readJSON(v.id);
            commit(() => { S.board.items = data.items || []; S.board.background = data.background || 'grid'; });
            toast('Version restored.'); fitView();
          } catch (e) { toast('Restore failed: ' + e.message, { kind: 'error' }); }
        } }, 'Restore')));
    }
  } catch (e) { list.textContent = 'Could not load versions: ' + e.message; }
}

// ---------- import / export ----------
async function importJSONFile(file) {
  try {
    const d = JSON.parse(await file.text());
    if (!Array.isArray(d.items)) throw new Error('Not a My Whiteboard JSON file');
    await createBoard({ name: d.name || file.name.replace(/\.json$/, ''), background: d.background, items: d.items }, `${d.name || 'Imported board'}`);
    toast('Board imported.');
  } catch (e) { toast('Import failed: ' + e.message, { kind: 'error' }); }
}
async function doExport(kind) {
  try {
    finishEdit();
    if (kind === 'png') await exportPNG(S.board, env());
    else if (kind === 'pdf') await exportPDF(S.board, { ...env(), theme: 'light' }); // PDFs are for printing: always light
    else exportJSON(S.board);
  } catch (e) {
    toast(e.name === 'SecurityError' ? 'A picture from another website blocks image export. Upload the picture instead, or export JSON.' : 'Export failed: ' + e.message, { kind: 'error', ms: 7000 });
  }
}

// ---------- more menu ----------
function moreMenu(anchor) {
  const item = (icon, label, fn) => h('button', { class: 'menu-item', onclick: () => { closePopover(); fn(); } }, h('span', { html: ICONS[icon] }), label);
  const bgRow = h('div', { class: 'pop-row' }, ...['grid', 'dots', 'solid'].map((bg) => h('button', { class: 'btn sm' + (S.board.background === bg ? ' primary' : ''), onclick: () => { commit(() => { S.board.background = bg; }); closePopover(); } }, bg[0].toUpperCase() + bg.slice(1))));
  const signedIn = adapter && adapter.isConfigured() && adapter.hasSignedInBefore();
  popover(anchor, h('div', { class: 'menu' },
    item('plus', 'New board…', newBoardDialog),
    item('theme', S.theme === 'dark' ? 'Light mode' : 'Dark mode', toggleTheme),
    item('copy', 'Duplicate this board', () => duplicateBoard(S.board.id)),
    item('note', 'Save board as template…', () => saveAsTemplate(S.board.id)),
    item('undo', 'Version history…', versionsDialog),
    item('unlock', 'Unlock all items on this board', unlockAll),
    h('div', { class: 'pop-title' }, 'Background'), bgRow,
    h('div', { class: 'pop-title' }, 'Export'),
    item('image', 'Export as PNG image', () => doExport('png')),
    item('open', 'Export as PDF', () => doExport('pdf')),
    item('copy', 'Export as JSON (backup)', () => doExport('json')),
    item('plus', 'Import JSON…', () => $('#fileJSON').click()),
    h('div', { class: 'pop-title' }, 'Sync'),
    item('redo', 'Sync now', () => manualSync()),
    adapter && adapter.folderUrl && adapter.folderUrl() ? item('open', 'Open Whiteboard folder in Drive', () => window.open(adapter.folderUrl(), '_blank', 'noopener')) : null,
    signedIn ? item('close', `Sign out (${adapter.email})`, signOut) : null,
    item('eye', 'Offline status & help', helpDialog)), { place: 'below' });
}
async function helpDialog() {
  const cached = 'caches' in window ? (await caches.keys()).some((k) => k.startsWith('wb-shell')) : false;
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
  const last = await kv.get('lastSync', 0);
  const lines = [
    `Offline app: ${cached ? '✅ ready – this page opens without internet' : '⏳ not cached yet (reload once while online)'}`,
    `Storage on this device: ${persisted ? 'protected from automatic clean-up' : 'standard (browser may clear it under heavy storage pressure)'}`,
    `Drive account: ${adapter && adapter.isConfigured() ? (adapter.email || 'not signed in') : 'not configured (local-only mode)'}`,
    `Last successful sync: ${last ? fmtTime(last) : 'never'}`,
    `Changes waiting to sync: ${S.pending}`,
  ];
  openModal('Offline status & help', h('div', { class: 'stack' }, ...lines.map((l) => h('p', {}, l)),
    h('p', { class: 'muted small' }, 'Tips: two fingers pan & zoom on touch. With the Select tool, drag empty space to pan; double-tap a note to edit it. Keyboard: V select, P pen, H highlighter, E eraser, S shapes, T text, N note, Ctrl+Z / Ctrl+Shift+Z, Delete removes the selection, Space+drag pans. Shift-click or Shift+drag (box) selects several; Ctrl+A all, Ctrl+G group, Ctrl+Shift+G ungroup, Ctrl+L lock/unlock, Ctrl+B bold, Ctrl+I italic. Long-press a locked item to select it, then Unlock. Paste a picture or link straight onto the board.'),
    h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: () => { closeModal(); manualSync(); } }, 'Sync now'))));
}

// ---------- sync / auth ----------
function renderSyncPill() {
  const pill = $('#syncPill'); const st = S.syncState;
  const labels = { local: 'Local only', signin: 'Sign in', offline: 'Offline', syncing: 'Syncing…', synced: 'Synced', error: 'Sync error' };
  let txt = labels[st] || st;
  if ((st === 'offline' || st === 'signin' || st === 'error') && S.pending) txt += ` · ${S.pending}`;
  if (st === 'synced' && S.pending) txt = 'Saved locally';
  pill.textContent = txt; pill.dataset.state = st === 'synced' && S.pending ? 'pending' : st;
  pill.title = {
    local: 'Drive sync is not configured – changes are saved on this device only.',
    signin: 'Tap to sign in with Google and sync to Drive.',
    offline: `You are offline. Everything is saved on this device${S.pending ? ` (${S.pending} change(s) waiting)` : ''} and will sync automatically when you reconnect.`,
    syncing: 'Syncing with Google Drive…', synced: 'All changes are in Google Drive. Tap to sync now.',
    error: `Sync failed: ${S.syncMsg}. Tap to retry.`,
  }[st] || '';
}
function setSyncState(st, msg = '') { S.syncState = st; S.syncMsg = msg; refreshPending(); }
async function manualSync() {
  if (!adapter || !adapter.isConfigured()) return helpLocalOnly();
  if (!navigator.onLine) return toast('You are offline. Your changes are safe on this device and will sync when you reconnect.');
  if (!adapter.isAuthed()) return signIn();
  const r = await sync.syncNow();
  if (r && r.ok) toast('Synced with Google Drive.', { ms: 1800 });
}
function helpLocalOnly() {
  openModal('Drive sync not set up', h('div', { class: 'stack' }, h('p', {}, 'This copy of My Whiteboard has no Google OAuth Client ID yet, so boards are saved on this device only.'), h('p', {}, 'Add your Client ID to config.js (see README › One-time setup) to sync with your Drive “Whiteboard” folder.')));
}
async function signIn() {
  try {
    const email = await adapter.signIn();
    toast(`Signed in as ${email}.`, { ms: 2500 });
    closeModal();
    await sync.syncNow();
  } catch (e) { toast('Sign-in failed: ' + e.message, { kind: 'error', ms: 7000 }); setSyncState(adapter.isAuthed() ? 'synced' : 'signin'); }
}
async function signOut() {
  const wipe = await confirmDlg('Sign out', 'Sign out of Google on this device? Choose “Sign out & clear” to also remove the local copy of your boards from this device (anything not yet synced will be lost).', 'Sign out & clear', true);
  if (!wipe) return;
  adapter.signOut();
  await new Promise((r) => { const q = indexedDB.deleteDatabase('my-whiteboard'); q.onsuccess = q.onerror = q.onblocked = r; });
  localStorage.clear(); location.reload();
}
function signInGate() {
  const b = h('div', { class: 'stack center' },
    h('p', {}, 'My Whiteboard is private. Sign in with your Google account to load your boards from Drive.'),
    h('button', { class: 'btn primary big', onclick: signIn }, 'Sign in with Google'),
    h('p', { class: 'muted small' }, 'After the first sign-in the app also works offline on this device.'));
  openModal('Welcome to My Whiteboard', b);
}

// ---------- keyboard, paste, drop ----------
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, [contenteditable]')) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'f') { e.preventDefault(); searchDialog(); return; }
  if (mod && k === 'a') { e.preventDefault(); selectAll(); return; }
  if (mod && k === 'g') { e.preventDefault(); e.shiftKey ? ungroupSelected() : groupSelected(); return; }
  if (mod && k === 'l') { e.preventDefault(); if (S.sel.length) setLock(!selItems().every((i) => i.locked)); return; }
  if (mod && (k === 'b' || k === 'i') && S.sel.length) {
    e.preventDefault(); const texts = selItems().filter((i) => (i.type === 'note' || i.type === 'text') && !i.locked); const key = k === 'b' ? 'bold' : 'italic';
    const all = texts.every((i) => i[key]); if (texts.length) commit(() => texts.forEach((i) => { if (all) delete i[key]; else i[key] = true; })); return;
  }
  if (mod) return;
  if (k === ' ') { spaceDown = true; canvas.dataset.mode = 'hand'; e.preventDefault(); return; }
  if ((k === 'delete' || k === 'backspace') && S.sel.length) { e.preventDefault(); deleteSelected(); return; }
  if (k === 'escape') { S.multiMode = false; setSel([]); closePopover(); return; }
  const map = { v: 'select', p: 'pen', h: 'highlighter', e: 'eraser', s: 'shape', t: 'text', n: 'note' };
  if (map[k]) setTool(map[k]);
  if (k === '+' || k === '=') zoomAt(1.2, { x: W / 2, y: H / 2 });
  if (k === '-') zoomAt(1 / 1.2, { x: W / 2, y: H / 2 });
  if (k === '0') fitView();
});
document.addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; canvas.dataset.mode = S.tool; } });
document.addEventListener('paste', async (e) => {
  if (e.target.matches('input, textarea')) return;
  const files = [...(e.clipboardData.files || [])].filter((f) => /^image\//.test(f.type));
  if (files.length) { e.preventDefault(); for (const f of files) await insertImageFile(f); return; }
  const t = (e.clipboardData.getData('text') || '').trim(); if (!t) return;
  e.preventDefault();
  if (/^https?:\/\/\S+$/i.test(t)) { if (/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(t)) addImageFromUrl(t); else addLink(t); }
  else { const c = viewCenter(); const it = { id: uid('i-'), type: 'note', x: c.x - 100, y: c.y - 80, w: 220, h: 170, text: t, color: S.noteColor, fontSize: 20 }; commit(() => S.board.items.push(it)); }
});
canvas.addEventListener('dragover', (e) => e.preventDefault());
canvas.addEventListener('drop', async (e) => {
  e.preventDefault(); const at = toWorld(pt(e));
  for (const f of e.dataTransfer.files) { if (/^image\//.test(f.type)) await insertImageFile(f, at); else if (/json/.test(f.type) || f.name.endsWith('.json')) await importJSONFile(f); }
  const url = e.dataTransfer.getData('text/uri-list'); if (url && !e.dataTransfer.files.length) addLink(url.split('\n')[0], '', at);
});

// ---------- boot ----------
async function boot() {
  initTheme();
  buildToolbar();
  $('#btnBoards').innerHTML = ICONS.menu; $('#btnSearch').innerHTML = ICONS.search; $('#btnTheme').innerHTML = ICONS.theme; $('#btnMore').innerHTML = ICONS.more;
  $('#btnUndo').innerHTML = ICONS.undo; $('#btnRedo').innerHTML = ICONS.redo; $('#zoomOut').innerHTML = ICONS.minus; $('#zoomIn').innerHTML = ICONS.plus; $('#zoomFit').innerHTML = ICONS.fit;
  $('#btnBoards').onclick = () => toggleDrawer(); $('#drawerClose').onclick = () => toggleDrawer(false); $('#drawerScrim').onclick = () => toggleDrawer(false);
  $('#btnNewBoard').onclick = newBoardDialog; $('#boardName').onclick = () => renameBoard(S.board.id);
  $('#btnSearch').onclick = searchDialog; $('#btnTheme').onclick = toggleTheme; $('#btnMore').onclick = (e) => moreMenu(e.currentTarget);
  $('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
  $('#zoomIn').onclick = () => zoomAt(1.25, { x: W / 2, y: H / 2 }); $('#zoomOut').onclick = () => zoomAt(0.8, { x: W / 2, y: H / 2 }); $('#zoomFit').onclick = fitView;
  $('#zoomPct').onclick = () => { S.view.scale = 1; zoomAt(1, { x: W / 2, y: H / 2 }); };
  $('#syncPill').onclick = manualSync;
  $('#multiDone').onclick = () => setMultiMode(false);
  $('#modalClose').onclick = () => closeModal(null); $('#modal').addEventListener('pointerdown', (e) => { if (e.target.id === 'modal') closeModal(null); });
  $('#fileImage').onchange = async (e) => { for (const f of e.target.files) await insertImageFile(f); e.target.value = ''; };
  $('#fileJSON').onchange = async (e) => { if (e.target.files[0]) await importJSONFile(e.target.files[0]); e.target.value = ''; };
  addEventListener('resize', () => { resize(); if (S.editingId) layoutEditor(); });
  resize();

  // Storage: ask the browser to keep our offline data.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // Drive adapter
  if (MOCK) { const m = await import('./mockdrive.js'); adapter = new m.MockDriveAdapter(); }
  else adapter = new GoogleDriveAdapter(cfg);
  sync = createSync({
    adapter, cfg,
    onStatus: setSyncState,
    onNotice: (msg) => toast(msg, { ms: 9000, kind: 'warn', action: 'History', onAction: versionsDialog }),
    onBoardChanged: (id) => { if (S.board && S.board.id === id) reloadCurrentFromDB(); },
    onBoardsListChanged: async () => { await refreshPending(); renderDrawer(); },
  });

  await refreshPending();
  let cur = localStorage.getItem('wb-current');
  if (!S.boards.length) {
    if (canDrive()) await sync.syncNow(); // first run on a new device: pull from Drive
    await refreshPending();
  }
  if (!S.boards.length) await createBoard(BUILTIN_TEMPLATES[0], 'My first board');
  else if (!(cur && (await openBoard(cur)))) await openBoard(S.boards[0].id);

  setSyncState(sync.status() || 'synced');
  addEventListener('online', () => { setSyncState(sync.status() || 'synced'); sync.syncNow(); });
  addEventListener('offline', () => setSyncState('offline'));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync.syncNow(); });
  setInterval(() => { if (document.visibilityState === 'visible') sync.syncNow(); }, (cfg.POLL_SECONDS || 60) * 1000);
  if (adapter.isConfigured() && !adapter.hasSignedInBefore() && !MOCK) signInGate();
  else sync.syncNow();

  // Service worker = offline app shell.
  if ('serviceWorker' in navigator && !params.has('nosw')) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW failed', e));
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('A new version of My Whiteboard is ready.', { ms: 0, action: 'Reload', onAction: () => location.reload() });
    });
  }
}

// Test / debugging hook (no secrets here).
window.__wb = { S, get adapter() { return adapter; }, get sync() { return sync; }, db, kv, openBoard, createBoard, setTool, setSel, selItems, commit, save, undo, redo, refreshPending, BUILTIN_TEMPLATES, toWorld, toScreen, saveChainDone: () => saveChain };
boot().catch((e) => { console.error(e); toast('Startup error: ' + e.message, { kind: 'error', ms: 0 }); });
