'use strict';
// The phone's own copy of the log (IndexedDB), so the app works away from home.
//   events: every entry, keyed by uid (deleted ones keep deleted_at so they stay deleted)
//   outbox: changes made on this phone that the home server hasn't seen yet, in order
//   meta:   who is signed in, the last server rev pulled, the baby profile, lastSyncAt

const Store = (() => {
  let dbp = null;
  function open() {
    dbp ??= new Promise((resolve, reject) => {
      const r = indexedDB.open('baby-log', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('events', { keyPath: 'uid' });
        d.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
        d.createObjectStore('meta');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return dbp;
  }

  // Run fn(stores) inside one transaction; resolves with fn's result once it commits.
  async function tx(names, mode, fn) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const t = d.transaction(names, mode);
      const stores = Object.fromEntries(names.map((n) => [n, t.objectStore(n)]));
      let result;
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
      result = fn(stores);
    });
  }
  // Collect a request's result into an object filled in when the transaction completes.
  const into = (req, box, key) => { req.onsuccess = () => { box[key] = req.result; }; };

  async function getMeta(key) {
    const box = {};
    await tx(['meta'], 'readonly', (s) => into(s.meta.get(key), box, 'v'));
    return box.v ?? null;
  }
  const setMeta = (key, value) => tx(['meta'], 'readwrite', (s) => { s.meta.put(value, key); });

  async function allEvents() {
    const box = {};
    await tx(['events'], 'readonly', (s) => into(s.events.getAll(), box, 'v'));
    return box.v || [];
  }

  // Save a change on this phone and queue it for the home server, atomically.
  const saveLocal = (row, op) => tx(['events', 'outbox'], 'readwrite', (s) => {
    s.events.put(row);
    s.outbox.add({ op, at: Date.now() });
  });

  async function outbox(limit = 500) {
    const box = {};
    await tx(['outbox'], 'readonly', (s) => into(s.outbox.getAll(null, limit), box, 'v'));
    return box.v || [];
  }
  async function outboxCount() {
    const box = {};
    await tx(['outbox'], 'readonly', (s) => into(s.outbox.count(), box, 'v'));
    return box.v || 0;
  }
  const ack = (seqs) => tx(['outbox'], 'readwrite', (s) => { for (const q of seqs) s.outbox.delete(q); });

  // Server rows replace local ones, except where this phone has a change still waiting to go up
  // (that change wins when it's sent, and the server's copy comes back on the next pull).
  async function mergeRemote(rows, rev, profile) {
    const pending = new Set((await outbox(100000)).map((o) => o.op.uid));
    await tx(['events', 'meta'], 'readwrite', (s) => {
      for (const r of rows) if (!pending.has(r.uid)) s.events.put(r);
      s.meta.put(rev, 'rev');
      if (profile) s.meta.put(profile, 'profile');
    });
  }

  // The server refused a change: put back its copy, or drop the entry if it never existed there.
  const revert = (uid, current) => tx(['events'], 'readwrite', (s) => {
    if (current) s.events.put(current);
    else s.events.delete(uid);
  });

  return { getMeta, setMeta, allEvents, saveLocal, outbox, outboxCount, ack, mergeRemote, revert };
})();
