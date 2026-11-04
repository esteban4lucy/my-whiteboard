// Small UI helpers: modal dialogs, toasts, popovers, icons.
export const $ = (s, r = document) => r.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}

const P = (d) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICONS = {
  menu: P('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  select: P('<path d="M5 3l14 8-6 2-3 6z"/>'),
  pen: P('<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>'),
  highlighter: P('<path d="M9 14l-4 4v2h6l2-2"/><path d="M9 14l7-9 4 4-9 7z"/><path d="M3 22h18" opacity=".5"/>'),
  eraser: P('<path d="M7 21h10"/><path d="M4 15l9-9 7 7-6 6H9z"/>'),
  rect: P('<rect x="4" y="5" width="16" height="14" rx="1"/>'),
  ellipse: P('<ellipse cx="12" cy="12" rx="9" ry="7"/>'),
  line: P('<path d="M5 19L19 5"/>'),
  arrow: P('<path d="M5 19L19 5M10 5h9v9"/>'),
  text: P('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'),
  note: P('<path d="M4 4h16v11l-5 5H4z"/><path d="M15 20v-5h5"/>'),
  plus: P('<path d="M12 5v14M5 12h14"/>'),
  minus: P('<path d="M5 12h14"/>'),
  undo: P('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>'),
  redo: P('<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>'),
  search: P('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>'),
  theme: P('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 000 16z" fill="currentColor"/>'),
  more: P('<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>'),
  fit: P('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  image: P('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>'),
  link: P('<path d="M10 14a4 4 0 006 0l3-3a4 4 0 00-6-6l-1 1"/><path d="M14 10a4 4 0 00-6 0l-3 3a4 4 0 006 6l1-1"/>'),
  close: P('<path d="M6 6l12 12M18 6L6 18"/>'),
  trash: P('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  copy: P('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>'),
  edit: P('<path d="M4 20h4L19 9l-4-4L4 16z"/>'),
  front: P('<rect x="8" y="8" width="12" height="12" rx="1" fill="currentColor"/><path d="M4 16V4h12"/>'),
  back: P('<rect x="4" y="4" width="12" height="12" rx="1" fill="currentColor"/><path d="M20 8v12H8"/>'),
  open: P('<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>'),
  eye: P('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  shapes: P('<rect x="3" y="3" width="9" height="9" rx="1"/><circle cx="16.5" cy="16.5" r="4.5"/>'),
};

export function toast(msg, { ms = 3500, action, onAction, kind = '' } = {}) {
  const wrap = $('#toasts');
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, h('span', {}, msg));
  if (action) t.append(h('button', { class: 'toast-btn', onclick: () => { onAction && onAction(); t.remove(); } }, action));
  t.append(h('button', { class: 'toast-x', 'aria-label': 'Dismiss', onclick: () => t.remove(), html: '×' }));
  wrap.append(t);
  if (ms) setTimeout(() => t.remove(), ms);
  return t;
}

let modalResolve = null;
export function closeModal(v = null) {
  const m = $('#modal'); m.hidden = true; $('#modalBody').innerHTML = '';
  const r = modalResolve; modalResolve = null; r && r(v);
}
export function openModal(title, body, { wide = false } = {}) {
  if (modalResolve) closeModal(null);
  const m = $('#modal');
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = ''; $('#modalBody').append(body);
  m.querySelector('.sheet').classList.toggle('wide', wide);
  m.hidden = false;
  const f = body.querySelector('input:not([type=hidden]),textarea,select'); if (f) setTimeout(() => { f.focus(); f.select && f.select(); }, 30);
  return new Promise((res) => { modalResolve = res; });
}
export function ask(title, fields, { ok = 'OK', extra = null } = {}) {
  const form = h('form', { class: 'form' });
  for (const f of fields) {
    form.append(h('label', {}, h('span', {}, f.label), h(f.type === 'textarea' ? 'textarea' : 'input', { name: f.name, type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || '', required: f.required || false, autocomplete: 'off' })));
  }
  if (extra) form.append(extra);
  form.append(h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn', onclick: () => closeModal(null) }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, ok)));
  form.addEventListener('submit', (e) => { e.preventDefault(); closeModal(Object.fromEntries(new FormData(form).entries())); });
  return openModal(title, form);
}
export function confirmDlg(title, msg, ok = 'OK', danger = false) {
  const b = h('div', { class: 'form' }, h('p', {}, msg), h('div', { class: 'row end' },
    h('button', { class: 'btn', onclick: () => closeModal(false) }, 'Cancel'),
    h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => closeModal(true) }, ok)));
  return openModal(title, b).then((v) => !!v);
}

let popEl = null;
export function closePopover() { if (popEl) { popEl.remove(); popEl = null; } }
export function popover(anchor, content, { place = 'above' } = {}) {
  closePopover();
  popEl = h('div', { class: 'popover', role: 'menu' }, content);
  document.body.append(popEl);
  const r = anchor.getBoundingClientRect(), pr = popEl.getBoundingClientRect();
  let left = Math.min(Math.max(8, r.left + r.width / 2 - pr.width / 2), innerWidth - pr.width - 8);
  let top = place === 'above' ? r.top - pr.height - 8 : r.bottom + 8;
  if (top < 8) top = r.bottom + 8;
  if (top + pr.height > innerHeight - 8) top = Math.max(8, innerHeight - pr.height - 8);
  popEl.style.left = left + 'px'; popEl.style.top = top + 'px';
  setTimeout(() => document.addEventListener('pointerdown', function off(e) {
    if (popEl && !popEl.contains(e.target) && !anchor.contains(e.target)) { closePopover(); document.removeEventListener('pointerdown', off, true); }
    else if (!popEl) document.removeEventListener('pointerdown', off, true);
  }, true), 0);
  return popEl;
}

export function fmtTime(t) {
  try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(t)); } catch { return String(t); }
}
