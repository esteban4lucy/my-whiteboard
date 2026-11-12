// My Whiteboard – main app. Offline-first: every change is written to IndexedDB first,
// then pushed to Google Drive by the sync engine when online.
import { db, kv, uid } from './db.js';
import * as R from './render.js';
import { BUILTIN_TEMPLATES } from './templates.js';
import { smooth as inkSmooth, recognize } from './ink.js';
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
  if (G && G.draft) { if (G.draft.from) R.updateConnectors([...S.board.items, G.draft]); R.drawItem(ctx, G.draft, e); }
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
    if (sel.some(isLocked)) drawLockBadge(ctx, b.x + b.w + pad, b.y - pad, k, e.tc.sel);
    else for (const hd of handles(sel)) {
      const s = HANDLE * k;
      ctx.fillStyle = '#fff'; ctx.strokeStyle = e.tc.sel; ctx.lineWidth = 2 * k;
      ctx.beginPath(); ctx.arc(hd.x, hd.y, s / 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
  ctx.restore();
  $('#zoomPct').textContent = Math.round(S.view.scale * 100) + '%';
  positionCtxBar();
  if (PREF.map && !P.on) drawMinimap();
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
// Locked = locked itself, or on the background layer while the background is locked.
const isLocked = (it) => !!it.locked || (it.layer === 'bg' && !!(S.board && S.board.bgLocked));
// Per-device arrange preferences.
const GRID = 20;
const PREF = { grid: localStorage.getItem('wb-snap-grid') === '1', cols: localStorage.getItem('wb-snap-cols') !== '0', map: localStorage.getItem('wb-minimap') === '1', smooth: localStorage.getItem('wb-smooth') !== '0', shapes: localStorage.getItem('wb-shapes') === '1' };
function setPref(k, v, key) { PREF[k] = v; localStorage.setItem(key, v ? '1' : '0'); }
const snapV = (v) => (PREF.grid ? Math.round(v / GRID) * GRID : v);
const CONN_TYPES = ['line', 'arrow'];
const attachAt = (w, exclude = null) => topHit(w, (x) => !CONN_TYPES.includes(x.type) && x.type !== 'stroke' && x !== exclude, true);
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
const snap = () => JSON.stringify({ items: S.board.items, background: S.board.background, bgLocked: !!S.board.bgLocked });
function pushUndo(s) { S.undo.push(s); if (S.undo.length > 100) S.undo.shift(); S.redo = []; updateUndoBtns(); }
function commit(fn) { const s = snap(); fn(); if (snap() !== s) { pushUndo(s); save(); } requestRender(); }
function restore(s) { const d = JSON.parse(s); S.board.items = d.items; S.board.background = d.background; if (d.bgLocked) S.board.bgLocked = true; else delete S.board.bgLocked; S.sel = S.sel.filter((id) => byId(id)); save(); requestRender(); showCtxBar(); }
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

const fmtDateLong = (d = new Date()) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
function applyRep(str, rep) { let out = String(str ?? ''); for (const [k, v] of Object.entries(rep || {})) out = out.split(k).join(String(v)); return out; }
// Placeholders in templates: {{date}} becomes today's date (e.g. "16 Nov 2026") unless replaced otherwise.
function newBoardFrom(tpl, name, rep = null) {
  rep = { '{{date}}': fmtDateLong(), ...(rep || {}) };
  const fresh = JSON.parse(JSON.stringify(tpl.items || []));
  for (const it of fresh) {
    if (typeof it.text === 'string') it.text = applyRep(it.text, rep);
    if (typeof it.title === 'string') it.title = applyRep(it.title, rep);
  }
  const gmap = new Map(), idmap = new Map(fresh.map((i) => [i.id, uid('i-')]));
  for (const it of fresh) { it.id = idmap.get(it.id); for (const k of ['from', 'to']) if (it[k]) { if (idmap.has(it[k])) it[k] = idmap.get(it[k]); else delete it[k]; } if (it.groupId) { if (!gmap.has(it.groupId)) gmap.set(it.groupId, uid('g-')); it.groupId = gmap.get(it.groupId); } }
  const now = Date.now();
  return { id: uid('b-'), name: applyRep(name || tpl.name, rep), background: tpl.background || 'grid', ...(tpl.bgLocked ? { bgLocked: true } : {}), items: fresh, createdAt: now, updatedAt: now, dirty: true, deleted: false };
}
// Drive inbox: a {"type":"new-board", ...} or {"type":"add-items", ...} JSON file in Whiteboard/inbox (see README).
async function makeInboxBoard(d, boardId) {
  const fail = (m) => { const e = new Error(m); e.inbox = true; throw e; };
  const tpls = await allTemplates();
  const key = String(d.template || 'Blank').trim().toLowerCase();
  const tpl = tpls.find((t) => t.id.toLowerCase() === key || t.name.toLowerCase() === key || t.id === 'tpl-' + key.replace(/\s+/g, '-'));
  if (!tpl) fail(`unknown template “${d.template}” (use one of: ${tpls.map((t) => t.name).join(', ')})`);
  if (d.replace && typeof d.replace !== 'object') fail('“replace” must be an object like {"{{date}}": "16 Nov 2026"}');
  const b = newBoardFrom(tpl, String(d.name).slice(0, 200), d.replace);
  b.id = boardId; b.inboxFile = true;
  const notes = Array.isArray(d.notes) ? d.notes.slice(0, 200) : [];
  if (notes.length) {
    const bb = b.items.length ? R.boardBounds(b.items) : { x: 0, y: -60, w: 0, h: 0 };
    notes.forEach((n, i) => {
      const o = typeof n === 'string' ? { text: n } : (n || {});
      const it = { id: uid('i-'), type: 'note', x: bb.x + (i % 4) * 240, y: bb.y + bb.h + 60 + Math.floor(i / 4) * 200, w: 220, h: 170, text: applyRep(o.text || '', { '{{date}}': fmtDateLong(), ...(d.replace || {}) }), color: /^#[0-9a-f]{6}$/i.test(o.color || '') ? o.color : R.NOTE_COLORS[0], fontSize: 20 };
      if (Array.isArray(o.tags) && o.tags.length) it.tags = o.tags.map(String).slice(0, 8);
      if (/^\d{4}-\d{2}-\d{2}$/.test(o.due || '')) it.due = o.due;
      b.items.push(it);
    });
  }
  if (d.pinned) b.pinned = true;
  if (Array.isArray(d.tags) && d.tags.length) b.tags = d.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8);
  return b;
}
// Place a note in empty space near the centre of existing content, without overlapping anything.
function placeFree(items, w, h) {
  const hits = (a, b, pad = 16) => a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
  const boxes = (items || []).map((it) => R.bounds(it));
  const bb = R.boardBounds(items || []);
  const cx = bb.x + bb.w / 2 - w / 2, cy = bb.y + bb.h / 2 - h / 2;
  const free = (x, y) => !boxes.some((b) => hits({ x, y, w, h }, b));
  if (free(cx, cy)) return { x: cx, y: cy };
  const step = 40;
  for (let r = 1; r <= 50; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx * step, y = cy + dy * step;
        if (free(x, y)) return { x, y };
      }
    }
  }
  return { x: bb.x, y: bb.y + bb.h + 24 };
}
// Drive inbox add-items: build sticky notes to append to an existing board. Skips ids already present.
function makeInboxItems(d, board, fileId) {
  const fail = (m) => { const e = new Error(m); e.inbox = true; throw e; };
  if (!Array.isArray(d.items) || !d.items.length) fail('"items" must be a non-empty array');
  const existing = (board.items || []).slice();
  const have = new Set(existing.map((it) => it.id));
  const out = [];
  const prefix = String(d.id || fileId || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  d.items.slice(0, 200).forEach((raw, i) => {
    const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { text: String(raw ?? '') };
    const typ = String(o.type || 'note').toLowerCase();
    if (typ !== 'note') fail(`unsupported item type “${o.type}” (only "note" is supported)`);
    const id = prefix ? `i-inbox-${prefix}-${i}` : uid('i-');
    if (have.has(id)) return;
    const w = Number.isFinite(+o.w) && +o.w > 0 ? +o.w : 200;
    const h = Number.isFinite(+o.h) && +o.h > 0 ? +o.h : 160;
    const placed = Number.isFinite(+o.x) && Number.isFinite(+o.y) ? { x: +o.x, y: +o.y } : placeFree(existing.concat(out), w, h);
    const it = {
      id, type: 'note', x: placed.x, y: placed.y, w, h,
      text: String(o.text || ''),
      color: /^#[0-9a-f]{6}$/i.test(o.color || '') ? o.color : '#fff59d',
      fontSize: Number.isFinite(+o.fontSize) && +o.fontSize > 0 ? +o.fontSize : 20,
    };
    if (Array.isArray(o.tags) && o.tags.length) it.tags = o.tags.map(String).slice(0, 8);
    if (/^\d{4}-\d{2}-\d{2}$/.test(o.due || '')) it.due = o.due;
    out.push(it); have.add(id);
  });
  return out;
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
  const order = R.drawOrder(S.board.items), hid = R.hiddenIds(S.board.items);
  for (let i = order.length - 1; i >= 0; i--) {
    const it = order[i];
    if (hid.has(it.id) || (isLocked(it) && !allowLocked) || !filter(it)) continue;
    if (R.hit(it, w.x, w.y, tol())) return it;
  }
  return null;
}
function handleHit(w) {
  const sel = selItems(); if (!sel.length || sel.some(isLocked)) return null;
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
  if (P.on) { e.preventDefault(); P.down = pt(e); return; }
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
    case 'shape': {
      const a = CONN_TYPES.includes(S.shape) ? attachAt(w) : null; // start an arrow/line on an item = attached connector
      const x = a ? w.x : snapV(w.x), y = a ? w.y : snapV(w.y);
      G = { type: 'shape', p0: { x, y }, draft: { id: uid('i-'), type: S.shape, x1: x, y1: y, x2: x, y2: y, color: S.color, size: Math.max(2, S.size), ...(a ? { from: a.id } : {}) } }; break;
    }
    case 'text': { const before = snap(); const it = { id: uid('i-'), type: 'text', x: w.x, y: w.y - 14, text: '', fontSize: 28, color: S.color }; S.board.items.push(it); setTool('select'); setSel([it.id]); startEdit(it, true, before); G = null; break; }
    case 'note': {
      const it = { id: uid('i-'), type: 'note', x: snapV(w.x - 100), y: snapV(w.y - 80), w: 200, h: 160, text: '', color: S.noteColor, fontSize: 20 };
      commit(() => S.board.items.push(it)); setTool('select'); setSel([it.id]); startEdit(it, false); G = null; break;
    }
    default: { // select
      const additive = e.shiftKey || e.ctrlKey || e.metaKey || S.multiMode;
      const hk = handleHit(w);
      if (hk) {
        const sel = selItems(); G = { type: 'resize', k: hk, snap: snap(), w0: w, orig: sel.map((i) => JSON.parse(JSON.stringify(i))), ob: R.boardBounds(sel) };
        if (hk === 'p1') delete sel[0].from; if (hk === 'p2') delete sel[0].to; // dragging an end detaches it (re-attaches on drop over an item)
        break;
      }
      const it = topHit(w);
      if (it) {
        let removeOnTap = null;
        if (additive) {
          const grp = expandGroups([it.id]);
          if (S.sel.includes(it.id)) removeOnTap = grp; else setSel([...S.sel, ...grp]);
        } else if (!S.sel.includes(it.id)) setSel([it.id]);
        let openLink = false;
        if (it.type === 'link' && S.sel.length === 1) { const o = R.linkOpenRect(it); openLink = w.x >= o.x && w.x <= o.x + o.w && w.y >= o.y && w.y <= o.y + o.h; }
        G = { type: 'move', ids: [...S.sel], tapId: it.id, w0: w, p0: p, moved: false, snap: snap(), openLink, removeOnTap };
      } else if (additive) {
        G = { type: 'marquee', p0: w, cur: w, base: [...S.sel] };
      } else {
        setSel([]);
        G = { type: 'pan', p0: p, v0: { ...S.view } };
        const lockedIt = topHit(w, isLocked, true);
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
      if (!(CONN_TYPES.includes(S.shape) && attachAt(w))) { x2 = snapV(x2); y2 = snapV(y2); }
      G.draft.x2 = x2; G.draft.y2 = y2; requestRender(); break;
    }
    case 'move': {
      if (!G.moved && Math.hypot(p.x - G.p0.x, p.y - G.p0.y) < 6) return;
      if (!G.moved) prepMove(G);
      G.moved = true;
      let dx = w.x - G.w0.x, dy = w.y - G.w0.y;
      if (PREF.grid) { dx = Math.round((G.ob.x + dx) / GRID) * GRID - G.ob.x; dy = Math.round((G.ob.y + dy) / GRID) * GRID - G.ob.y; }
      const ddx = dx - G.applied.x, ddy = dy - G.applied.y; G.applied = { x: dx, y: dy };
      if (ddx || ddy) for (const id of G.ids) { const it = byId(id); if (it && !isLocked(it)) R.moveItem(it, ddx, ddy); }
      requestRender();
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
      } else { it.w = Math.max(it.type === 'link' ? 200 : it.type === 'frame' ? 160 : 60, snapV(o.x + o.w + dx) - o.x); it.h = Math.max(it.type === 'link' ? 100 : it.type === 'frame' ? 100 : 60, snapV(o.y + o.h + dy) - o.y); }
      if (it.type === 'rect' || it.type === 'ellipse') { if (o.x2 >= o.x1) it.x2 = snapV(it.x2); else it.x1 = snapV(it.x1); if (o.y2 >= o.y1) it.y2 = snapV(it.y2); else it.y1 = snapV(it.y1); }
      requestRender(); break;
    }
  }
});

