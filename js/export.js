// Export: PNG (2x), PDF (single page, image embedded – no external library), JSON (re-importable).
import { drawBoard, boardBounds, themeColors } from './render.js';

export function renderBoardToCanvas(board, env, { scale = 2, pad = 60, maxPx = 8000 } = {}) {
  const bb = boardBounds(board.items);
  let s = scale;
  const W = bb.w + pad * 2, H = bb.h + pad * 2;
  if (Math.max(W, H) * s > maxPx) s = maxPx / Math.max(W, H);
  const c = document.createElement('canvas');
  c.width = Math.ceil(W * s); c.height = Math.ceil(H * s);
  const ctx = c.getContext('2d');
  drawBoard(ctx, board, { x: (-bb.x + pad) * s, y: (-bb.y + pad) * s, scale: s }, c.width, c.height, { ...env, tc: themeColors(env.theme), editingId: null });
  return c;
}

const fname = (board, ext) => `${String(board.name || 'board').replace(/[\\/:*?"<>|]+/g, '-')}.${ext}`;
export function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
const toBlob = (c, type, q) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Export failed'))), type, q));

export async function exportPNG(board, env) {
  const blob = await toBlob(renderBoardToCanvas(board, env), 'image/png');
  download(blob, fname(board, 'png')); return blob;
}

export async function exportPDF(board, env) {
  const c = renderBoardToCanvas(board, env, { scale: 2 });
  const jpeg = new Uint8Array(await (await toBlob(c, 'image/jpeg', 0.92)).arrayBuffer());
  const blob = makePdf(jpeg, c.width, c.height, board.name);
  download(blob, fname(board, 'pdf')); return blob;
}

// Minimal PDF 1.4 writer: one page sized to the image (fitted to max 1190pt ≈ A3 long edge).
export function makePdf(jpeg, pw, ph, title = 'Board') {
  const k = Math.min(1190 / Math.max(pw, ph), 1);
  const w = (pw * k).toFixed(2), h = (ph * k).toFixed(2);
  const enc = new TextEncoder(); const parts = []; const offsets = []; let len = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
  const esc = (s) => String(s).replace(/[^\x20-\x7e]/g, '?').replace(/([()\\])/g, '\\$1');
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
  obj(3, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));
  obj(4, () => { push(`<< /Type /XObject /Subtype /Image /Width ${pw} /Height ${ph} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`); push(jpeg); push('\nendstream'); });
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  obj(5, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  obj(6, () => push(`<< /Title (${esc(title)}) /Producer (My Whiteboard) >>`));
  const xref = len;
  let x = `xref\n0 7\n0000000000 65535 f \n`;
  for (let i = 1; i <= 6; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(x + `trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

export function exportJSON(board) {
  const data = { app: 'my-whiteboard', schema: 1, exportedAt: new Date().toISOString(), id: board.id, name: board.name, background: board.background, ...(board.bgLocked ? { bgLocked: true } : {}), items: board.items };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  download(blob, fname(board, 'json')); return blob;
}
