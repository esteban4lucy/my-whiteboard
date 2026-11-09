// Canvas rendering + geometry helpers shared by the live view and exports.
export const INK_COLORS = ['ink', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#6d4c41'];
export const NOTE_COLORS = ['#fff59d', '#ffcc80', '#f8bbd0', '#b3e5fc', '#c5e1a5', '#e1bee7', '#ffffff'];
export const SIZES = [2, 4, 8, 16];

export function themeColors(theme) {
  return theme === 'dark'
    ? { bg: '#1c1d21', grid: '#2c2e34', dot: '#3a3d45', ink: '#ececec', card: '#2a2c31', cardText: '#ececec', muted: '#9aa0a6', sel: '#4f8cff' }
    : { bg: '#fafaf7', grid: '#e9e9e4', dot: '#cfcfc8', ink: '#1d1d1f', card: '#ffffff', cardText: '#1d1d1f', muted: '#6b7076', sel: '#2563eb' };
}
export const col = (c, tc) => (c === 'ink' || !c ? tc.ink : c);

export const LINK_KINDS = {
  doc: { label: 'Google Doc', color: '#4285f4', glyph: 'D' },
  sheet: { label: 'Google Sheet', color: '#0f9d58', glyph: 'S' },
  slides: { label: 'Google Slides', color: '#f4b400', glyph: 'P' },
  drive: { label: 'Drive file', color: '#5f6368', glyph: '▲' },
  web: { label: 'Web link', color: '#8e24aa', glyph: '↗' },
};
export function linkKind(url) {
  if (/docs\.google\.com\/document/.test(url)) return 'doc';
  if (/docs\.google\.com\/spreadsheets/.test(url)) return 'sheet';
  if (/docs\.google\.com\/presentation/.test(url)) return 'slides';
  if (/drive\.google\.com\//.test(url)) return 'drive';
  return 'web';
}
export function previewUrl(url) {
  const kind = linkKind(url);
  if (kind === 'doc' || kind === 'sheet' || kind === 'slides') return url.replace(/\/(edit|view|htmlview|pub)[^/]*$/, '').replace(/[?#].*$/, '') + '/preview';
  const m = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=)([\w-]+)/);
  if (m) return `https://drive.google.com/file/d/${m[1]}/preview`;
  return url;
}

export function bounds(it) {
  switch (it.type) {
    case 'stroke': {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const [x, y] of it.points) { if (x < x1) x1 = x; if (y < y1) y1 = y; if (x > x2) x2 = x; if (y > y2) y2 = y; }
      const p = (it.size || 2) / 2;
      return { x: x1 - p, y: y1 - p, w: x2 - x1 + 2 * p, h: y2 - y1 + 2 * p };
    }
    case 'rect': case 'ellipse': case 'line': case 'arrow':
      return { x: Math.min(it.x1, it.x2), y: Math.min(it.y1, it.y2), w: Math.abs(it.x2 - it.x1), h: Math.abs(it.y2 - it.y1) };
    case 'text': {
      const lines = String(it.text || ' ').split('\n');
      const w = Math.max(...lines.map((l) => measure(l, fontStr(it)))) + 4;
      return { x: it.x, y: it.y, w: Math.max(w, it.fontSize), h: lines.length * it.fontSize * 1.25 };
    }
    case 'frame': return { x: it.x, y: it.y, w: it.w, h: it.collapsed ? FRAME_HEAD : it.h };
    default: return { x: it.x, y: it.y, w: it.w, h: it.h };
  }
}
export const FRAME_HEAD = 44;
export const FRAME_COLORS = ['#c7d2fe', '#bae6fd', '#bbf7d0', '#fef08a', '#fed7aa', '#fbcfe8', '#e5e7eb'];
const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const inside = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
// Items whose centre lies inside a frame's full area (the frame's contents).
export function frameContents(items, f) {
  const r = { x: f.x, y: f.y, w: f.w, h: f.h };
  return items.filter((it) => it !== f && it.id !== f.id && inside(center(bounds(it)), r) && !(it.type === 'frame' && it.w * it.h >= f.w * f.h));
}
// Ids hidden by collapsed frames.
export function hiddenIds(items) {
  const out = new Set();
  for (const f of items) if (f.type === 'frame' && f.collapsed) for (const it of frameContents(items, f)) out.add(it.id);
  return out;
}
// Paint order: frames at the back, then the background layer, then everything else (each in list order).
export function drawOrder(items) {
  const rank = (it) => (it.type === 'frame' ? 0 : it.layer === 'bg' ? 1 : 2);
  return items.map((it, i) => [it, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
}
// Connectors: a line/arrow may carry `from` / `to` item ids; its ends then follow those items.
function edgePoint(b, tx, ty, gap = 6) {
  const c = center(b), dx = tx - c.x, dy = ty - c.y;
  if (!dx && !dy) return c;
  const t = Math.min(dx ? (b.w / 2) / Math.abs(dx) : Infinity, dy ? (b.h / 2) / Math.abs(dy) : Infinity);
  const len = Math.hypot(dx, dy), k = Math.min(1, t + gap / len);
  return { x: c.x + dx * k, y: c.y + dy * k };
}
export function updateConnectors(items) {
  let map = null;
  for (const it of items) {
    if ((it.type !== 'arrow' && it.type !== 'line') || (!it.from && !it.to)) continue;
    if (!map) map = new Map(items.map((i) => [i.id, i]));
    const A = it.from && map.get(it.from), B = it.to && map.get(it.to);
    const ba = A && bounds(A), bb = B && bounds(B);
    const ta = bb ? center(bb) : { x: it.x2, y: it.y2 }, tb = ba ? center(ba) : { x: it.x1, y: it.y1 };
    if (ba) { const p = edgePoint(ba, ta.x, ta.y); it.x1 = Math.round(p.x * 10) / 10; it.y1 = Math.round(p.y * 10) / 10; }
    if (bb) { const p = edgePoint(bb, tb.x, tb.y); it.x2 = Math.round(p.x * 10) / 10; it.y2 = Math.round(p.y * 10) / 10; }
  }
}
// Sticky-note layout: wrapped lines, checklist lines ("[ ] task" / "[x] done"), and a footer for tags / due date.
const CHECK_RE = /^\[( |x|X)\]\s?/;
export const NOTE_FOOTER = 34;
export function noteLayout(it) {
  const fs = it.fontSize || 20, lh = fs * 1.25, box = Math.round(fs * 0.85), font = fontStr(it, fs);
  if (!mctx) measure('', font);
  mctx.font = font;
  const lines = []; let y = it.y + 12;
  String(it.text || '').split('\n').forEach((para, src) => {
    const m = para.match(CHECK_RE), check = m ? m[1] !== ' ' : null, body = m ? para.slice(m[0].length) : para;
    const indent = m ? box + 8 : 0;
    wrap(mctx, body, it.w - 24 - indent).forEach((t, k) => { lines.push({ text: t, x: it.x + 12 + indent, y, check: k === 0 ? check : null, src, cont: m && k > 0 }); y += lh; });
  });
  const footer = (it.tags && it.tags.length) || it.due ? NOTE_FOOTER : 0;
  return { lines, fs, lh, box, footer, font };
}
// Returns the paragraph index of a checklist box at (x, y) on a note, or -1.
export function noteCheckAt(it, x, y) {
  const L = noteLayout(it);
  for (const l of L.lines) if (l.check !== null && x >= it.x + 4 && x <= it.x + 20 + L.box && y >= l.y - 4 && y <= l.y + L.lh) return l.src;
  return -1;
}
export function toggleCheck(text, src) {
  const paras = String(text || '').split('\n'); const m = paras[src] && paras[src].match(CHECK_RE); if (!m) return text;
  paras[src] = (m[1] === ' ' ? '[x] ' : '[ ] ') + paras[src].slice(m[0].length); return paras.join('\n');
}
const TAG_COLORS = ['#1e88e5', '#8e24aa', '#43a047', '#e53935', '#fb8c00', '#00897b', '#6d4c41', '#3949ab'];
export const tagColor = (t) => { let h = 0; for (const c of String(t)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return TAG_COLORS[h % TAG_COLORS.length]; };
export function dueState(due, now = new Date()) {
  if (!due) return null;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return due < today ? 'overdue' : due === today ? 'today' : 'later';
}
export function fmtDue(due) {
  const [y, m, d] = String(due).split('-').map(Number); if (!y || !m || !d) return String(due);
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]}`;
}
let mctx = null;
function measure(s, font) {
  if (!mctx) mctx = (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas')).getContext('2d');
  mctx.font = font;
  return mctx.measureText(s).width;
}
export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
// Text formatting (optional item fields: bold, italic, fontSize; notes also textColor).
export function fontStr(it, size) {
  const fs = size || it.fontSize || (it.type === 'note' ? 20 : 28);
  return `${it.italic ? 'italic ' : ''}${it.bold ? 'bold ' : ''}${fs}px ${FONT}`;
}
export const noteTextColor = (it) => (!it.textColor || it.textColor === 'ink' ? '#1d1d1f' : it.textColor);

// Uniformly scale an item about (ox, oy) – used when resizing a group / multi-selection.
export function scaleItem(it, ox, oy, s) {
  const X = (x) => ox + (x - ox) * s, Y = (y) => oy + (y - oy) * s;
  if (it.type === 'stroke') { it.points = it.points.map(([x, y, p]) => (p === undefined ? [X(x), Y(y)] : [X(x), Y(y), p])); it.size = Math.max(1, it.size * s); }
  else if ('x1' in it) { it.x1 = X(it.x1); it.y1 = Y(it.y1); it.x2 = X(it.x2); it.y2 = Y(it.y2); it.size = Math.max(1, (it.size || 2) * s); }
  else {
    it.x = X(it.x); it.y = Y(it.y);
    if ('w' in it) { it.w *= s; it.h *= s; }
    if (it.type === 'text' || it.type === 'note') it.fontSize = Math.max(6, (it.fontSize || (it.type === 'note' ? 20 : 28)) * s);
  }
  return it;
}

export function boardBounds(items) {
  if (!items.length) return { x: -400, y: -300, w: 800, h: 600 };
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const it of items) { const b = bounds(it); x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h); }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
export function hit(it, x, y, tol) {
  if (it.type === 'stroke') {
    const r = (it.size || 2) / 2 + tol, p = it.points;
    if (p.length === 1) return Math.hypot(p[0][0] - x, p[0][1] - y) <= r;
    for (let i = 1; i < p.length; i++) if (distSeg(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) <= r) return true;
    return false;
  }
  if (it.type === 'line' || it.type === 'arrow') return distSeg(x, y, it.x1, it.y1, it.x2, it.y2) <= (it.size || 2) / 2 + tol;
  if (it.type === 'frame') return x >= it.x - tol && x <= it.x + it.w + tol && y >= it.y - tol && y <= it.y + FRAME_HEAD; // frames are grabbed by their title bar
  const b = bounds(it);
  return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
}
export function frameToggleRect(it) { return { x: it.x + it.w - 46, y: it.y, w: 46, h: FRAME_HEAD }; }
export function linkOpenRect(it) { return { x: it.x + it.w - 86, y: it.y + it.h - 38, w: 76, h: 30 }; }

export function moveItem(it, dx, dy) {
  if (it.type === 'stroke') it.points = it.points.map(([x, y, p]) => (p === undefined ? [x + dx, y + dy] : [x + dx, y + dy, p]));
  else if ('x1' in it) { it.x1 += dx; it.y1 += dy; it.x2 += dx; it.y2 += dy; }
  else { it.x += dx; it.y += dy; }
}

export function drawBackground(ctx, bg, view, w, h, tc) {
  ctx.fillStyle = tc.bg; ctx.fillRect(0, 0, w, h);
  if (bg === 'solid') return;
  let step = 40 * view.scale;
  while (step < 14) step *= 2;
  const ox = ((view.x % step) + step) % step, oy = ((view.y % step) + step) % step;
  if (bg === 'dots') {
    ctx.fillStyle = tc.dot;
    const r = Math.max(1, Math.min(2, view.scale * 1.5));
    for (let x = ox; x < w; x += step) for (let y = oy; y < h; y += step) { ctx.fillRect(x - r / 2, y - r / 2, r, r); }
  } else {
    ctx.strokeStyle = tc.grid; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = ox; x < w; x += step) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h); }
    for (let y = oy; y < h; y += step) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); }
    ctx.stroke();
  }
}

function lineDone(lines, l) { for (let i = lines.indexOf(l); i >= 0; i--) if (lines[i].check !== null) return lines[i].check === true; return false; }
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function wrap(ctx, textStr, maxW) {
  const out = [];
  for (const para of String(textStr).split('\n')) {
    const words = para.split(/(\s+)/); let line = '';
    for (const w of words) {
      const t = line + w;
      if (ctx.measureText(t).width > maxW && line.trim()) { out.push(line.trimEnd()); line = w.trimStart(); }
      else line = t;
      while (ctx.measureText(line).width > maxW && line.length > 1) { // hard-break very long words
        let k = line.length - 1; while (k > 1 && ctx.measureText(line.slice(0, k)).width > maxW) k--;
        out.push(line.slice(0, k)); line = line.slice(k);
      }
    }
    out.push(line);
  }
  return out;
}

export function drawStroke(ctx, it, tc) {
  const p = it.points; if (!p.length) return;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = col(it.color, tc); ctx.lineWidth = it.size;
  if (it.tool === 'highlighter') { ctx.globalAlpha = 0.35; ctx.lineCap = 'square'; }
  ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]);
  if (p.length === 1) ctx.lineTo(p[0][0] + 0.01, p[0][1]);
  for (let i = 1; i < p.length - 1; i++) {
    const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2;
    ctx.quadraticCurveTo(p[i][0], p[i][1], mx, my);
  }
  if (p.length > 1) ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
  ctx.stroke(); ctx.restore();
}

export function drawItem(ctx, it, env) {
  const tc = env.tc;
  switch (it.type) {
    case 'stroke': drawStroke(ctx, it, tc); break;
    case 'rect': case 'ellipse': case 'line': case 'arrow': {
      ctx.save(); ctx.strokeStyle = col(it.color, tc); ctx.lineWidth = it.size || 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      if (it.type === 'rect') { const b = bounds(it); ctx.rect(b.x, b.y, b.w, b.h); }
      else if (it.type === 'ellipse') { const b = bounds(it); ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, Math.max(1, b.w / 2), Math.max(1, b.h / 2), 0, 0, Math.PI * 2); }
      else { ctx.moveTo(it.x1, it.y1); ctx.lineTo(it.x2, it.y2); }
      if (it.fill) { ctx.fillStyle = it.fill; ctx.fill(); }
      ctx.stroke();
      if (it.type === 'arrow') {
        const a = Math.atan2(it.y2 - it.y1, it.x2 - it.x1), L = Math.max(12, (it.size || 2) * 4);
        ctx.beginPath(); ctx.moveTo(it.x2, it.y2); ctx.lineTo(it.x2 - L * Math.cos(a - 0.45), it.y2 - L * Math.sin(a - 0.45));
        ctx.moveTo(it.x2, it.y2); ctx.lineTo(it.x2 - L * Math.cos(a + 0.45), it.y2 - L * Math.sin(a + 0.45)); ctx.stroke();
      }
      ctx.restore(); break;
    }
    case 'text': {
      if (env.editingId === it.id) break;
      ctx.save(); ctx.fillStyle = col(it.color, tc); ctx.font = fontStr(it); ctx.textBaseline = 'top';
      String(it.text).split('\n').forEach((l, i) => ctx.fillText(l, it.x, it.y + i * it.fontSize * 1.25));
      ctx.restore(); break;
    }
    case 'note': {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.18)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
      ctx.fillStyle = it.color || NOTE_COLORS[0]; ctx.fillRect(it.x, it.y, it.w, it.h);
      ctx.shadowColor = 'transparent';
      const L = noteLayout(it), ink = noteTextColor(it);
      if (env.editingId !== it.id) {
        ctx.save(); ctx.beginPath(); ctx.rect(it.x, it.y, it.w, it.h - L.footer); ctx.clip();
        ctx.font = L.font; ctx.textBaseline = 'top';
        for (const l of L.lines) {
          if (l.check !== null) {
            const bx = it.x + 12, by = l.y + (L.lh - L.box) / 2 - 1;
            ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1.5, L.fs / 12); ctx.strokeRect(bx, by, L.box, L.box);
            if (l.check) { ctx.beginPath(); ctx.moveTo(bx + L.box * 0.2, by + L.box * 0.55); ctx.lineTo(bx + L.box * 0.42, by + L.box * 0.78); ctx.lineTo(bx + L.box * 0.82, by + L.box * 0.22); ctx.stroke(); }
          }
          const done = l.check === true || (l.cont && lineDone(L.lines, l));
          ctx.fillStyle = ink; ctx.globalAlpha = done ? 0.5 : 1; ctx.fillText(l.text, l.x, l.y);
          if (done && l.text) { const w = ctx.measureText(l.text).width; ctx.fillRect(l.x, l.y + L.fs * 0.55, w, Math.max(1, L.fs / 14)); }
          ctx.globalAlpha = 1;
        }
        ctx.restore();
      }
      if (L.footer) { // tags + due date chips
        let x = it.x + 8; const y = it.y + it.h - L.footer + 6, hh = L.footer - 12;
        ctx.font = `600 13px ${FONT}`; ctx.textBaseline = 'middle';
        const chip = (label, bg, fg = '#fff') => { const w = ctx.measureText(label).width + 14; if (x + w > it.x + it.w - 6) return; roundRect(ctx, x, y, w, hh, hh / 2); ctx.fillStyle = bg; ctx.fill(); ctx.fillStyle = fg; ctx.fillText(label, x + 7, y + hh / 2 + 1); x += w + 5; };
        if (it.due) { const st = dueState(it.due); chip('⏰ ' + fmtDue(it.due), st === 'overdue' ? '#d93025' : st === 'today' ? '#f57c00' : 'rgba(0,0,0,0.55)'); }
        for (const t of it.tags || []) chip('#' + t, tagColor(t));
      }
      ctx.restore(); break;
    }
    case 'frame': {
      const c = it.color || FRAME_COLORS[0], hd = FRAME_HEAD;
      ctx.save();
      ctx.globalAlpha = 0.28; ctx.fillStyle = c; ctx.fillRect(it.x, it.y, it.w, it.collapsed ? hd : it.h);
      ctx.globalAlpha = 0.75; ctx.fillRect(it.x, it.y, it.w, hd); ctx.globalAlpha = 1;
      ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.strokeRect(it.x, it.y, it.w, it.collapsed ? hd : it.h);
      ctx.fillStyle = '#1d1d1f'; ctx.font = `bold 20px ${FONT}`; ctx.textBaseline = 'middle';
      const label = (it.title || 'Frame') + (it.collapsed ? `  ·  ${env.hiddenCount ? env.hiddenCount(it) : ''} hidden` : '');
      ctx.save(); ctx.beginPath(); ctx.rect(it.x, it.y, it.w - 48, hd); ctx.clip(); ctx.fillText(label, it.x + 14, it.y + hd / 2 + 1); ctx.restore();
      const t = frameToggleRect(it), cx = t.x + t.w / 2, cy = t.y + t.h / 2; // ▾ / ▸ collapse chevron
      ctx.strokeStyle = '#1d1d1f'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.beginPath();
      if (it.collapsed) { ctx.moveTo(cx - 4, cy - 7); ctx.lineTo(cx + 4, cy); ctx.lineTo(cx - 4, cy + 7); } else { ctx.moveTo(cx - 7, cy - 4); ctx.lineTo(cx, cy + 4); ctx.lineTo(cx + 7, cy - 4); }
      ctx.stroke(); ctx.restore(); break;
    }
    case 'image': {
      const img = env.getImage ? env.getImage(it) : null;
      ctx.save();
      if (img) ctx.drawImage(img, it.x, it.y, it.w, it.h);
      else {
        ctx.fillStyle = tc.card; ctx.strokeStyle = tc.muted; ctx.setLineDash([8, 6]); ctx.lineWidth = 2;
        ctx.fillRect(it.x, it.y, it.w, it.h); ctx.strokeRect(it.x, it.y, it.w, it.h); ctx.setLineDash([]);
        ctx.fillStyle = tc.muted; ctx.font = `18px ${FONT}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
        ctx.fillText(it.status === 'error' ? 'Image unavailable' : 'Loading image…', it.x + it.w / 2, it.y + it.h / 2);
      }
      ctx.restore(); break;
    }
    case 'link': {
      const k = LINK_KINDS[it.kind] || LINK_KINDS.web;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.18)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
      roundRect(ctx, it.x, it.y, it.w, it.h, 12); ctx.fillStyle = tc.card; ctx.fill(); ctx.shadowColor = 'transparent';
      ctx.strokeStyle = k.color; ctx.lineWidth = 2; ctx.stroke();
      roundRect(ctx, it.x + 12, it.y + 12, 44, 44, 8); ctx.fillStyle = k.color; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = `bold 24px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(k.glyph, it.x + 34, it.y + 35);
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = tc.cardText; ctx.font = `bold 17px ${FONT}`;
      wrap(ctx, it.title || it.url, it.w - 82).slice(0, 2).forEach((l, i) => ctx.fillText(l, it.x + 68, it.y + 12 + i * 21));
      ctx.fillStyle = tc.muted; ctx.font = `13px ${FONT}`;
      let host = ''; try { host = new URL(it.url).hostname; } catch { host = it.url; }
      ctx.fillText(`${k.label} · ${host}`.slice(0, 48), it.x + 12, it.y + it.h - 30);
      const o = linkOpenRect(it); roundRect(ctx, o.x, o.y, o.w, o.h, 6); ctx.fillStyle = k.color; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = `bold 14px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('Open ↗', o.x + o.w / 2, o.y + o.h / 2);
      ctx.restore(); break;
    }
  }
}

export function drawBoard(ctx, board, view, w, h, env) {
  drawBackground(ctx, board.background || 'grid', view, w, h, env.tc);
  ctx.save(); ctx.translate(view.x, view.y); ctx.scale(view.scale, view.scale);
  const vx = -view.x / view.scale, vy = -view.y / view.scale, vw = w / view.scale, vh = h / view.scale;
  updateConnectors(board.items);
  const hidden = hiddenIds(board.items);
  const e2 = { ...env, hiddenCount: (f) => frameContents(board.items, f).length };
  for (const it of drawOrder(board.items)) {
    if (hidden.has(it.id)) continue;
    const b = bounds(it);
    if (b.x > vx + vw || b.y > vy + vh || b.x + b.w < vx || b.y + b.h < vy) continue; // cull
    drawItem(ctx, it, e2);
  }
  ctx.restore();
}
