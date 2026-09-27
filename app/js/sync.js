/* Two-way sync with one Notion database: text, deletions, and properties.
   Only one tab syncs (the leader, picked with Web Locks): the one you're looking at. Other
   tabs see the leader's work, and hand it theirs, through localStorage. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};
  const { Store, Notion, NotionMap: M } = TDW;

  const TICK_MS = 5000;
  const EDIT_MS = 1200;
  const PROP_MS = 400;
  const FULL_EVERY = 12;
  const LOCK = 'tdw-sync';
  const CLAIM_MS = 30000;   // how often a hidden tab checks whether anyone syncs at all
  const PASS_MS = 300;      // after its last save, how long a tab waits before passing the lock on

  let hooks = {};
  let started = false;
  let leader = false;
  let releaseLock = null;
  let tickTimer = 0;
  let ticking = false;
  let tickCount = 0;
  let lastFull = 0;
  let flushing = null;
  let trashing = null;
  let st = { state: 'off', message: '', at: 0 };

  const entriesCache = new Map(); // notionId -> entries: what Notion has, line by line
  const pages = new Map();        // notionId -> the last page object seen
  const pushTimers = new Map();   // draftId -> timer
  const pushing = new Map();      // draftId -> promise
  const again = new Set();        // drafts edited while their push ran
  const propTimers = new Map();   // draftId -> timer
  const propNames = new Map();    // draftId -> Set of names, or null for all
  const running = new Set();      // Notion work in flight; the lock isn't passed on until it's done

  const cfg = () => Store.getNotionConfig();
  const isConnected = () => !!Store.getNotionToken() && !!(cfg() && cfg().dataSourceId);
  const call = (name, ...args) => (typeof hooks[name] === 'function' ? hooks[name](...args) : undefined);
  const hasContent = (d) => !!(d.text.trim() || d.title.trim());
  const alive = (d) => Store.getDraft(d.id) === d;
  const plain = (rich) => (Array.isArray(rich) ? rich : []).map((r) => r.plain_text || (r.text && r.text.content) || '').join('').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const locks = () => !!(navigator.locks && navigator.locks.request);

  function track(p) {
    running.add(p);
    const done = () => running.delete(p);
    p.then(done, done);
    return p;
  }

  function report(state, message) {
    st = { state, message: message || '', at: state === 'synced' ? Date.now() : st.at };
    call('onStatus', Object.assign({}, st));
  }

  function fail(e) {
    if (e && e.code === 'offline') report('offline', "Can't reach Notion.");
    else report('error', (e && e.message) || 'Something went wrong.');
  }

  /* ---------- Connecting ---------- */

  // The last 32-hex run (or dashed UUID) in the link's path. A "?v=" view id is not the database.
  function parseDatabaseId(link) {
    let s = String(link || '').trim();
    try { s = new URL(s).pathname; } catch (_) { /* not a URL: a bare id */ }
    const re = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}/gi;
    let m, last = null;
    while ((m = re.exec(s))) last = m[0];
    return last ? last.replace(/-/g, '').toLowerCase() : null;
  }

  function buildSchema(properties) {
    const schema = {};
    let titleProp = null;
    for (const name of Object.keys(properties || {})) {
      const p = properties[name];
      if (!p || typeof p.type !== 'string') continue;
      const entry = { type: p.type };
      const body = p[p.type] || {};
      if (p.type === 'select' || p.type === 'status' || p.type === 'multi_select') {
        const opts = (Array.isArray(body.options) ? body.options : []).filter((o) => o && typeof o.name === 'string');
        entry.options = opts.map((o) => o.name);
        entry.colors = {};
        for (const o of opts) if (typeof o.color === 'string') entry.colors[o.name] = o.color;
      }
      if (p.type === 'status') {
        const names = new Map((body.options || []).map((o) => [o.id, o.name]));
        const todo = (body.groups || []).find((g) => /^to[\s_-]?do$/i.test((g && g.name) || ''));
        const first = todo && (todo.option_ids || []).map((id) => names.get(id)).find(Boolean);
        entry.defaultStatus = first || entry.options[0] || null;
      }
      if (p.type === 'title' && !titleProp) titleProp = name;
      schema[name] = entry;
    }
    return { schema, titleProp };
  }

  function connectError(e) {
    const code = e && e.code;
    if (code === 'unauthorized') return 'Notion rejected the secret. Copy it again from notion.so/profile/integrations.';
    if (code === 'not_found') return "Notion can't see that database. In Notion, open it, click ••• → Connections, and add your integration.";
    if (code === 'offline') return "Can't reach Notion. Check your internet and try again.";
    return 'Something went wrong: ' + ((e && e.message) || 'unknown error');
  }

  async function connect(token, link, opts) {
    const databaseId = parseDatabaseId(link);
    if (!databaseId) throw new Error('That link has no database ID. Copy the database link from Notion.');
    const secret = String(token || '').trim();
    if (!secret) throw new Error('Paste the integration secret first.');
    const wasConnected = isConnected();
    const oldToken = Store.getNotionToken();
    stop();
    Store.setNotionToken(secret);
    let db, ds, dsId;
    try {
      db = await Notion.getDatabase(databaseId);
      dsId = Array.isArray(db.data_sources) && db.data_sources[0] ? db.data_sources[0].id : null;
      if (!dsId) throw { code: 'validation', message: 'That database has no data source to sync.' };
      ds = await Notion.getDataSource(dsId);
    } catch (e) {
      if (wasConnected) { Store.setNotionToken(oldToken); start(); } else Store.clearNotionToken();
      throw new Error(connectError(e));
    }
    const { schema, titleProp } = buildSchema(ds.properties);
    const dbTitle = plain(db.title) || plain(ds.title) || 'your database';
    const prev = cfg();
    // Config first: other tabs clear their links when they see the database change.
    Store.setNotionConfig({ databaseId, dataSourceId: dsId, dbTitle, titleProp, schema });
    if (prev && prev.databaseId && prev.databaseId !== databaseId) {
      entriesCache.clear();
      pages.clear();
      for (const d of Store.listDrafts()) {
        if (d.notionId || d.url || d.remoteTitle) { Store.unlink(d); Store.saveDraft(d); }
      }
    }
    const localOnly = !(opts && opts.uploadLocal);
    for (const d of Store.listDrafts()) {
      if (d.notionId || !hasContent(d) || d.localOnly === localOnly) continue;
      d.localOnly = localOnly;
      Store.saveDraft(d);
    }
    let n = 0;
    try { n = await fullSync(); } catch (e) { fail(e); }
    start();
    return { title: dbTitle, pages: n };
  }

  function disconnect() {
    stop();
    const c = cfg();
    Store.clearNotionToken();
    // Keep only the database id, so a later connect can tell whether the database changed.
    Store.setNotionConfig(c && c.databaseId ? { databaseId: c.databaseId } : null);
    entriesCache.clear();
    pages.clear();
    report('off');
    call('onList');
  }

  /* ---------- Reading from Notion ---------- */

  // Page → draft. Returns true when the draft changed.
  function upsert(page) {
    if (!page || typeof page.id !== 'string' || (page.object && page.object !== 'page') || page.in_trash || page.is_archived) return false;
    if (Store.pageMarked(page.id, 'trashed') || Store.getNotionTrash().includes(page.id)) return false;
    pages.set(page.id, page);
    const c = cfg();
    const props = page.properties || {};
    const edited = Date.parse(page.last_edited_time) || 0;
    let d = Store.findByNotionId(page.id);
    const created = !d;
    if (!d) {
      const s = Store.getSettings();
      const f = TDW.Formats.get(s.defaultFormat);
      d = Store.newDraft({
        notionId: page.id, format: f.key, budget: TDW.Formats.budgetOf(f, s),
        createdAt: Date.parse(page.created_time) || edited || Date.now(), updatedAt: edited || Date.now()
      });
    }
    const before = JSON.stringify([d.title, d.props, d.remoteTitle, d.url, d.updatedAt]);
    const title = c.titleProp ? String(M.propFromNotion(props[c.titleProp]) || '') : '';
    if (!d.propsDirty) {
      const next = {};
      for (const name of Object.keys(c.schema || {})) {
        if (name !== c.titleProp && props[name]) next[name] = M.propFromNotion(props[name]);
      }
      d.props = next;
    }
    // Take the Notion title only when it changed there, so a title typed here isn't undone.
    if (title !== d.remoteTitle) d.title = title;
    d.remoteTitle = title;
    if (typeof page.url === 'string') d.url = page.url;
    d.updatedAt = Math.max(d.updatedAt, edited);
    if (!created && JSON.stringify([d.title, d.props, d.remoteTitle, d.url, d.updatedAt]) === before) return false;
    Store.saveDraft(d);
    return true;
  }

  function removeLocal(d) {
    clearTimeout(pushTimers.get(d.id));
    pushTimers.delete(d.id);
    clearTimeout(propTimers.get(d.id));
    propTimers.delete(d.id);
    propNames.delete(d.id);
    if (d.notionId) { entriesCache.delete(d.notionId); pages.delete(d.notionId); }
    Store.deleteDraft(d.id);
    call('onRemoteDelete', d);
  }

  // Push what's waiting: new drafts with text, unpushed edits, unpushed properties.
  function queueLocal() {
    if (!leader) return;
    for (const d of Store.listDrafts()) {
      if (d.localOnly) continue;
      if (!pushing.has(d.id) && !pushTimers.has(d.id) && (d.notionId ? d.dirty : hasContent(d))) schedulePush(d.id, 0);
      if (d.notionId && d.propsDirty && !propTimers.has(d.id)) scheduleProps(d.id, null);
    }
  }

  // Options added or renamed in Notion show up here too.
  async function refreshSchema(c) {
    try {
      const ds = await Notion.getDataSource(c.dataSourceId);
      const { schema, titleProp } = buildSchema(ds.properties);
      const now = cfg();
      if (!now || now.dataSourceId !== c.dataSourceId) return;
      if (JSON.stringify(schema) === JSON.stringify(now.schema) && titleProp === now.titleProp) return;
      Store.setNotionConfig(Object.assign({}, now, { schema, titleProp }));
      call('onList');
    } catch (e) {
      if (e && e.code === 'offline') throw e;
    }
  }

  async function fullSync() {
    const c = cfg();
    if (!c || !c.dataSourceId) return 0;
    await refreshSchema(c);
    const linkedBefore = new Set(Store.listDrafts().filter((d) => d.notionId).map((d) => d.notionId));
    const list = await Notion.queryAll(c.dataSourceId);
    lastFull = Date.now();
    const remote = new Set();
    let changed = false;
    for (const p of list) {
      remote.add(p.id);
      if (upsert(p)) changed = true;
    }
    // Gone from Notion: removed there, so remove it here too.
    for (const d of Store.listDrafts()) {
      if (!d.notionId || d.localOnly || remote.has(d.notionId) || !linkedBefore.has(d.notionId)) continue;
      if (pushing.has(d.id) || Store.pageMarked(d.notionId, 'restored')) continue;
      removeLocal(d);
      changed = true;
    }
    if (changed) call('onList');
    queueLocal();
    return list.length;
  }

  // Notion rounds last_edited_time down to the minute; the last clause catches an edit made
  // in the same minute as the last fetch.
  function needsContent(d, page) {
    return !d.contentFetchedAt || page.last_edited_time !== d.contentEditedAt ||
      Date.parse(page.last_edited_time) >= Math.floor(d.contentFetchedAt / 60000) * 60000;
  }

  async function pull(d, page) {
    const entries = M.blocksToEntries(await Notion.listChildren(d.notionId));
    entriesCache.set(d.notionId, entries);
    if (!alive(d)) return;
    const text = M.entriesToText(entries);
    d.contentFetchedAt = Date.now();
    d.contentEditedAt = page.last_edited_time || null;
    const apply = !d.dirty && !pushing.has(d.id) && text !== d.text && !M.sameContent(entries, d.text.split('\n'));
    if (apply) d.text = text;
    Store.saveDraft(d);
    if (apply) call('onRemoteText', d);
  }

  async function tick() {
    if (ticking || !leader || !isConnected() || document.visibilityState === 'hidden') return;
    if (navigator.onLine === false) { report('offline', "You're offline."); return; }
    ticking = true;
    try {
      await flushTrash();
      const c = cfg();
      const res = await Notion.query(c.dataSourceId, { page_size: 25 });
      const results = Array.isArray(res.results) ? res.results : [];
      let changed = false;
      for (const p of results) if (upsert(p)) changed = true;
      if (changed) call('onList');

      const d = call('current');
      if (d && d.notionId && !d.localOnly && alive(d)) {
        let page = results.find((p) => p.id === d.notionId) || null;
        if (!page) {
          try { page = await Notion.getPage(d.notionId); } catch (e) {
            if (e.code !== 'not_found') throw e;
            page = { id: d.notionId, in_trash: true };
          }
        }
        if (page.in_trash || page.is_archived) {
          if (!Store.pageMarked(d.notionId, 'restored') && alive(d)) removeLocal(d);
        } else {
          pages.set(page.id, page);
          if (!d.dirty && !pushing.has(d.id) && needsContent(d, page)) await pull(d, page);
        }
      }
      tickCount++;
      if (tickCount % FULL_EVERY === 0) await fullSync();
      else queueLocal();
      if (!pushing.size) report('synced');
    } catch (e) {
      fail(e);
    } finally {
      ticking = false;
    }
  }

  // One timer chain: every path clears the old timer before it sets a new one.
  function runTick() {
    clearTimeout(tickTimer);
    if (ticking || !leader) return;
    track(tick()).finally(() => {
      clearTimeout(tickTimer);
      if (leader && document.visibilityState !== 'hidden') tickTimer = setTimeout(runTick, TICK_MS);
    });
  }

  /* ---------- Writing to Notion ---------- */

  function toBlock(line) {
    const spec = M.lineToSpec(line);
    return M.blockPayload(spec, M.richFromMd(spec.text));
  }

  function statusProp(c) {
    return Object.keys(c.schema || {}).find((n) => c.schema[n].type === 'status') || null;
  }

  function pageProps(d, c, title) {
    const out = {};
    if (c.titleProp) out[c.titleProp] = M.propToNotion('title', title);
    for (const name of Object.keys(c.schema || {})) {
      const s = c.schema[name];
      if (name === c.titleProp || !M.EDITABLE.has(s.type)) continue;
      const v = d.props[name];
      if (s.type === 'status' && (v == null || v === '')) {
        if (s.defaultStatus) out[name] = { status: { name: s.defaultStatus } };
        continue;
      }
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
      const body = M.propToNotion(s.type, v);
      if (body) out[name] = body;
    }
    return out;
  }

  function queueTrash(notionId) {
    const list = Store.getNotionTrash();
    if (!list.includes(notionId)) { list.push(notionId); Store.setNotionTrash(list); }
    Store.markPage(notionId, 'trashed');
    flushTrash().catch(fail);
  }

  async function create(d, c, lines) {
    if (!hasContent(d)) return; // empty drafts are never uploaded
    const blocks = lines.filter((l) => !M.looksOpaque(l)).map(toBlock);
    const title = Store.displayTitle(d);
    const page = await Notion.createPage({
      parent: { type: 'data_source_id', data_source_id: c.dataSourceId },
      properties: pageProps(d, c, title),
      children: blocks.slice(0, 100)
    });
    if (!alive(d)) { queueTrash(page.id); return; } // deleted here while Notion was creating it
    d.notionId = page.id;
    d.url = typeof page.url === 'string' ? page.url : null;
    d.remoteTitle = title;
    d.propsDirty = false;
    const sp = statusProp(c);
    if (sp && !d.props[sp] && c.schema[sp].defaultStatus) d.props[sp] = c.schema[sp].defaultStatus;
    pages.set(page.id, page);
    Store.saveDraft(d); // save the link at once, so a retry can never create a second page
    if (blocks.length > 100) {
      const first = await Notion.listChildren(page.id);
      let after = first.length ? first[first.length - 1].id : null;
      for (let k = 100; k < blocks.length; k += 100) {
        const made = await Notion.appendChildren(page.id, blocks.slice(k, k + 100), after);
        if (made.length) after = made[made.length - 1].id;
      }
    }
    entriesCache.set(page.id, M.blocksToEntries(await Notion.listChildren(page.id)));
  }

  async function update(d, c, lines) {
    const id = d.notionId;
    try {
      let entries = entriesCache.get(id) || M.blocksToEntries(await Notion.listChildren(id));
      try {
        entries = await M.applyOps(id, entries, lines, M.planOps(entries, lines), Notion.api);
      } catch (e) {
        if (!e || !['not_found', 'validation', 'conflict'].includes(e.code)) throw e;
        entries = M.blocksToEntries(await Notion.listChildren(id));
        entries = await M.applyOps(id, entries, lines, M.planOps(entries, lines), Notion.api);
      }
      entriesCache.set(id, entries);
    } catch (e) {
      entriesCache.delete(id); // some ops may have landed; refetch next time
      throw e;
    }
    const title = Store.displayTitle(d);
    if (c.titleProp && title !== d.remoteTitle) {
      await Notion.updatePage(id, { properties: { [c.titleProp]: M.propToNotion('title', title) } });
      d.remoteTitle = title;
    }
  }

  async function pushOnce(d) {
    const c = cfg();
    const text = d.text;
    const lines = text.split('\n');
    if (!d.notionId) await create(d, c, lines);
    else await update(d, c, lines);
    if (!alive(d)) return;
    if (d.text === text) d.dirty = false;
    d.contentFetchedAt = Date.now();
    Store.saveDraft(d);
  }

  function schedulePush(id, ms) {
    clearTimeout(pushTimers.get(id));
    pushTimers.set(id, setTimeout(() => { pushTimers.delete(id); push(id); }, ms == null ? EDIT_MS : ms));
  }

  // One push per draft at a time; edits that land meanwhile get pushed right after.
  function push(id) {
    const d = Store.getDraft(id);
    if (!d || d.localOnly || !leader || !isConnected()) return Promise.resolve();
    if (pushing.has(id)) { again.add(id); return pushing.get(id); }
    let done;
    const p = new Promise((r) => { done = r; });
    pushing.set(id, p);
    report('syncing');
    (async () => {
      try {
        do {
          again.delete(id);
          await pushOnce(d);
        } while (again.has(id) && alive(d));
        pushing.delete(id);
        if (!pushing.size) report('synced');
      } catch (e) {
        pushing.delete(id);
        fail(e);
      } finally {
        done();
      }
    })();
    return p;
  }

  function scheduleProps(id, name) {
    const cur = propNames.get(id);
    if (!name) propNames.set(id, null);
    else if (cur !== null) propNames.set(id, (cur || new Set()).add(name));
    clearTimeout(propTimers.get(id));
    propTimers.set(id, setTimeout(() => { propTimers.delete(id); track(pushProps(id)); }, PROP_MS));
  }

  async function pushProps(id) {
    const d = Store.getDraft(id);
    const names = propNames.get(id);
    propNames.delete(id);
    if (!d || !d.notionId || d.localOnly || !leader || !isConnected()) return;
    const c = cfg();
    const body = {};
    for (const name of names ? [...names] : Object.keys(c.schema || {})) {
      const s = c.schema[name];
      if (!s || name === c.titleProp || !M.EDITABLE.has(s.type)) continue;
      const b = M.propToNotion(s.type, d.props[name]);
      if (b) body[name] = b;
    }
    const settle = () => {
      if (alive(d) && !propNames.has(id) && !propTimers.has(id)) { d.propsDirty = false; Store.saveDraft(d); }
    };
    report('syncing');
    try {
      if (Object.keys(body).length) {
        const page = await Notion.updatePage(d.notionId, { properties: body });
        if (page && page.id) pages.set(page.id, page);
      }
      settle();
      if (!pushing.size) report('synced');
    } catch (e) {
      if (e && e.code === 'validation') settle(); // Notion won't take it: keep Notion's value
      fail(e);
    }
  }

  function noteEdit(id) {
    const d = Store.getDraft(id);
    if (!d || d.localOnly || !isConnected()) return;
    if (!d.dirty) { d.dirty = true; Store.saveDraft(d); }
    if (leader) schedulePush(id);
  }

  function noteProp(id, name) {
    const d = Store.getDraft(id);
    if (!d || d.localOnly || !isConnected()) return;
    d.propsDirty = true;
    Store.saveDraft(d);
    if (!leader) return;
    if (!d.notionId) { if (hasContent(d)) schedulePush(id, 0); return; } // properties go in with the new page
    scheduleProps(id, name);
  }

  // Before a linked draft opens: fetch its text if we never have, or if Notion has a newer version.
  async function prepare(d) {
    if (!d || !d.notionId || d.localOnly || d.dirty || !isConnected()) return;
    const known = pages.get(d.notionId);
    if (d.contentFetchedAt && (!known || !needsContent(d, known))) return;
    call('onLoading', true);
    try {
      const page = known || await Notion.getPage(d.notionId);
      if (page.in_trash || page.is_archived) { if (alive(d)) removeLocal(d); return; }
      pages.set(page.id, page);
      await pull(d, page);
    } catch (e) {
      if (e && e.code === 'not_found' && alive(d)) removeLocal(d);
      else fail(e); // offline: open the text we have
    } finally {
      call('onLoading', false);
    }
  }

  /* ---------- Deleting ---------- */

  async function sendTrash() {
    for (;;) {
      const list = Store.getNotionTrash();
      if (!list.length || !isConnected()) return;
      trashing = list[0];
      try { await Notion.trashPage(trashing); } catch (e) {
        if (e.code !== 'not_found' && e.code !== 'validation') throw e;
      }
      const done = trashing;
      Store.setNotionTrash(Store.getNotionTrash().filter((x) => x !== done));
      entriesCache.delete(done);
      pages.delete(done);
    }
  }

  // .finally runs after the assignment, even when there is nothing to send.
  function flushTrash() {
    if (!flushing) flushing = sendTrash().finally(() => { trashing = null; flushing = null; });
    return flushing;
  }

  function trash(d) {
    if (!d || !d.notionId || !isConnected()) return;
    queueTrash(d.notionId);
  }

  async function restore(d) {
    if (!d || !d.notionId) return;
    const id = d.notionId;
    Store.markPage(id, 'restored');
    if (trashing === id && flushing) await flushing.catch(() => {});
    const list = Store.getNotionTrash();
    if (list.includes(id)) { Store.setNotionTrash(list.filter((x) => x !== id)); return; } // never sent
    if (!isConnected()) return;
    try {
      const page = await Notion.restorePage(id);
      if (page && page.id) pages.set(page.id, page);
    } catch (e) {
      fail(e);
    }
  }

  /* ---------- Leader tab ----------
     One tab holds the Web Lock and syncs: the one you're looking at. Only a tab you can see
     waits in line for the lock, and a hidden leader passes it on when one does (or when the
     waiting tab has focus and the leader doesn't). Before it lets go, the leader finishes every
     push it started, so two tabs never write to Notion at once. A hidden tab doesn't wait in
     line, but checks now and then whether anyone syncs at all, so edits still go out after the
     syncing tab is closed. Without Web Locks every tab syncs. */

  let queued = null;   // this tab's place in line for the lock
  let handing = false; // still leading, but finishing up to pass the lock on
  let claimTimer = 0;
  let term = 0;        // counts leads and stops, so a finished hand-off can tell it's out of date

  const hidden = () => document.visibilityState === 'hidden';

  function lead() {
    if (!started) return null;
    leader = true;
    term++;
    clearTimeout(claimTimer);
    // Another tab may have changed these pages since this tab last led.
    entriesCache.clear();
    pages.clear();
    return new Promise((resolve) => {
      releaseLock = resolve;
      report('syncing');
      const first = Date.now() - lastFull > 30000 ? fullSync() : Promise.resolve(queueLocal());
      track(first).then(() => { if (!pushing.size) report('synced'); }, fail).then(() => {
        runTick();
        if (hidden()) passOn(null);
      });
    });
  }

  // Wait in line for the lock. Only a tab you can see does, so the lock never goes to a hidden one.
  function queue() {
    if (!started || leader || queued || !locks() || hidden()) return;
    clearTimeout(claimTimer);
    const ctrl = new AbortController();
    queued = ctrl;
    navigator.locks.request(LOCK, { signal: ctrl.signal }, () => {
      if (queued === ctrl) queued = null;
      return lead();
    }).catch(() => { if (queued === ctrl) queued = null; });
  }

  function unqueue() {
    if (queued) { queued.abort(); queued = null; }
  }

  // Tell the syncing tab this one came to the front. The query answers after the lock manager
  // has this tab's place in line, so the leader finds it waiting.
  function want() {
    if (!started || leader || !queued || !navigator.locks.query) return;
    navigator.locks.query().catch(() => null).then(() => {
      if (queued) Store.setSyncWant({ at: Date.now(), focus: document.hasFocus() });
    });
  }

  // quick: how many more tries a second apart, after the syncing tab said it was closing.
  function claimLater(ms, quick) {
    clearTimeout(claimTimer);
    if (!started || leader || !locks()) return;
    claimTimer = setTimeout(() => {
      if (!started || leader || queued) return;
      if (!hidden()) { queue(); return; }
      navigator.locks.request(LOCK, { ifAvailable: true }, (lock) => (lock ? lead() : null))
        .catch(() => {})
        .then(() => { if (!leader) claimLater(quick > 0 ? 1000 : CLAIM_MS, quick - 1); });
    }, ms == null ? CLAIM_MS : ms);
  }

  function follow() {
    report('other-tab');
    if (hidden()) claimLater(); else queue();
  }

  // Pass the lock on if a tab you can see is waiting and this one is behind it: hidden, or
  // without focus while the waiting tab has it.
  async function passOn(wanter) {
    if (!leader || handing || !navigator.locks || !navigator.locks.query) return;
    for (let k = 0; k < 2; k++) {
      if (!leader || handing) return;
      if (!hidden() && !(wanter && wanter.focus && !document.hasFocus())) return;
      let q = null;
      try { q = await navigator.locks.query(); } catch (_) { return; }
      if ((q.pending || []).some((l) => l.name === LOCK)) { handOff(); return; }
      await sleep(500);
    }
  }

  async function handOff() {
    if (!leader || handing) return;
    handing = true;
    leader = false; // nothing new starts from here on
    const mine = term;
    clearTimeout(tickTimer);
    // Drafts waiting to go out stay marked in storage; the next leader sends them.
    for (const t of pushTimers.values()) clearTimeout(t);
    pushTimers.clear();
    for (const t of propTimers.values()) clearTimeout(t);
    propTimers.clear();
    propNames.clear();
    while (running.size || pushing.size || flushing) {
      await Promise.allSettled([...running, ...pushing.values(), flushing]);
    }
    await sleep(PASS_MS); // let the last saves reach the other tabs before they lead
    handing = false;
    if (mine !== term) return; // stopped, or leading again, meanwhile
    const release = releaseLock;
    releaseLock = null;
    if (release) release();
    if (started) follow();
  }

  function start() {
    if (started || !isConnected()) return;
    started = true;
    if (!locks()) { lead(); return; }
    navigator.locks.request(LOCK, { ifAvailable: true }, (lock) => {
      if (lock) return lead();
      if (started) { follow(); want(); }
      return null;
    }).catch(() => {});
  }

  function stop() {
    started = false;
    leader = false;
    term++;
    clearTimeout(tickTimer);
    clearTimeout(claimTimer);
    for (const t of pushTimers.values()) clearTimeout(t);
    pushTimers.clear();
    for (const t of propTimers.values()) clearTimeout(t);
    propTimers.clear();
    unqueue();
    if (releaseLock) { releaseLock(); releaseLock = null; }
  }

  // Another tab saved a draft, connected or disconnected, or came to the front.
  function onExternal(ch) {
    if (ch.key === 'tdw.notion' || ch.key === 'tdw.notionToken') {
      if (isConnected()) start();
      else if (started) { stop(); report('off'); }
      call('onList');
      return;
    }
    if (ch.key === 'tdw.syncWant') {
      let w = null;
      try { w = JSON.parse(ch.value); } catch (_) { /* not ours */ }
      if (w && w.bye) { if (started && !leader && !queued) claimLater(300, 5); } else passOn(w);
      return;
    }
    const d = ch.draft;
    if (!d || !leader || d.localOnly) return;
    if (d.dirty && (d.notionId || hasContent(d))) schedulePush(d.id);
    if (d.notionId && d.propsDirty && !propTimers.has(d.id)) scheduleProps(d.id, null);
  }

  function init(h) {
    hooks = h || {};
    document.addEventListener('visibilitychange', () => {
      if (leader) {
        if (hidden()) { clearTimeout(tickTimer); passOn(null); } else runTick();
        return;
      }
      if (!started || !locks()) return;
      if (hidden()) { unqueue(); claimLater(); } else { queue(); want(); }
    });
    window.addEventListener('focus', () => {
      if (!started || leader || !locks()) return;
      queue();
      want();
    });
    // Closing: hidden tabs don't wait in line, so tell them the lock is about to be free.
    window.addEventListener('pagehide', () => { if (leader && locks()) Store.setSyncWant({ at: Date.now(), bye: true }); });
    window.addEventListener('online', () => { if (leader) runTick(); });
    window.addEventListener('offline', () => { if (started) report('offline', "You're offline."); });
    Store.onExternal(onExternal);
  }

  TDW.Sync = {
    init, connect, disconnect, isConnected, start, stop, noteEdit, noteProp, prepare, trash, restore,
    status: () => Object.assign({}, st),
    config: () => (isConnected() ? cfg() : null)
  };
})();
