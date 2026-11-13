// Sync engine: IndexedDB is the source of truth; Drive is the replica.
// Each board record carries: dirty (local changes not yet pushed), driveFileId, driveModifiedTime
// (the Drive modifiedTime we last saw), updatedAt (local edit time, used for last-write-wins).
import { db, kv } from './db.js';

const boardPayload = (b, imageFiles) => ({ app: 'my-whiteboard', schema: 1, id: b.id, name: b.name, background: b.background, ...(b.bgLocked ? { bgLocked: true } : {}), ...(b.pinned ? { pinned: true } : {}), ...(b.tags && b.tags.length ? { tags: b.tags } : {}), createdAt: b.createdAt, updatedAt: b.updatedAt, items: b.items, ...(imageFiles ? { imageFiles } : {}) });
// Map of uploaded pictures used by a board: { blobKey: driveFileId } (lets other devices download them).
async function imageMap(b) {
  const out = {};
  for (const it of b.items || []) {
    if (it.type !== 'image' || !it.blobKey) continue;
    const rec = await db.get('blobs', it.blobKey);
    if (rec && rec.driveId) out[it.blobKey] = rec.driveId;
  }
  return out;
}
const safeName = (s) => String(s || 'Untitled').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);
const fileName = (b) => `${safeName(b.name)}.board.json`;