function endPointer(e) {
  if (P.on) { presentPointerUp(e); return; }
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (G && G.type === 'pinch') { if (pointers.size === 0) G = null; return; }
  if (!G) return;
  const g = G; G = null;
  if (g.lp) clearTimeout(g.lp);
  switch (g.type) {
    case 'draw': if (g.draft.points.length) finishStroke(g.draft); break;
    case 'shape': {
      const d = g.draft;
      if (CONN_TYPES.includes(d.type)) { const b = attachAt({ x: d.x2, y: d.y2 }); if (b && b.id !== d.from) d.to = b.id; }
      if (Math.hypot(d.x2 - g.p0.x, d.y2 - g.p0.y) > 4 / S.view.scale) { commit(() => S.board.items.push(d)); }
      requestRender(); break;
    }
    case 'erase': if (g.removed) { pushUndo(g.snap); save(); } break;
    case 'marquee': {
      const x1 = Math.min(g.p0.x, g.cur.x), y1 = Math.min(g.p0.y, g.cur.y), x2 = Math.max(g.p0.x, g.cur.x), y2 = Math.max(g.p0.y, g.cur.y);
      if (x2 - x1 > 3 / S.view.scale || y2 - y1 > 3 / S.view.scale) {
        const hid = R.hiddenIds(S.board.items);
        const hits = S.board.items.filter((it) => { if (isLocked(it) || hid.has(it.id)) return false; const b = R.bounds(it); return b.x < x2 && b.x + b.w > x1 && b.y < y2 && b.y + b.h > y1; }).map((i) => i.id);
        setSel([...g.base, ...hits]);
      }
      requestRender(); break;
    }
    case 'move': case 'resize': {
      if (g.type === 'move' && !g.moved) {
        if (g.removeOnTap) { setSel(S.sel.filter((id) => !g.removeOnTap.includes(id))); break; }
        const it = byId(g.tapId); const now = Date.now();
        const tr = it && it.type === 'frame' ? R.frameToggleRect(it) : null;
        const ci = it && it.type === 'note' && !S.multiMode && !isLocked(it) ? R.noteCheckAt(it, g.w0.x, g.w0.y) : -1;
        if (tr && g.w0.x >= tr.x && g.w0.y <= tr.y + tr.h) { toggleCollapse(it); break; }
        if (ci >= 0) { commit(() => { it.text = R.toggleCheck(it.text, ci); }); lastTap = { id: null, t: 0 }; showCtxBar(); break; }
        if (it && g.openLink && it.type === 'link') openLink(it);
        else if (it && lastTap.id === it.id && now - lastTap.t < 400 && !S.multiMode) {
          if (it.type === 'note' || it.type === 'text') startEdit(it, false);
          else if (it.type === 'link') openLink(it);
        }
        lastTap = { id: it && it.id, t: now };
      } else {
        if (g.type === 'move' && PREF.cols) snapNotesIntoColumns(g.ids);
        if (g.type === 'resize' && (g.k === 'p1' || g.k === 'p2')) { // drop a connector end on an item to attach it
          const it = byId(g.orig[0].id);
          if (it) { const k = g.k === 'p1' ? 'from' : 'to', other = g.k === 'p1' ? it.to : it.from; const t = attachAt(g.k === 'p1' ? { x: it.x1, y: it.y1 } : { x: it.x2, y: it.y2 }, it); if (t && t.id !== other) it[k] = t.id; }
        }
        if (snap() !== g.snap) { pushUndo(g.snap); save(); }
      }
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
  if (it.type === 'note' || it.type === 'text') startEdit(it, false); else if (it.type === 'link') openLink(it); else if (it.type === 'frame') renameFrame(it);
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

// ---------- handwriting: smoothing + shape recognition ----------
const SHAPE_NAMES = { rect: 'rectangle', ellipse: 'circle/ellipse', line: 'line', arrow: 'arrow' };
function finishStroke(d) {
  if (PREF.smooth && d.points.length >= 5) d.points = inkSmooth(d.points, S.view.scale);
  commit(() => S.board.items.push(d));
  if (!PREF.shapes || d.tool !== 'pen') return;
  const r = recognize(d.points, 50 / S.view.scale); if (!r) return;
  const sh = { id: uid('i-'), type: r.type, x1: r1(snapV(r.x1)), y1: r1(snapV(r.y1)), x2: r1(snapV(r.x2)), y2: r1(snapV(r.y2)), color: d.color, size: Math.max(2, d.size) };
  commit(() => { const i = S.board.items.indexOf(d); if (i >= 0) S.board.items[i] = sh; }); // separate step: Undo brings the hand-drawn stroke back
  toast(`Recognised a ${SHAPE_NAMES[r.type]} – Undo keeps your drawing.`, { ms: 2500 });
}
function penMenu(anchor) {
  const item = (label, fn) => h('button', { class: 'menu-item', onclick: () => { closePopover(); fn(); } }, label);
  popover(anchor, h('div', { class: 'menu' }, h('div', { class: 'pop-title' }, 'Pen'),
    item(`Smooth handwriting: ${PREF.smooth ? 'on' : 'off'}`, () => { setPref('smooth', !PREF.smooth, 'wb-smooth'); toast(`Smooth handwriting ${PREF.smooth ? 'on' : 'off'}.`, { ms: 1500 }); }),
    item(`Shape recognition: ${PREF.shapes ? 'on' : 'off'}`, () => { setPref('shapes', !PREF.shapes, 'wb-shapes'); toast(PREF.shapes ? 'Shape recognition on: rough boxes, circles, lines and arrows become clean shapes.' : 'Shape recognition off.', { ms: 2500 }); }),
    h('p', { class: 'muted small', style: 'margin:4px 12px;max-width:250px' }, 'Shape recognition: draw a box, circle, straight line or arrow in one stroke. Undo right after keeps the hand-drawn version.')));
}

// ---------- copy / paste across boards ----------
const CLIP_KEY = 'wb-clip';
function readClip() { try { const c = JSON.parse(localStorage.getItem(CLIP_KEY) || 'null'); return c && Array.isArray(c.items) && c.items.length ? c : null; } catch { return null; } }
function clipSig(items) {
  const t = items.map((i) => (i.type === 'note' || i.type === 'text' ? i.text : i.type === 'link' ? i.url : i.type === 'frame' ? i.title : '')).filter((x) => x && x.trim()).join('\n\n');
  return t || `[My Whiteboard: ${items.length} item${items.length === 1 ? '' : 's'}]`;
}
// Selected items plus everything inside selected frames.
function selWithContents() {
  const items = selItems(), ids = new Set(items.map((i) => i.id));
  for (const f of items.filter((i) => i.type === 'frame')) for (const c of R.frameContents(S.board.items, f)) ids.add(c.id);
  return S.board.items.filter((i) => ids.has(i.id));
}
// Fresh copies with new ids; groups and connectors are re-wired among the copies; copies are unlocked.
function cloneItems(items, dx, dy) {
  const idmap = new Map(items.map((i) => [i.id, uid('i-')])), gmap = new Map();
  return items.map((it) => {
    const c = JSON.parse(JSON.stringify(it)); c.id = idmap.get(it.id); delete c.locked;
    for (const k of ['from', 'to']) if (c[k]) { if (idmap.has(c[k])) c[k] = idmap.get(c[k]); else delete c[k]; }
    if (c.groupId) { if (!gmap.has(c.groupId)) gmap.set(c.groupId, uid('g-')); c.groupId = gmap.get(c.groupId); }
    R.moveItem(c, dx, dy); return c;
  });
}
async function copySelected(cut = false) {
  const items = selWithContents(); if (!items.length) return;
  const sig = clipSig(items);
  localStorage.setItem(CLIP_KEY, JSON.stringify({ items, sig, from: S.board.name, at: Date.now() }));
  try { await navigator.clipboard.writeText(sig); } catch { /* clipboard permission not granted: the in-app clipboard still works */ }
  if (cut) { const del = new Set(items.filter((i) => !isLocked(i)).map((i) => i.id)); commit(() => { S.board.items = S.board.items.filter((i) => !del.has(i.id)); }); setSel([]); }
  toast(`${cut ? 'Cut' : 'Copied'} ${items.length} item${items.length === 1 ? '' : 's'} – paste on any board with Ctrl+V or + › Paste.`, { ms: 2500 });
}
function pasteClip(at) {
  const c = readClip(); if (!c) { toast('Nothing copied yet: select items › Copy.'); return false; }
  const b = R.boardBounds(c.items), ctr = at || viewCenter();
  const copies = cloneItems(c.items, snapV(ctr.x - (b.x + b.w / 2)), snapV(ctr.y - (b.y + b.h / 2)));
  commit(() => S.board.items.push(...copies)); setTool('select'); setSel(copies.map((i) => i.id)); return true;
}
// + › Paste (phone friendly): a copied picture from the system clipboard first, then copied board items, then text/links.
async function pasteFromMenu() {
  const c = readClip();
  try {
    if (navigator.clipboard && navigator.clipboard.read) {
      for (const ci of await navigator.clipboard.read()) {
        const type = ci.types.find((t) => t.startsWith('image/'));
        if (type) { const blob = await ci.getType(type); await insertImageFile(new File([blob], 'pasted.' + type.split('/')[1], { type })); return; }
      }
    }
  } catch { /* no permission / not supported */ }
  let t = '';
  try { t = ((await navigator.clipboard.readText()) || '').trim(); } catch { /* ignore */ }
  if (c && (!t || t === c.sig.trim())) return pasteClip();
  if (t) return pasteText(t);
  if (c) return pasteClip();
  toast('Clipboard is empty (or the browser blocked access). Copy something first.');
}
function pasteText(t) {
  if (/^https?:\/\/\S+$/i.test(t)) { if (/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(t)) addImageFromUrl(t); else addLink(t); }
  else { const c = viewCenter(); const it = { id: uid('i-'), type: 'note', x: c.x - 100, y: c.y - 80, w: 220, h: 170, text: t, color: S.noteColor, fontSize: 20 }; commit(() => S.board.items.push(it)); setTool('select'); setSel([it.id]); }
}
async function copyToBoardDialog() {
  const items = selWithContents(); if (!items.length) return;
  await refreshPending();
  const others = S.boards.filter((b) => b.id !== S.board.id);
  if (!others.length) return toast('Create another board first (☰ › + New board).');
  const list = h('div', { class: 'results' }, ...others.map((b) => h('button', { class: 'result', 'data-board': b.id, onclick: async () => { closeModal(null); await copyItemsToBoard(items, b); } }, h('strong', {}, b.name), h('small', {}, `${b.items.length} items`))));
  openModal('Copy to another board', h('div', { class: 'stack' }, h('p', { class: 'muted small' }, `${items.length} item${items.length === 1 ? '' : 's'} will be copied below that board's content. This board is not changed.`), list), { wide: true });
}
async function copyItemsToBoard(items, target) {
  await saveChain;
  await db.update('boards', target.id, (cur) => {
    if (!cur) return undefined;
    const tb = cur.items.length ? R.boardBounds(cur.items) : { x: 0, y: -80, w: 0, h: 0 }, b = R.boardBounds(items);
    cur.items.push(...cloneItems(items, Math.round(tb.x - b.x), Math.round(tb.y + tb.h + 80 - b.y)));
    cur.updatedAt = Date.now(); cur.dirty = true; return cur;
  });
  await refreshPending(); renderDrawer(); sync && sync.schedule();
  toast(`Copied ${items.length} item${items.length === 1 ? '' : 's'} to “${target.name}”.`, { ms: 5000, action: 'Open', onAction: () => openBoard(target.id) });
}

// ---------- phone: camera + dictated sticky note ----------
function dictateNote() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const ta = h('textarea', { class: 'dict-text', rows: 4, placeholder: SR ? 'Listening… speak now' : 'Tap the microphone on your keyboard and speak, or type.' });
  const status = h('p', { class: 'muted small dict-status' }, SR ? '🎤 Listening… (needs an internet connection on most phones)' : 'Voice typing is not built into this browser – use the microphone key on your phone keyboard.');
  let rec = null, base = '';
  const stop = () => { if (rec) { try { rec.stop(); } catch { /* already stopped */ } } };
  const start = () => {
    if (!SR) return;
    try {
      rec = new SR(); rec.lang = navigator.language || 'en-GB'; rec.interimResults = true; rec.continuous = true;
      base = ta.value ? ta.value.replace(/\s*$/, ' ') : '';
      rec.onresult = (e) => { let t = ''; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; ta.value = base + t; };
      rec.onerror = (e) => { status.textContent = e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'Microphone blocked – allow it in the browser, or type / use the keyboard microphone.' : e.error === 'network' ? 'Voice typing needs a connection – type or use the keyboard microphone instead.' : `Voice input stopped (${e.error}). You can type instead.`; };
      rec.onend = () => { if (!/blocked|needs|stopped/.test(status.textContent)) status.textContent = 'Stopped. Edit the text if needed, then Create note.'; micBtn.textContent = '🎤 Listen again'; };
      rec.start(); status.textContent = '🎤 Listening…'; micBtn.textContent = '■ Stop';
    } catch (e) { status.textContent = 'Voice input unavailable: ' + e.message; }
  };
  const micBtn = h('button', { class: 'btn', type: 'button', onclick: () => { if (micBtn.textContent.startsWith('■')) stop(); else start(); } }, '■ Stop');
  const create = h('button', { class: 'btn primary dict-create', type: 'button', onclick: () => {
    stop(); const t = ta.value.trim(); closeModal(null); if (!t) return;
    const c = viewCenter(); const it = { id: uid('i-'), type: 'note', x: snapV(c.x - 110), y: snapV(c.y - 85), w: 220, h: 170, text: t, color: S.noteColor, fontSize: 20 };
    commit(() => S.board.items.push(it)); setTool('select'); setSel([it.id]);
  } }, 'Create note');
  openModal('Dictate a sticky note', h('div', { class: 'stack' }, ta, status, h('div', { class: 'row end' }, SR ? micBtn : null, create))).then(stop);
  if (SR) start(); else setTimeout(() => ta.focus(), 50);
}

// ---------- move helpers: frames carry their contents, connectors detach, Kanban column snapping ----------
function prepMove(g) {
  const ids = new Set(g.ids);
  for (const id of [...ids]) { const f = byId(id); if (f && f.type === 'frame') for (const c of R.frameContents(S.board.items, f)) if (!isLocked(c)) ids.add(c.id); }
  for (const id of ids) { // a connector dragged on its own lets go of items that stay behind
    const c = byId(id); if (!c || !CONN_TYPES.includes(c.type)) continue;
    if (c.from && !ids.has(c.from)) delete c.from;
    if (c.to && !ids.has(c.to)) delete c.to;
  }
  g.ids = [...ids]; g.ob = R.boardBounds(g.ids.map(byId).filter(Boolean)); g.applied = { x: 0, y: 0 };
}
// Dropping sticky notes onto a column (rectangle or frame) centres them in it and stacks them below the header without overlapping.
function snapNotesIntoColumns(ids) {
  const moving = new Set(ids), items = ids.map(byId).filter(Boolean);
  if (items.some((i) => i.type !== 'note' || i.groupId)) return;
  const hid = R.hiddenIds(S.board.items);
  const conts = S.board.items.filter((c) => (c.type === 'rect' || c.type === 'frame') && !moving.has(c.id) && !hid.has(c.id) && !c.collapsed);
  const placed = [];
  for (const n of items) {
    const nc = { x: n.x + n.w / 2, y: n.y + n.h / 2 };
    // a "column" = a tall, narrow rectangle or frame (e.g. Kanban columns); big areas are left alone
    const cand = conts.map((c) => [c, R.bounds(c)]).filter(([, b]) => b.w >= n.w + 16 && b.w <= n.w * 2.5 && b.h >= b.w * 1.3 && nc.x >= b.x && nc.x <= b.x + b.w && nc.y >= b.y && nc.y <= b.y + b.h)
      .sort((a, b) => a[1].w * a[1].h - b[1].w * b[1].h)[0];
    if (!cand) continue;
    const [c, b] = cand, top = b.y + (c.type === 'frame' ? R.FRAME_HEAD + 12 : 60);
    n.x = Math.round(b.x + (b.w - n.w) / 2);
    let y = Math.max(top, Math.min(n.y, b.y + b.h - n.h - 10));
    const others = S.board.items.filter((o) => o.type === 'note' && o !== n && (!moving.has(o.id) || placed.includes(o)) && !hid.has(o.id) && Math.abs(o.x + o.w / 2 - (n.x + n.w / 2)) < n.w * 0.75);
    for (let k = 0; k < 60; k++) { const o = others.find((x) => y < x.y + x.h + 10 && y + n.h + 10 > x.y); if (!o) break; y = o.y + o.h + 12; }
    n.y = Math.round(y); placed.push(n);
  }
}

// ---------- frames / sections ----------
const frames = () => S.board.items.filter((i) => i.type === 'frame');
// Presentation / list order: top-to-bottom rows, then left-to-right.
function framesSorted() {
  const fs = frames().slice().sort((a, b) => a.y - b.y); const rows = [];
  for (const f of fs) { const r = rows.find((row) => Math.abs(row[0].y - f.y) < 150); if (r) r.push(f); else rows.push([f]); }
  return rows.flatMap((r) => r.sort((a, b) => a.x - b.x));
}
function newFrame(b, title) {
  return { id: uid('i-'), type: 'frame', x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h), title: title || `Frame ${frames().length + 1}`, color: R.FRAME_COLORS[frames().length % R.FRAME_COLORS.length] };
}
function insertFrame() {
  const c = viewCenter(), w = Math.min(800, Math.max(320, (W * 0.8) / S.view.scale)), hh = Math.min(560, Math.max(240, (H * 0.5) / S.view.scale));
  const f = newFrame({ x: snapV(c.x - w / 2), y: snapV(c.y - hh / 2), w, h: hh });
  commit(() => S.board.items.unshift(f)); setTool('select'); setSel([f.id]);
}
function frameAroundSelected() {
  const items = selItems(); if (!items.length) return;
  const b = R.boardBounds(items), pad = 40;
  const f = newFrame({ x: b.x - pad, y: b.y - pad - R.FRAME_HEAD, w: b.w + pad * 2, h: b.h + pad * 2 + R.FRAME_HEAD });
  commit(() => S.board.items.unshift(f)); setSel([f.id]);
}
async function renameFrame(f) {
  const v = await ask('Frame title', [{ name: 'title', label: 'Title', value: f.title || '', required: true }], { ok: 'Save' });
  if (v && v.title.trim()) commit(() => { f.title = v.title.trim(); });
  showCtxBar();
}
function toggleCollapse(f) {
  commit(() => { if (f.collapsed) delete f.collapsed; else f.collapsed = true; });
  S.sel = S.sel.filter((id) => !R.hiddenIds(S.board.items).has(id)); showCtxBar();
}
function fitRect(b, padTop = 70, padBottom = 40) {
  const s = Math.min(4, Math.max(0.1, Math.min((W - 40) / Math.max(b.w, 1), (H - padTop - padBottom) / Math.max(b.h, 1))));
  S.view = { scale: s, x: W / 2 - (b.x + b.w / 2) * s, y: padTop + (H - padTop - padBottom) / 2 - (b.y + b.h / 2) * s }; saveViewSoon(); requestRender();
}
function goToFrame(f) { fitRect({ x: f.x, y: f.y, w: f.w, h: f.collapsed ? R.FRAME_HEAD : f.h }, 80, 150); }
function framesMenu(anchor) {
  const fs = framesSorted();
  const item = (label, fn) => h('button', { class: 'menu-item', onclick: () => { closePopover(); fn(); } }, label);
  popover(anchor, h('div', { class: 'menu' }, h('div', { class: 'pop-title' }, 'Frames'),
    ...(fs.length ? fs.map((f, i) => item(`${i + 1}. ${f.title || 'Frame'}${f.collapsed ? ' (collapsed)' : ''}`, () => goToFrame(f))) : [h('p', { class: 'muted small', style: 'padding:0 12px' }, 'No frames yet: + › Frame / section, or select items › Frame.')]),
    fs.length ? item('▶ Present from the start', () => startPresent(0)) : null), { place: 'below' });
}

// ---------- present mode: step through frames like slides ----------
const P = { on: false, i: 0, list: [], saved: null, down: null };
function startPresent(i = 0) {
  const list = framesSorted();
  if (!list.length) return toast('Add a frame first: + › Frame / section (or select items › Frame).');
  finishEdit(); closePopover(); setSel([]);
  Object.assign(P, { on: true, list, saved: { ...S.view } });
  document.body.classList.add('presenting'); $('#presentBar').hidden = false; $('#minimap').hidden = true;
  goSlide(i);
}
function goSlide(i) {
  if (!P.on) return;
  P.list = P.list.filter((f) => byId(f.id));
  if (!P.list.length) return stopPresent();
  P.i = Math.max(0, Math.min(P.list.length - 1, i));
  const f = P.list[P.i];
  fitRect({ x: f.x, y: f.y, w: f.w, h: f.h }, 16, 76);
  $('#presLabel').textContent = `${P.i + 1} / ${P.list.length} · ${f.title || 'Frame'}`;
  $('#presPrev').disabled = P.i === 0; $('#presNext').disabled = P.i === P.list.length - 1;
}
function stopPresent() {
  if (!P.on) return;
  P.on = false; document.body.classList.remove('presenting'); $('#presentBar').hidden = true;
  if (P.saved) S.view = P.saved; $('#minimap').hidden = !PREF.map; requestRender();
}
function presentPointerUp(e) {
  if (!P.down) return; const p = pt(e), dx = p.x - P.down.x, dy = p.y - P.down.y; P.down = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) goSlide(P.i + (dx < 0 ? 1 : -1)); // swipe
  else if (Math.hypot(dx, dy) < 10) goSlide(P.i + (p.x > W / 3 ? 1 : -1)); // tap right = next, left third = back
}

