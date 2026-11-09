// Handwriting helpers: stroke smoothing and rough-shape recognition (pure functions, no DOM).
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const r1 = (v) => Math.round(v * 10) / 10;

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
// Ramer–Douglas–Peucker simplification.
export function simplify(pts, eps) {
  if (pts.length < 3) return pts.slice();
  let idx = -1, max = 0;
  for (let i = 1; i < pts.length - 1; i++) { const d = segDist(pts[i], pts[0], pts[pts.length - 1]); if (d > max) { max = d; idx = i; } }
  if (max <= eps) return [pts[0], pts[pts.length - 1]];
  return simplify(pts.slice(0, idx + 1), eps).slice(0, -1).concat(simplify(pts.slice(idx), eps));
}
// Gentle smoothing: weighted moving average (endpoints kept), then drop redundant points.
export function smooth(points, scale = 1) {
  if (points.length < 5) return points;
  const w = [1, 2, 3, 2, 1], out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    let x = 0, y = 0, s = 0;
    for (let k = -2; k <= 2; k++) { const p = points[Math.min(points.length - 1, Math.max(0, i + k))]; x += p[0] * w[k + 2]; y += p[1] * w[k + 2]; s += w[k + 2]; }
    out.push([r1(x / s), r1(y / s)]);
  }
  out.push(points[points.length - 1]);
  return simplify(out, 0.35 / scale);
}
export function pathLength(p) { let L = 0; for (let i = 1; i < p.length; i++) L += dist(p[i - 1], p[i]); return L; }
function bbox(p) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [x, y] of p) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
  return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
}
// Returns {type:'line'|'arrow'|'rect'|'ellipse', x1,y1,x2,y2} for a rough shape, or null to keep the stroke as drawn.
export function recognize(points, minSize = 30) {
  if (!points || points.length < 3) return null;
  const b = bbox(points), diag = Math.hypot(b.w, b.h); if (diag < minSize) return null;
  const L = pathLength(points), first = points[0], last = points[points.length - 1], dEnd = dist(first, last);
  const closed = dEnd < Math.max(20, 0.15 * L);
  if (!closed) {
    if (dEnd / L > 0.93) return { type: 'line', x1: first[0], y1: first[1], x2: last[0], y2: last[1] };
    const S = simplify(points, 0.08 * diag);
    if (S.length >= 3 && S.length <= 6) { // shaft, then a short arrow head drawn at the tip
      const shaft = dist(S[0], S[1]);
      if (shaft >= 0.5 * L && S.slice(2).every((q) => dist(q, S[1]) <= 0.45 * shaft)) return { type: 'arrow', x1: S[0][0], y1: S[0][1], x2: S[1][0], y2: S[1][1] };
    }
    return null;
  }
  const m = Math.min(b.w, b.h); if (m < 15) return null;
  const box = { type: 'rect', x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 };
  const corners = [[b.x1, b.y1], [b.x2, b.y1], [b.x2, b.y2], [b.x1, b.y2]];
  const nearCorners = corners.every((c) => points.some((q) => dist(q, c) < 0.17 * m));
  const edgeDev = points.reduce((s, [x, y]) => s + Math.min(x - b.x1, b.x2 - x, y - b.y1, b.y2 - y), 0) / points.length / m;
  if (nearCorners && edgeDev < 0.07) return box;
  const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2, rx = b.w / 2, ry = b.h / 2;
  const ellDev = points.reduce((s, [x, y]) => s + Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1), 0) / points.length;
  if (ellDev < 0.15) return { type: 'ellipse', x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 };
  return null;
}