export function createSync({ adapter, cfg, onStatus, onNotice, onBoardChanged, onBoardsListChanged, buildInboxBoard, applyInboxItems, applyInboxUpdates }) {
  let running = null, again = false, timer = null;
  const maxVersions = cfg.MAX_VERSIONS || 5;
  const versionGapMs = (cfg.VERSION_INTERVAL_MINUTES ?? 10) * 60_000;

  function status() {
    if (!adapter) return 'local';
    if (!adapter.isConfigured()) return 'local';
    if (!navigator.onLine) return 'offline';
    if (!adapter.isAuthed()) return 'signin';
    return null;
  }

  async function saveVersion(boardId, data, reason) {
    const savedAt = new Date().toISOString();
    await adapter.createFile('versions', `${safeName(data.name)} — ${savedAt.replace('T', ' ').slice(0, 19)} UTC (${reason}).json`,
      { ...data, versionInfo: { savedAt, reason } }, 'application/json', { boardId, savedAt, reason });
    await kv.set('lastVersion:' + boardId, Date.now());
    await pruneVersions(boardId);
  }
  async function pruneVersions(boardId) {
    const all = (await adapter.listFiles('versions')).filter((f) => f.appProperties && f.appProperties.boardId === boardId);
    all.sort((a, b) => String(b.appProperties.savedAt || b.createdTime).localeCompare(String(a.appProperties.savedAt || a.createdTime)));
    for (const f of all.slice(maxVersions)) await adapter.trash(f.id);
  }
  async function listVersions(boardId) {
    const all = (await adapter.listFiles('versions')).filter((f) => f.appProperties && f.appProperties.boardId === boardId);
    return all.sort((a, b) => String(b.appProperties.savedAt).localeCompare(String(a.appProperties.savedAt)));
  }

  async function maybeAutoVersion(b) {
    const last = await kv.get('lastVersion:' + b.id, 0);
    if (Date.now() - last >= versionGapMs) await saveVersion(b.id, boardPayload(b), 'auto');
  }

  async function pushImages(notices) {
    const blobs = await db.all('blobs');
    for (const bl of blobs) {
      if (bl.driveId || bl.external || !bl.blob) continue;
      const res = await adapter.createFile('images', bl.name || `${bl.key}.png`, bl.blob, bl.mime || 'image/png', { blobKey: bl.key });
      bl.driveId = res.id; await db.put('blobs', bl);
      // Boards using this picture must re-publish their imageFiles map.
      const force = new Set(await kv.get('forcePush', []));
      for (const b of await db.all('boards')) if ((b.items || []).some((it) => it.type === 'image' && it.blobKey === bl.key)) force.add(b.id);
      await kv.set('forcePush', [...force]);
    }
  }

  async function pullImages(board, imageFiles = {}) {
    for (const it of board.items || []) {
      if (it.type !== 'image' || !it.blobKey) continue;
      const rec = await db.get('blobs', it.blobKey);
      if (rec && rec.blob) continue;
      const driveId = imageFiles[it.blobKey] || (rec && rec.driveId) || it.driveId;
      if (!driveId) continue;
      try {
        const blob = await adapter.readBlob(driveId);
        await db.put('blobs', { key: it.blobKey, blob, mime: blob.type, driveId });
      } catch (e) {
        console.warn('image pull failed', e);
        if (!rec) await db.put('blobs', { key: it.blobKey, blob: null, driveId }); // remember where it lives
      }
    }
  }

  async function applyRemote(local, remoteMeta, data) {
    const rec = {
      ...(local || {}), id: data.id, name: data.name, background: data.background || 'grid', bgLocked: data.bgLocked ? true : undefined, pinned: data.pinned ? true : undefined, tags: Array.isArray(data.tags) && data.tags.length ? data.tags : undefined, items: data.items || [],
      createdAt: data.createdAt || Date.now(), updatedAt: data.updatedAt || Date.now(),
      dirty: false, deleted: false, driveFileId: remoteMeta.id, driveModifiedTime: remoteMeta.modifiedTime,
    };
    let clobbered = false;
    await db.update('boards', rec.id, (cur) => {
      if (cur && local && cur.updatedAt !== local.updatedAt) { clobbered = true; return undefined; } // edited meanwhile
      return rec;
    });
    if (clobbered) return local;
    await pullImages(rec, data.imageFiles || {});
    onBoardChanged && onBoardChanged(rec.id);
    return rec;
  }

  async function syncBoards(notices) {
    const remote = await adapter.listFiles('boards');
    const byId = new Map();
    for (const r of remote) {
      let bid = r.appProperties && r.appProperties.boardId;
      if (!bid) { try { bid = (await adapter.readJSON(r.id)).id; } catch { /* not a board */ } }
      if (bid) byId.set(bid, r);
    }
    const locals = await db.all('boards');
    const force = new Set(await kv.get('forcePush', []));
    for (const local of locals) {
      if (force.has(local.id)) local.dirty = true;
      const r = byId.get(local.id); byId.delete(local.id);
      if (local.deleted) {
        if (r) await adapter.trash(r.id);
        await db.del('boards', local.id); continue;
      }
      if (!r) {
        if (local.driveFileId && !local.dirty && (await adapter.fileState(local.driveFileId)) === 'gone') { // deleted on another device
          await db.del('boards', local.id);
          notices.push(`“${local.name}” was deleted on another device.`); onBoardChanged && onBoardChanged(local.id); continue;
        }
        const seen = local.updatedAt;
        const res = await adapter.createFile('boards', fileName(local), boardPayload(local, await imageMap(local)), 'application/json', { boardId: local.id, updatedAt: String(local.updatedAt) });
        await saveVersion(local.id, boardPayload(local), 'created');
        await commitPushed(local.id, seen, res);
        continue;
      }
      const remoteChanged = r.modifiedTime !== local.driveModifiedTime;
      if (local.dirty && !remoteChanged) {
        const seen = local.updatedAt;
        await maybeAutoVersion(local);
        const res = await adapter.updateFile(r.id, fileName(local), boardPayload(local, await imageMap(local)), 'application/json', { boardId: local.id, updatedAt: String(local.updatedAt) });
        await commitPushed(local.id, seen, res);
      } else if (local.dirty && remoteChanged) {
        // Conflict: both sides changed since last sync → last write wins (by edit time), loser kept as a version.
        const data = await adapter.readJSON(r.id);
        if ((local.updatedAt || 0) >= (data.updatedAt || 0)) {
          await saveVersion(local.id, data, 'overwritten-remote');
          const seen = local.updatedAt;
          const res = await adapter.updateFile(r.id, fileName(local), boardPayload(local, await imageMap(local)), 'application/json', { boardId: local.id, updatedAt: String(local.updatedAt) });
          await commitPushed(local.id, seen, res);
          notices.push(`“${local.name}” was also changed on another device. Your newer edits won; the other copy is saved in Version history.`);
        } else {
          await saveVersion(local.id, boardPayload(local), 'overwritten-local');
          await applyRemote(local, r, data);
          notices.push(`“${data.name}” had newer changes from another device. Your offline edits were replaced and saved in Version history.`);
        }
      } else if (!local.dirty && remoteChanged) {
        const data = await adapter.readJSON(r.id);
        const cur = await db.get('boards', local.id);
        if (cur && cur.updatedAt !== local.updatedAt) continue; // edited meanwhile; next pass handles it
        await applyRemote(local, r, data);
      } else {
        await pullImages(local);
      }
    }
    await kv.set('forcePush', []);
    for (const [bid, r] of byId) { // new boards from other devices
      const data = await adapter.readJSON(r.id);
      if (!data.id) data.id = bid;
      await applyRemote(null, r, data);
      onBoardsListChanged && onBoardsListChanged();
    }
  }

  async function commitPushed(id, seenUpdatedAt, res) {
    await db.update('boards', id, (cur) => {
      if (!cur) return undefined;
      cur.driveFileId = res.id; cur.driveModifiedTime = res.modifiedTime;
      if (cur.updatedAt === seenUpdatedAt) cur.dirty = false; // otherwise: edited during upload, stays dirty
      return cur;
    });
  }

  async function syncTemplates() {
    const remote = await adapter.listFiles('templates');
    const locals = await db.all('templates');
    const known = new Set(locals.map((t) => t.driveFileId).filter(Boolean));
    const remoteIds = new Set(remote.map((r) => r.id));
    for (const t of locals) {
      const payload = { app: 'my-whiteboard', kind: 'template', id: t.id, name: t.name, background: t.background, ...(t.bgLocked ? { bgLocked: true } : {}), items: t.items };
      if (t.deleted) { if (t.driveFileId && remoteIds.has(t.driveFileId)) await adapter.trash(t.driveFileId); await db.del('templates', t.id); continue; }
      if (!t.driveFileId) { const res = await adapter.createFile('templates', `${safeName(t.name)}.template.json`, payload, 'application/json', { templateId: t.id }); t.driveFileId = res.id; t.dirty = false; await db.put('templates', t); continue; }
      if (!remoteIds.has(t.driveFileId)) { if (!t.dirty) await db.del('templates', t.id); continue; }
      if (t.dirty) { await adapter.updateFile(t.driveFileId, `${safeName(t.name)}.template.json`, payload, 'application/json', { templateId: t.id }); t.dirty = false; await db.put('templates', t); }
    }
    const byFile = new Map((await db.all('templates')).filter((t) => t.driveFileId).map((t) => [t.driveFileId, t]));
    for (const r of remote) {
      const loc = byFile.get(r.id);
      // new on Drive, or edited on Drive / another device since we last read it (and not changed here)
      if (known.has(r.id) && (!loc || loc.dirty || !r.modifiedTime || loc.remoteMod === r.modifiedTime)) continue;
      try {
        const d = await adapter.readJSON(r.id);
        if (!Array.isArray(d.items)) continue;
        await db.put('templates', { id: d.id || r.id, name: d.name || r.name.replace(/\.(template\.)?json$/, ''), background: d.background || 'grid', bgLocked: d.bgLocked ? true : undefined, items: d.items, driveFileId: r.id, dirty: false, remoteMod: r.modifiedTime });
      } catch { /* skip non-template files */ }
    }
  }

  // Drive inbox (Whiteboard/inbox): JSON files create a board, add items, or update items, then go to the Drive bin.
  // Idempotent: new-board id is derived from the file's "id"; add-items / update-items use inboxDone plus the file's "id",
  // and deterministic item ids, so the same change is never applied twice.
  // Files renamed ERROR – "type" must be … by an older app version are retried once (prefix stripped).
  async function resolveInboxBoard(ref, bad) {
    const key = String(ref || '').trim();
    if (!key) throw bad('"board" is required (board name or id)');
    const locals = (await db.all('boards')).filter((b) => !b.deleted);
    let b = locals.find((x) => x.id === key);
    if (!b) {
      const want = key.toLowerCase();
      const hits = locals.filter((x) => String(x.name || '').toLowerCase() === want).sort((a, c) => (c.updatedAt || 0) - (a.updatedAt || 0));
      if (hits.length) b = hits[0];
    }
    if (b) return b;
    const remote = await adapter.listFiles('boards');
    for (const r of remote) {
      const bid = r.appProperties && r.appProperties.boardId;
      if (bid === key) {
        const data = await adapter.readJSON(r.id);
        if (!data.id) data.id = bid;
        return await applyRemote(null, r, data);
      }
    }
    const want = key.toLowerCase();
    for (const r of remote) {
      let data;
      try { data = await adapter.readJSON(r.id); } catch { continue; }
      if (String(data.name || '').toLowerCase() !== want) continue;
      if (!data.id) data.id = (r.appProperties && r.appProperties.boardId) || r.id;
      return await applyRemote(null, r, data);
    }
    throw bad(`board “${key}” was not found`);
  }
  async function processInbox(notices) {
    if (!buildInboxBoard) return;
    const typeErrorName = (n) => /^ERROR – "type" must be/i.test(n);
    const stripTypeError = (n) => n.replace(/^ERROR – "type" must be.*? – /i, '');
    const files = (await adapter.listFiles('inbox')).filter((f) => !/^ERROR/i.test(f.name) || typeErrorName(f.name)).sort((a, b) => String(a.createdTime || a.name).localeCompare(String(b.createdTime || b.name)));
    if (!files.length) return;
    const remoteIds = new Set((await adapter.listFiles('boards')).map((r) => r.appProperties && r.appProperties.boardId).filter(Boolean));
    const done = new Set(await kv.get('inboxDone', []));
    const typeErr = '"type" must be "new-board", "add-items" or "update-items"';
    for (const f of files) {
      const displayName = typeErrorName(f.name) ? stripTypeError(f.name) : f.name;
      const retryKey = typeErrorName(f.name) ? 'inbox-retry:' + f.id : '';
      try {
        if (retryKey && done.has(retryKey)) continue;
        if (!done.has(f.id)) {
          let d;
          try { d = await adapter.readJSON(f.id); } catch (e) { if (e instanceof SyntaxError) { e.inbox = true; e.message = 'not valid JSON'; } throw e; }
          const bad = (m) => { const e = new Error(m); e.inbox = true; return e; };
          if (!d || typeof d !== 'object' || (d.type !== 'new-board' && d.type !== 'add-items' && d.type !== 'update-items')) throw bad(typeErr);
          if (d.type === 'new-board') {
            if (typeof d.name !== 'string' || !d.name.trim()) throw bad('"name" is required');
            const bid = 'b-inbox-' + String(d.id || f.id).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
            if (!(await db.get('boards', bid)) && !remoteIds.has(bid)) {
              const b = await buildInboxBoard(d, bid);
              const now = Date.now(); Object.assign(b, { createdAt: now, updatedAt: now, dirty: true, deleted: false });
              await db.put('boards', b);
              notices.push(`New board “${b.name}” was created from your Drive inbox.`);
            }
          } else if (d.type === 'add-items') {
            const rawId = d.id != null && String(d.id).trim() ? String(d.id).trim() : '';
            const idem = rawId ? 'add-items:' + rawId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) : '';
            if (!idem || !done.has(idem)) {
              if (!applyInboxItems) throw bad(typeErr);
              const b = await resolveInboxBoard(d.board, bad);
              const added = await applyInboxItems(d, b, f.id);
              if (added && added.length) {
                b.items = (b.items || []).concat(added);
                b.updatedAt = Date.now();
                b.dirty = true;
                await db.put('boards', b);
                onBoardChanged && onBoardChanged(b.id);
                const n = added.length, word = n === 1 ? 'note' : 'notes';
                notices.push(`Added ${n} ${word} to “${b.name}” from your Drive inbox.`);
              }
              if (idem) done.add(idem);
            }
          } else {
            const rawId = d.id != null && String(d.id).trim() ? String(d.id).trim() : '';
            const idem = rawId ? 'update-items:' + rawId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) : '';
            if (!idem || !done.has(idem)) {
              if (!applyInboxUpdates) throw bad(typeErr);
              const b = await resolveInboxBoard(d.board, bad);
              const result = await applyInboxUpdates(d, b, f.id);
              const n = result ? result.patched.length + result.upserted.length : 0;
              if (n) {
                b.updatedAt = Date.now();
                b.dirty = true;
                await db.put('boards', b);
                onBoardChanged && onBoardChanged(b.id);
                const word = n === 1 ? 'note' : 'notes';
                let msg = `Updated ${n} ${word} on “${b.name}” from your Drive inbox.`;
                if (result.missing.length) {
                  const m = result.missing.length;
                  msg += ` ${m} ${m === 1 ? 'item was' : 'items were'} not found and skipped.`;
                }
                notices.push(msg);
              }
              if (idem) done.add(idem);
            }
          }
          done.add(f.id); if (retryKey) done.add(retryKey); await kv.set('inboxDone', [...done].slice(-300));
        }
        await adapter.trash(f.id); // processed: moved to the Drive bin (recoverable for 30 days)
      } catch (e) {
        if (!e.inbox) throw e; // network / auth problems: retry on the next sync
        if (retryKey) { done.add(retryKey); await kv.set('inboxDone', [...done].slice(-300)); }
        try { await adapter.renameFile(f.id, `ERROR – ${e.message} – ${displayName}`.slice(0, 250)); } catch { /* ignore */ }
        notices.push(`Drive inbox: “${displayName}” was skipped: ${e.message}. It was renamed “ERROR – …” – fix it and upload it again.`);
      }
    }
  }

  // The Drive folder was replaced (e.g. deleted/trashed): re-upload everything from this device.
  async function relinkEverything(notices) {
    for (const b of await db.all('boards')) { delete b.driveFileId; delete b.driveModifiedTime; b.dirty = true; await db.put('boards', b); }
    for (const t of await db.all('templates')) { t.driveFileId = null; t.dirty = true; await db.put('templates', t); }
    for (const bl of await db.all('blobs')) { if (bl.blob && !bl.external) { bl.driveId = null; await db.put('blobs', bl); } }
    notices.push('Your Drive “Whiteboard” folder was missing, so a new one was set up and your boards from this device were uploaded to it.');
  }

  async function doSync() {
    const s = status();
    if (s) { onStatus(s); return { skipped: s }; }
    onStatus('syncing');
    const notices = [];
    try {
      await adapter.ensureReady();
      if (adapter.consumeRootChanged && adapter.consumeRootChanged()) await relinkEverything(notices);
      await pushImages(notices);
      await processInbox(notices);
      await syncBoards(notices);
      await syncTemplates();
      await kv.set('lastSync', Date.now());
      onStatus('synced');
      notices.forEach((n) => onNotice(n));
      onBoardsListChanged && onBoardsListChanged();
      return { ok: true, notices };
    } catch (e) {
      console.error('sync failed', e);
      onStatus(e.name === 'AuthError' || /Signed out|Session expired/.test(e.message) ? 'signin' : (navigator.onLine ? 'error' : 'offline'), e.message);
      return { error: e.message };
    }
  }

  function syncNow() {
    if (running) { again = true; return running; }
    running = doSync().finally(() => {
      running = null;
      if (again) { again = false; setTimeout(syncNow, 50); }
    });
    return running;
  }
  function schedule(ms = 2500) { clearTimeout(timer); timer = setTimeout(syncNow, ms); }

  return { syncNow, schedule, status, saveVersion: (b, reason = 'manual') => saveVersion(b.id, boardPayload(b), reason), listVersions, boardPayload, isRunning: () => !!running };
}