// ---------- mini-map ----------
let mapX = null;
function drawMinimap() {
  const c = $('#miniCanvas'); if (!c || $('#minimap').hidden) return;
  const cw = c.clientWidth, ch = c.clientHeight; if (!cw) return;
  if (c.width !== Math.round(cw * DPR)) { c.width = Math.round(cw * DPR); c.height = Math.round(ch * DPR); }
  const m = c.getContext('2d'); m.setTransform(DPR, 0, 0, DPR, 0, 0);
  const vb = { x: -S.view.x / S.view.scale, y: -S.view.y / S.view.scale, w: W / S.view.scale, h: H / S.view.scale };
  const bb = S.board.items.length ? R.boardBounds(S.board.items) : vb;
  const x1 = Math.min(bb.x, vb.x), y1 = Math.min(bb.y, vb.y), x2 = Math.max(bb.x + bb.w, vb.x + vb.w), y2 = Math.max(bb.y + bb.h, vb.y + vb.h);
  const s = Math.min((cw - 8) / (x2 - x1), (ch - 8) / (y2 - y1));
  const view = { scale: s, x: (cw - (x2 - x1) * s) / 2 - x1 * s, y: (ch - (y2 - y1) * s) / 2 - y1 * s };
  mapX = view;
  R.drawBoard(m, { ...S.board, background: 'solid' }, view, cw, ch, { ...env(), editingId: null });
  m.strokeStyle = '#2563eb'; m.lineWidth = 2; m.fillStyle = 'rgba(37,99,235,0.10)';
  m.fillRect(view.x + vb.x * s, view.y + vb.y * s, vb.w * s, vb.h * s); m.strokeRect(view.x + vb.x * s, view.y + vb.y * s, vb.w * s, vb.h * s);
}
function setMinimap(on) { PREF.map = on; localStorage.setItem('wb-minimap', on ? '1' : '0'); $('#minimap').hidden = !on; $('#btnMap').classList.toggle('active', on); requestRender(); }
function initMinimap() {
  const c = $('#miniCanvas'); let drag = false;
  const go = (e) => { if (!mapX) return; const r = c.getBoundingClientRect(); const wx = (e.clientX - r.left - mapX.x) / mapX.scale, wy = (e.clientY - r.top - mapX.y) / mapX.scale; S.view.x = W / 2 - wx * S.view.scale; S.view.y = H / 2 - wy * S.view.scale; saveViewSoon(); requestRender(); };
  c.addEventListener('pointerdown', (e) => { e.preventDefault(); drag = true; c.setPointerCapture(e.pointerId); go(e); });
  c.addEventListener('pointermove', (e) => { if (drag) go(e); });
  c.addEventListener('pointerup', () => { drag = false; }); c.addEventListener('pointercancel', () => { drag = false; });
  $('#btnMap').onclick = () => setMinimap(!PREF.map);
  $('#btnFrames').onclick = (e) => framesMenu(e.currentTarget);
  setMinimap(PREF.map);
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
      if (t === 'pen' && S.tool === 'pen') return penMenu(b);
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
    readClip() ? item('copy', `Paste (${readClip().items.length} copied item${readClip().items.length === 1 ? '' : 's'})`, () => pasteClip()) : null,
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
  popover(anchor, h('div', {}, h('div', { class: 'pop-title' }, 'New note colour'), wrap, h('button', { class: 'menu-item', onclick: () => { closePopover(); dictateNote(); } }, '🎤 Dictate a note')));
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
    item('image', 'Take a photo', () => $('#fileCamera').click()),
    item('image', 'Upload picture (saved to Drive)', () => $('#fileImage').click()),
    item('copy', 'Paste (copied items, picture or text)', pasteFromMenu),
    item('note', '🎤 Dictate a sticky note', dictateNote),
    item('link', 'Picture from URL', insertImageUrl),
    item('open', 'Link a document or web page', insertLinkDialog),
    item('frame', 'Frame / section', insertFrame),
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
  if (items.every(isLocked)) {
    const bgOnly = items.every((i) => !i.locked);
    bar.append(h('span', { class: 'ctx-label', html: `${ICONS.lock}<span>${bgOnly ? 'Background locked' : 'Locked'}${items.length > 1 ? ` (${items.length})` : ''}</span>` }));
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
  if (notes.length) btn('tag', 'Tags, due date & checklist', (e) => noteDetailsMenu(e.currentTarget));
  if (one && one.type === 'frame') {
    bar.append(h('button', { class: 'chip sm', 'data-act': 'framecolor', style: `background:${one.color || R.FRAME_COLORS[0]}`, 'aria-label': 'Frame colour', title: 'Frame colour', onclick: (e) => {
      const row = h('div', { class: 'pop-row wrap' }, ...R.FRAME_COLORS.map((c) => h('button', { class: 'chip', style: `background:${c}`, 'aria-label': 'Frame colour ' + c, onclick: () => { commit(() => { one.color = c; }); closePopover(); showCtxBar(); } })));
      popover(e.currentTarget, row, { place: 'below' });
    } }));
    btn('edit', 'Rename frame', () => renameFrame(one));
    btn(one.collapsed ? 'expand' : 'collapse', one.collapsed ? 'Expand frame' : 'Collapse frame', () => toggleCollapse(one));
    btn('present', 'Present from this frame', () => startPresent(framesSorted().indexOf(one)));
  }
  const us = units(items.filter((i) => !isLocked(i)));
  btn('multi', S.multiMode ? 'Finish selecting' : 'Select more (tap items to add)', () => setMultiMode(!S.multiMode));
  if (us.length === 2 && us.every((u) => u.some((i) => !CONN_TYPES.includes(i.type)))) btn('connect', 'Connect with an arrow', connectSelected);
  if (us.length >= 2) btn('align', 'Align & distribute', (e) => alignMenu(e.currentTarget));
  if (!items.some((i) => i.type === 'frame')) btn('frame', 'Put in a frame', frameAroundSelected);
  if (items.length > 1 && !isGroupSel()) btn('group', 'Group', groupSelected);
  if (items.some((i) => i.groupId)) btn('ungroup', 'Ungroup', ungroupSelected);
  btn('lock', 'Lock (stays put)', () => setLock(true));
  btn('copy', 'Duplicate', duplicateSelected);
  btn('clip', 'Copy, cut or send to another board', (e) => clipMenu(e.currentTarget));
  btn('layers', 'Layers: front / back / background', (e) => layersMenu(e.currentTarget));
  btn('trash', 'Delete', deleteSelected);
  bar.querySelector('[data-act=multi]').classList.toggle('active', S.multiMode);
  bar.hidden = false; positionCtxBar();
}
function positionCtxBar() {
  const bar = $('#ctxbar'); const items = selItems(); if (bar.hidden || !items.length) return;
  const b = R.boardBounds(items), p = toScreen({ x: b.x + b.w / 2, y: b.y });
  const bw = bar.offsetWidth;
  if (S.multiMode) { // docked above the toolbar so it never covers items you are tapping
    const tops = ['.toolbar', '.history', '.zoom'].map((q) => $(q)).map((e) => e && e.getBoundingClientRect()).filter((r) => r && r.height > 0).map((r) => r.top);
    const tb = { top: tops.length ? Math.min(...tops) : H };
    bar.style.left = Math.max(8, (W - bw) / 2) + 'px'; bar.style.top = Math.max(64, tb.top - bar.offsetHeight - 10) + 'px'; return;
  }
  const top = Math.max(64, p.y - bar.offsetHeight - 16);
  bar.style.left = Math.min(Math.max(8, p.x - bw / 2), W - bw - 8) + 'px'; bar.style.top = Math.min(top, H - 160) + 'px';
}
function clipMenu(anchor) {
  const n = selWithContents().filter((i) => !i.locked).length;
  popover(anchor, h('div', { class: 'menu', role: 'menu' },
    h('button', { class: 'menu-item', 'data-clip': 'copy', onclick: () => { closePopover(); copySelected(false); }, html: `${ICONS.clip}<span>Copy ${n} item${n === 1 ? '' : 's'} (paste on any board)</span>` }),
    h('button', { class: 'menu-item', 'data-clip': 'cut', onclick: () => { closePopover(); copySelected(true); }, html: `${ICONS.trash}<span>Cut</span>` }),
    h('button', { class: 'menu-item', 'data-clip': 'send', onclick: () => { closePopover(); copyToBoardDialog(); }, html: `${ICONS.send}<span>Copy to another board…</span>` })), { place: 'below' });
}
function deleteSelected() {
  const ids = new Set(selItems().filter((i) => !isLocked(i)).map((i) => i.id)); if (!ids.size) return;
  commit(() => { S.board.items = S.board.items.filter((i) => !ids.has(i.id)); }); setSel([]);
}
function duplicateSelected() {
  const copies = cloneItems(selWithContents(), 24, 24);
  commit(() => S.board.items.push(...copies)); setSel(copies.map((c) => c.id));
}
function reorder(toFront) {
  const ids = new Set(S.sel);
  commit(() => { const sel = S.board.items.filter((i) => ids.has(i.id)), rest = S.board.items.filter((i) => !ids.has(i.id)); S.board.items = toFront ? rest.concat(sel) : sel.concat(rest); });
}
function stepOrder(up) { // one step forward / backward
  const ids = new Set(S.sel);
  commit(() => {
    const a = S.board.items;
    if (up) { for (let i = a.length - 2; i >= 0; i--) if (ids.has(a[i].id) && !ids.has(a[i + 1].id)) [a[i], a[i + 1]] = [a[i + 1], a[i]]; }
    else { for (let i = 1; i < a.length; i++) if (ids.has(a[i].id) && !ids.has(a[i - 1].id)) [a[i], a[i - 1]] = [a[i - 1], a[i]]; }
  });
}
function setLayer(bg) {
  const items = selItems().filter((i) => !isLocked(i)); if (!items.length) return;
  commit(() => items.forEach((i) => { if (bg) i.layer = 'bg'; else delete i.layer; }));
  if (bg && S.board.bgLocked) { setSel([]); toast('Moved to the background layer (locked). ⋯ › Unlock background layer to edit it.', { ms: 3500 }); } else showCtxBar();
}
function setBgLocked(on) {
  commit(() => { if (on) S.board.bgLocked = true; else delete S.board.bgLocked; });
  setSel(S.sel.filter((id) => { const i = byId(id); return i && !isLocked(i); }));
  const n = S.board.items.filter((i) => i.layer === 'bg').length;
  toast(on ? `Background layer locked (${n} item${n === 1 ? '' : 's'}). Drag on it to pan; notes move over it.` : 'Background layer unlocked.', { ms: 3000 });
}
function layersMenu(anchor) {
  const items = selItems(); const inBg = items.every((i) => i.layer === 'bg');
  const item = (act, label, fn) => h('button', { class: 'menu-item', 'data-layer': act, onclick: () => { closePopover(); fn(); } }, label);
  popover(anchor, h('div', { class: 'menu' },
    item('front', '⤒  Bring to front', () => reorder(true)),
    item('forward', '↑  Bring forward', () => stepOrder(true)),
    item('backward', '↓  Send backward', () => stepOrder(false)),
    item('back', '⤓  Send to back', () => reorder(false)),
    h('div', { class: 'pop-title' }, 'Layer'),
    inBg ? item('main', 'Move to main layer', () => setLayer(false)) : item('bg', 'Move to background layer', () => setLayer(true)),
    item('bglock', S.board.bgLocked ? 'Unlock background layer' : 'Lock background layer', () => setBgLocked(!S.board.bgLocked))), { place: 'below' });
}
// Units = groups (moved as one) or single items.
function units(items) {
  const m = new Map(); for (const i of items) { const k = i.groupId || i.id; if (!m.has(k)) m.set(k, []); m.get(k).push(i); }
  return [...m.values()];
}
function alignSelected(mode) {
  const us = units(selItems().filter((i) => !isLocked(i))); if (us.length < 2) return;
  const ub = us.map((u) => ({ u, b: R.boardBounds(u) })), all = R.boardBounds(us.flat());
  const mv = (u, dx, dy) => { if (dx || dy) u.forEach((i) => R.moveItem(i, dx, dy)); };
  commit(() => {
    if (mode === 'dist-h' || mode === 'dist-v') {
      if (ub.length < 3) return;
      const H_ = mode === 'dist-h', key = H_ ? 'x' : 'y', size = H_ ? 'w' : 'h';
      ub.sort((a, b) => a.b[key] - b.b[key]);
      const total = ub.reduce((t, x) => t + x.b[size], 0), gap = (all[size] - total) / (ub.length - 1);
      let pos = all[key];
      for (const x of ub) { const d = Math.round(pos - x.b[key]); mv(x.u, H_ ? d : 0, H_ ? 0 : d); pos += x.b[size] + gap; }
      return;
    }
    for (const { u, b } of ub) {
      const dx = mode === 'left' ? all.x - b.x : mode === 'center' ? all.x + all.w / 2 - (b.x + b.w / 2) : mode === 'right' ? all.x + all.w - (b.x + b.w) : 0;
      const dy = mode === 'top' ? all.y - b.y : mode === 'middle' ? all.y + all.h / 2 - (b.y + b.h / 2) : mode === 'bottom' ? all.y + all.h - (b.y + b.h) : 0;
      mv(u, Math.round(dx), Math.round(dy));
    }
  });
}
function alignMenu(anchor) {
  const n = units(selItems().filter((i) => !isLocked(i))).length;
  const b = (mode, label, title) => h('button', { class: 'btn sm al-btn', 'data-align': mode, title, 'aria-label': title, onclick: () => { alignSelected(mode); } }, label);
  popover(anchor, h('div', { class: 'fmt-menu' },
    h('div', { class: 'pop-title' }, 'Align'),
    h('div', { class: 'pop-row' }, b('left', '⇤', 'Align left'), b('center', '↔', 'Align centres (horizontal)'), b('right', '⇥', 'Align right')),
    h('div', { class: 'pop-row' }, b('top', '⤒', 'Align top'), b('middle', '↕', 'Align middles (vertical)'), b('bottom', '⤓', 'Align bottom')),
    n >= 3 ? h('div', { class: 'pop-title' }, 'Distribute evenly') : null,
    n >= 3 ? h('div', { class: 'pop-row' }, b('dist-h', '⇹ Across', 'Distribute horizontally'), b('dist-v', '⇳ Down', 'Distribute vertically')) : null), { place: 'below' });
}
function connectSelected() {
  const us = units(selItems().filter((i) => !isLocked(i))); if (us.length !== 2) return;
  const pick = (u) => u.find((i) => i.type === 'note') || u.find((i) => !CONN_TYPES.includes(i.type) && i.type !== 'stroke') || u[0];
  const [a, b] = us.map(pick), ca = R.bounds(a), cb = R.bounds(b);
  const ar = { id: uid('i-'), type: 'arrow', x1: ca.x + ca.w / 2, y1: ca.y + ca.h / 2, x2: cb.x + cb.w / 2, y2: cb.y + cb.h / 2, color: S.color, size: 3, from: a.id, to: b.id };
  commit(() => { S.board.items.push(ar); R.updateConnectors(S.board.items); }); setMultiMode(false); setSel([ar.id]);
}
function noteDetailsMenu(anchor) {
  const notes = selItems().filter((i) => i.type === 'note' && !isLocked(i)); if (!notes.length) return;
  const first = notes[0];
  const tags = h('input', { type: 'text', class: 'nd-tags', value: (first.tags || []).join(', '), placeholder: 'e.g. urgent, client', 'aria-label': 'Tags (comma separated)' });
  const due = h('input', { type: 'date', class: 'nd-due', value: first.due || '', 'aria-label': 'Due date' });
  const apply = () => {
    const t = [...new Set(tags.value.split(',').map((x) => x.trim().replace(/^#/, '')).filter(Boolean))].slice(0, 8);
    commit(() => notes.forEach((n) => { if (t.length) n.tags = t; else delete n.tags; if (due.value) n.due = due.value; else delete n.due; }));
    closePopover(); showCtxBar();
  };
  const addCheck = () => {
    closePopover(); if (notes.length !== 1) return;
    const n = notes[0];
    commit(() => { n.text = (n.text && n.text.trim() ? n.text.replace(/\s+$/, '') + '\n' : '') + '[ ] '; });
    startEdit(n, false);
  };
  const quick = (label, days) => h('button', { class: 'btn sm', onclick: () => { const d = new Date(); d.setDate(d.getDate() + days); due.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; } }, label);
  popover(anchor, h('div', { class: 'fmt-menu nd-menu' },
    h('div', { class: 'pop-title' }, 'Tags (comma separated)'), h('div', { class: 'pop-row' }, tags),
    h('div', { class: 'pop-title' }, 'Due date'), h('div', { class: 'pop-row' }, due), h('div', { class: 'pop-row' }, quick('Today', 0), quick('Tomorrow', 1), quick('+1 week', 7), h('button', { class: 'btn sm', onclick: () => { due.value = ''; } }, 'None')),
    h('div', { class: 'pop-row' }, h('button', { class: 'btn sm primary nd-save', onclick: apply }, 'Save'), notes.length === 1 ? h('button', { class: 'btn sm nd-check', onclick: addCheck }, '☑ Add checklist item') : null),
    h('p', { class: 'muted small', style: 'margin:4px 8px;max-width:260px' }, 'Checklist: start a line with [ ] in the note; tap the box to tick it.')), { place: 'below' });
}
function setLock(on) {
  const items = selItems(); if (!items.length) return;
  commit(() => { items.forEach((i) => { if (on) i.locked = true; else delete i.locked; }); if (!on && items.some((i) => i.layer === 'bg')) delete S.board.bgLocked; });
  if (on) { setSel([]); toast(`Locked ${items.length > 1 ? items.length + ' items' : ''} – it stays put. To unlock: long-press it, or ⋯ › Unlock all.`, { ms: 3500 }); }
  else showCtxBar();
}
function unlockAll() {
  const locked = S.board.items.filter(isLocked);
  if (!locked.length) return toast('Nothing is locked on this board.');
  commit(() => { locked.forEach((i) => { delete i.locked; }); delete S.board.bgLocked; });
  setTool('select'); setSel(locked.map((i) => i.id));
  toast(`Unlocked ${locked.length} item(s).`, { ms: 2500 });
}
function groupSelected() {
  const items = selItems(); if (items.length < 2) return;
  const gid = uid('g-'); commit(() => items.forEach((i) => { i.groupId = gid; })); showCtxBar();
}
function ungroupSelected() { commit(() => selItems().forEach((i) => { delete i.groupId; })); showCtxBar(); }
function selectAll() { setTool('select'); const hid = R.hiddenIds(S.board.items); setSel(S.board.items.filter((i) => !isLocked(i) && !hid.has(i.id)).map((i) => i.id)); }
function setMultiMode(on) { S.multiMode = on; showCtxBar(); updateMultiBanner(); }
function updateMultiBanner() {
  const b = $('#multiBanner'); if (!b) return;
  b.hidden = !S.multiMode;
  if (S.multiMode) $('#multiCount').textContent = S.sel.length ? `${S.sel.length} selected` : 'Tap items to select · drag to box-select';
}
function formatMenu(anchor) {
  const texts = selItems().filter((i) => (i.type === 'note' || i.type === 'text') && !isLocked(i)); if (!texts.length) return;
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
const drawerFilter = { q: '', tag: '' };
function renderDrawer() {
  const list = $('#boardList'); if (!list) return;
  list.innerHTML = '';
  const boards = S.boards.map((b) => (S.board && b.id === S.board.id ? { ...b, items: S.board.items, name: S.board.name, pinned: S.board.pinned, tags: S.board.tags } : b));
  const allTags = [...new Set(boards.flatMap((b) => b.tags || []))].sort((a, b) => a.localeCompare(b));
  const chips = $('#boardTags'); chips.innerHTML = '';
  const chip = (val, label) => chips.append(h('button', { class: 'tag-chip' + (drawerFilter.tag === val ? ' active' : ''), 'data-tag': val, onclick: () => { drawerFilter.tag = drawerFilter.tag === val ? '' : val; renderDrawer(); } }, label));
  if (boards.some((b) => b.pinned) || allTags.length) { chip('', 'All'); chip('★', '★ Pinned'); allTags.forEach((t) => chip(t, '#' + t)); }
  const q = drawerFilter.q.trim().toLowerCase();
  const shown = boards.filter((b) => (!q || b.name.toLowerCase().includes(q) || (b.tags || []).some((t) => t.toLowerCase().includes(q)))
    && (!drawerFilter.tag || (drawerFilter.tag === '★' ? b.pinned : (b.tags || []).includes(drawerFilter.tag))));
  const pinned = shown.filter((b) => b.pinned), rest = shown.filter((b) => !b.pinned);
  const row = (b) => {
    const c = h('canvas', { class: 'board-thumb', width: 144, height: 96, 'aria-hidden': 'true' });
    const r = h('div', { class: 'board-row' + (S.board && b.id === S.board.id ? ' current' : ''), 'data-board': b.id },
      h('button', { class: 'board-open', onclick: () => { openBoard(b.id); toggleDrawer(false); } }, c,
        h('span', { class: 'board-info' }, h('strong', {}, b.name), h('small', {}, `${b.items.length} item${b.items.length === 1 ? '' : 's'} · ${fmtTime(b.updatedAt)}${b.dirty ? ' · not yet synced' : ''}`),
          (b.tags || []).length ? h('span', { class: 'board-tags' }, ...(b.tags || []).map((t) => h('span', { class: 'mini-tag' }, '#' + t))) : null)),
      h('button', { class: 'tool sm pin' + (b.pinned ? ' on' : ''), title: b.pinned ? 'Unpin' : 'Pin to top', 'aria-label': `${b.pinned ? 'Unpin' : 'Pin'} ${b.name}`, 'aria-pressed': String(!!b.pinned), onclick: () => setBoardMeta(b.id, { pinned: b.pinned ? undefined : true }) }, b.pinned ? '★' : '☆'),
      h('button', { class: 'tool sm', title: 'Board actions', 'aria-label': `Actions for ${b.name}`, html: ICONS.more, onclick: (e) => boardMenu(e.currentTarget, b) }));
    requestAnimationFrame(() => boardThumb(c, b));
    return r;
  };
  if (pinned.length) { list.append(h('div', { class: 'list-head' }, '★ Pinned')); pinned.forEach((b) => list.append(row(b))); if (rest.length) list.append(h('div', { class: 'list-head' }, 'Boards')); }
  rest.forEach((b) => list.append(row(b)));
  if (!shown.length) list.append(h('p', { class: 'muted small', style: 'padding:8px' }, 'No boards match.'));
}
function boardThumb(c, b) {
  const x = c.getContext('2d'), w = c.width, hh = c.height;
  const items = b.items || [];
  const bb = items.length ? R.boardBounds(items) : { x: -100, y: -60, w: 200, h: 120 };
  const s = Math.min((w - 8) / Math.max(bb.w, 1), (hh - 8) / Math.max(bb.h, 1), 1);
  x.setTransform(1, 0, 0, 1, 0, 0);
  R.drawBoard(x, { ...b, background: 'solid', items }, { x: w / 2 - (bb.x + bb.w / 2) * s, y: hh / 2 - (bb.y + bb.h / 2) * s, scale: s }, w, hh, { ...env(), editingId: null });
}
async function setBoardMeta(id, patch) {
  const applyP = (o) => { for (const [k, v] of Object.entries(patch)) { if (v === undefined || (Array.isArray(v) && !v.length)) delete o[k]; else o[k] = v; } };
  if (S.board && S.board.id === id) { applyP(S.board); await save(); }
  else { await db.update('boards', id, (cur) => { if (!cur) return undefined; applyP(cur); cur.updatedAt = Date.now(); cur.dirty = true; return cur; }); sync && sync.schedule(); }
  await refreshPending(); renderDrawer();
}
async function editBoardTags(b) {
  const v = await ask('Board tags', [{ name: 'tags', label: 'Tags, comma separated (e.g. work, personal, weekly)', value: (b.tags || []).join(', ') }], { ok: 'Save' });
  if (!v) return;
  const tags = [...new Set(v.tags.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean))].slice(0, 8);
  await setBoardMeta(b.id, { tags });
}
function boardMenu(anchor, b) {
  const item = (icon, label, fn) => h('button', { class: 'menu-item', onclick: () => { closePopover(); fn(); } }, h('span', { html: ICONS[icon] }), label);
  popover(anchor, h('div', { class: 'menu' },
    item('edit', 'Rename', () => renameBoard(b.id)),
    item('lock', b.pinned ? 'Unpin' : 'Pin to top', () => setBoardMeta(b.id, { pinned: b.pinned ? undefined : true })),
    item('tag', 'Tags…', () => editBoardTags(b)),
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
  const t = { id: existing ? existing.id : uid('tpl-'), name: v.name.trim(), background: b.background, ...(b.bgLocked ? { bgLocked: true } : {}), items: JSON.parse(JSON.stringify(b.items)), dirty: true, deleted: false, driveFileId: existing ? existing.driveFileId : null };
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
        const txt = it.type === 'note' ? [it.text, ...(it.tags || []).map((t) => '#' + t)].join(' ') : it.type === 'text' ? it.text : it.type === 'link' ? `${it.title} ${it.url}` : it.type === 'frame' ? it.title : '';
        if (txt && txt.toLowerCase().includes(q)) hits.push({ it, label: it.type === 'note' ? 'Sticky note' : it.type === 'text' ? 'Text' : it.type === 'frame' ? 'Frame' : 'Link', text: txt });
      }
      if (!hits.length) continue;
      const grp = h('div', { class: 'result-group' }, h('div', { class: 'result-board' }, `📋 ${b.name}`));
      for (const r of hits.slice(0, 20)) {
        const i = r.text.toLowerCase().indexOf(q), s = Math.max(0, i - 30);
        const snip = (s ? '…' : '') + esc(r.text.slice(s, i)) + '<mark>' + esc(r.text.slice(i, i + q.length)) + '</mark>' + esc(r.text.slice(i + q.length, i + q.length + 60));
        grp.append(h('button', { class: 'result', onclick: async () => {
          closeModal(null); if (!S.board || S.board.id !== b.id) await openBoard(b.id);
          if (r.it) { const live = S.board.items.find((x) => x.id === r.it.id); if (live) { setTool('select'); if (live.type === 'frame') { goToFrame(live); setSel([live.id]); } else { for (const f of frames()) if (f.collapsed && R.frameContents(S.board.items, f).includes(live)) commit(() => { delete f.collapsed; }); setSel([live.id]); centerOn(live); } } }
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
            commit(() => { S.board.items = data.items || []; S.board.background = data.background || 'grid'; if (data.bgLocked) S.board.bgLocked = true; else delete S.board.bgLocked; });
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
    await createBoard({ name: d.name || file.name.replace(/\.json$/, ''), background: d.background, bgLocked: d.bgLocked, items: d.items }, `${d.name || 'Imported board'}`);
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
    h('div', { class: 'pop-title' }, 'Arrange & present'),
    item('present', 'Present frames ▶', () => startPresent(0)),
    item('frame', 'Go to frame…', () => framesMenu(anchor)),
    item('map', `Mini-map: ${PREF.map ? 'on' : 'off'}`, () => setMinimap(!PREF.map)),
    item('grid', `Snap to grid: ${PREF.grid ? 'on' : 'off'}`, () => { PREF.grid = !PREF.grid; localStorage.setItem('wb-snap-grid', PREF.grid ? '1' : '0'); toast(`Snap to grid ${PREF.grid ? 'on' : 'off'}.`, { ms: 1500 }); }),
    item('note', `Snap notes into columns: ${PREF.cols ? 'on' : 'off'}`, () => { PREF.cols = !PREF.cols; localStorage.setItem('wb-snap-cols', PREF.cols ? '1' : '0'); toast(`Snap notes into columns ${PREF.cols ? 'on' : 'off'}.`, { ms: 1500 }); }),
    item('lock', S.board.bgLocked ? 'Unlock background layer' : 'Lock background layer', () => setBgLocked(!S.board.bgLocked)),
    item('pen', `Smooth handwriting: ${PREF.smooth ? 'on' : 'off'}`, () => setPref('smooth', !PREF.smooth, 'wb-smooth')),
    item('rect', `Shape recognition: ${PREF.shapes ? 'on' : 'off'}`, () => setPref('shapes', !PREF.shapes, 'wb-shapes')),
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
    h('p', { class: 'muted small' }, 'Tips: two fingers pan & zoom on touch. With the Select tool, drag empty space to pan; double-tap a note to edit it. Keyboard: V select, P pen, H highlighter, E eraser, S shapes, T text, N note, Ctrl+Z / Ctrl+Shift+Z, Delete removes the selection, Space+drag pans. Shift-click or Shift+drag (box) selects several; Ctrl+A all, Ctrl+G group, Ctrl+Shift+G ungroup, Ctrl+L lock/unlock, Ctrl+B bold, Ctrl+I italic. Long-press a locked item to select it, then Unlock. Paste a picture or link straight onto the board. Arrows drawn from one item to another stay attached. Ctrl+] / Ctrl+[ forward / backward (add Shift for front / back). Present mode: arrow keys or swipe, Esc to leave. Ctrl+C / Ctrl+X / Ctrl+V copy, cut and paste items between boards; Ctrl+D duplicates.'),
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
  if (e.target.matches && e.target.matches('input, textarea, [contenteditable]')) return;
  if (P.on) {
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); goSlide(P.i + 1); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); goSlide(P.i - 1); }
    else if (e.key === 'Escape') stopPresent();
    return;
  }
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === ']' || e.key === '[') && S.sel.length) { e.preventDefault(); if (e.shiftKey) reorder(e.key === ']'); else stepOrder(e.key === ']'); return; }
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'f') { e.preventDefault(); searchDialog(); return; }
  if (mod && k === 'a') { e.preventDefault(); selectAll(); return; }
  if (mod && (k === 'c' || k === 'x') && S.sel.length && !window.getSelection().toString()) { e.preventDefault(); copySelected(k === 'x'); return; }
  if (mod && k === 'd' && S.sel.length) { e.preventDefault(); duplicateSelected(); return; }
  if (mod && k === 'g') { e.preventDefault(); e.shiftKey ? ungroupSelected() : groupSelected(); return; }
  if (mod && k === 'l') { e.preventDefault(); if (S.sel.length) setLock(!selItems().every(isLocked)); return; }
  if (mod && (k === 'b' || k === 'i') && S.sel.length) {
    e.preventDefault(); const texts = selItems().filter((i) => (i.type === 'note' || i.type === 'text') && !isLocked(i)); const key = k === 'b' ? 'bold' : 'italic';
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
  if (e.target.matches && e.target.matches('input, textarea')) return;
  const files = [...(e.clipboardData.files || [])].filter((f) => /^image\//.test(f.type));
  if (files.length) { e.preventDefault(); for (const f of files) await insertImageFile(f); return; }
  const t = (e.clipboardData.getData('text') || '').trim(), c = readClip();
  if (c && (!t || t === c.sig.trim())) { e.preventDefault(); pasteClip(); return; } // items copied in My Whiteboard (any board)
  if (!t) return;
  e.preventDefault(); pasteText(t);
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
  $('#btnNewBoard').onclick = newBoardDialog;
  $('#boardSearch').addEventListener('input', (e) => { drawerFilter.q = e.target.value; renderDrawer(); }); $('#boardName').onclick = () => renameBoard(S.board.id);
  $('#btnSearch').onclick = searchDialog; $('#btnTheme').onclick = toggleTheme; $('#btnMore').onclick = (e) => moreMenu(e.currentTarget);
  $('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
  $('#zoomIn').onclick = () => zoomAt(1.25, { x: W / 2, y: H / 2 }); $('#zoomOut').onclick = () => zoomAt(0.8, { x: W / 2, y: H / 2 }); $('#zoomFit').onclick = fitView;
  $('#zoomPct').onclick = () => { S.view.scale = 1; zoomAt(1, { x: W / 2, y: H / 2 }); };
  $('#syncPill').onclick = manualSync;
  $('#multiDone').onclick = () => setMultiMode(false);
  $('#modalClose').onclick = () => closeModal(null); $('#modal').addEventListener('pointerdown', (e) => { if (e.target.id === 'modal') closeModal(null); });
  $('#fileImage').onchange = async (e) => { for (const f of e.target.files) await insertImageFile(f); e.target.value = ''; };
  $('#fileCamera').onchange = async (e) => { for (const f of e.target.files) await insertImageFile(f); e.target.value = ''; };
  $('#fileJSON').onchange = async (e) => { if (e.target.files[0]) await importJSONFile(e.target.files[0]); e.target.value = ''; };
  addEventListener('resize', () => { resize(); if (S.editingId) layoutEditor(); if (P.on) goSlide(P.i); });
  $('#presPrev').onclick = () => goSlide(P.i - 1); $('#presNext').onclick = () => goSlide(P.i + 1); $('#presExit').onclick = stopPresent;
  $('#btnMap').innerHTML = ICONS.map; $('#btnFrames').innerHTML = ICONS.frame; initMinimap();
  resize();

  // Storage: ask the browser to keep our offline data.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // Drive adapter
  if (MOCK) { const m = await import('./mockdrive.js'); adapter = new m.MockDriveAdapter(); }
  else adapter = new GoogleDriveAdapter(cfg);
  sync = createSync({
    adapter, cfg,
    onStatus: setSyncState,
    onNotice: (msg) => (/Drive inbox/.test(msg) ? toast(msg, { ms: 9000, kind: /skipped/.test(msg) ? 'warn' : undefined }) : toast(msg, { ms: 9000, kind: 'warn', action: 'History', onAction: versionsDialog })),
    onBoardChanged: (id) => { if (S.board && S.board.id === id) reloadCurrentFromDB(); },
    onBoardsListChanged: async () => { await refreshPending(); renderDrawer(); },
    buildInboxBoard: makeInboxBoard,
    applyInboxItems: (d, board, fileId) => makeInboxItems(d, board, fileId),
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
window.__wb = { S, PREF, P, readClip, copySelected, pasteClip, dictateNote, renderDrawer, setBoardMeta: (...a) => setBoardMeta(...a), makeInboxBoard: (...a) => makeInboxBoard(...a), makeInboxItems: (...a) => makeInboxItems(...a), startPresent, stopPresent, goSlide, alignSelected, setBgLocked, framesSorted, get adapter() { return adapter; }, get sync() { return sync; }, db, kv, openBoard, createBoard, setTool, setSel, selItems, commit, save, undo, redo, refreshPending, BUILTIN_TEMPLATES, toWorld, toScreen, saveChainDone: () => saveChain };
boot().catch((e) => { console.error(e); toast('Startup error: ' + e.message, { kind: 'error', ms: 0 }); });
