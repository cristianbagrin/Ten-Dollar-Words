/* Your account. Sign in once in each browser, and what you set up follows you: the Notion secret
   and database, the Gemini key and model, your settings and dictionary, and each Notion draft's
   format, budget, message and backspace switch (Notion doesn't keep those).
   The account is one document of fields (see vault.js), encrypted here with a key made from your
   password, so the server can't read it. This browser keeps its copy in localStorage['tdw.account']
   with the key; a change here is stamped, saved, and sent a moment later. Another device's changes
   arrive when the app comes to the front, and every 5 minutes. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};
  const { Store, Vault } = TDW;

  const API = '/api/account/';
  const PUSH_MS = 1500;
  const RETRY_MS = 30000;
  const POLL_MS = 5 * 60e3;
  const PULL_GAP_MS = 15e3;
  const LOCK = 'tdw-account';
  const SYNCED = new Set(['tdw.settings', 'tdw.geminiKey', 'tdw.geminiModel', 'tdw.geminiModelMode', 'tdw.notionToken', 'tdw.notion']);

  let hooks = {};
  let applying = false;
  let holds = 0;
  let noteQueued = false;
  let pushTimer = 0;
  let pollTimer = 0;
  let lastPull = 0;
  let status = { state: 'idle', message: '' };
  let peeked = null;
  const listeners = [];

  const call = (name, ...args) => (typeof hooks[name] === 'function' ? hooks[name](...args) : undefined);
  const read = () => Store.getAccount();
  const signedIn = () => !!read();
  const err = (code, message) => Object.assign(new Error(message), { code });

  function write(acc) {
    peeked = null;
    Store.setAccount(acc);
    emit();
  }

  // A read-only copy for lookups that happen often (every page in a full Notion sync).
  function peek() {
    if (!peeked) peeked = { acc: read() };
    return peeked.acc;
  }

  function emit() {
    for (const fn of listeners) {
      try { fn(); } catch (e) { setTimeout(() => { throw e; }); }
    }
  }

  function setStatus(state, message) {
    status = { state, message: message || '' };
    emit();
  }

  /* ---------- This browser's values as fields ---------- */

  const metaOf = (d) => ({ f: d.format, b: d.budget, i: d.intent || '', nb: typeof d.nb === 'boolean' ? d.nb : null });

  // What this browser has stored. Settings count only once they've been saved here.
  function localFields() {
    const out = {};
    const s = Store.getStoredSettings();
    if (s) {
      for (const k of Object.keys(Store.DEFAULTS)) if (k !== 'dictionary' && k in s) out['set.' + k] = s[k];
      for (const w of Array.isArray(s.dictionary) ? s.dictionary : []) if (typeof w === 'string' && w) out['dict.' + w.toLowerCase()] = w;
    }
    out['ai.key'] = Store.getKey() || null;
    out['ai.model'] = Store.getModel() || null;
    out['ai.mode'] = Store.getModelMode();
    out['notion.token'] = Store.getNotionToken() || null;
    out['notion.config'] = Store.getNotionConfig() || null;
    return { out, hasSettings: !!s };
  }

  // Everything here, stamped `at`: now for a new account, 0 when signing in (so the account wins).
  function snapshot(at) {
    const fields = {};
    const { out } = localFields();
    for (const n of Object.keys(out)) if (out[n] != null) fields[n] = { v: out[n], at };
    for (const d of Store.listDrafts()) if (d.notionId && !d.localOnly) fields['draft.' + d.notionId] = { v: metaOf(d), at };
    return fields;
  }

  function touched(acc) {
    acc.seq = (acc.seq || 0) + 1;
    acc.dirty = true;
    write(acc);
    pushSoon();
  }

  // A synced value changed here: stamp it. A new stamp always beats the one it replaces, even
  // when another device's clock runs ahead.
  function noteLocal() {
    noteQueued = false;
    if (applying || holds) return;
    const acc = read();
    if (!acc) return;
    const { out, hasSettings } = localFields();
    if (hasSettings) {
      for (const n of Object.keys(acc.fields)) if (n.startsWith('dict.') && acc.fields[n].v != null && !(n in out)) out[n] = null;
    }
    const t = Date.now();
    let changed = false;
    for (const n of Object.keys(out)) {
      const cur = acc.fields[n];
      if (cur ? Vault.same(cur.v, out[n]) : out[n] == null) continue;
      acc.fields[n] = { v: out[n], at: Math.max(t, cur ? cur.at + 1 : 0) };
      changed = true;
    }
    if (changed) touched(acc);
  }

  function queueNote() {
    if (noteQueued) return;
    noteQueued = true;
    queueMicrotask(noteLocal);
  }

  // A Notion draft's format, budget, message or backspace switch changed here.
  function noteDraft(d) {
    if (!d || !d.notionId || d.localOnly || applying) return;
    const acc = read();
    if (!acc) return;
    const name = 'draft.' + d.notionId;
    const v = metaOf(d);
    const cur = acc.fields[name];
    if (cur && Vault.same(cur.v, v)) return;
    acc.fields[name] = { v, at: Math.max(Date.now(), cur ? cur.at + 1 : 0) };
    touched(acc);
  }

  const validBudget = (b) => Number.isFinite(b) && b >= 10 && b % 10 === 0;

  // What the account says about a Notion page's draft, for a draft made from that page.
  function draftMeta(notionId) {
    const acc = peek();
    const f = acc && acc.fields['draft.' + notionId];
    const v = f && f.v;
    if (!v || typeof v !== 'object') return null;
    return {
      format: TDW.Formats && TDW.Formats.get(v.f).key === v.f ? v.f : null,
      budget: validBudget(v.b) ? v.b : null,
      intent: typeof v.i === 'string' ? v.i : '',
      nb: typeof v.nb === 'boolean' ? v.nb : null
    };
  }

  function validSetting(k, v) {
    const d = Store.DEFAULTS[k];
    if (d === undefined || k === 'dictionary' || typeof v !== typeof d) return false;
    return k !== 'highlights' || (!!v && !Array.isArray(v));
  }

  /* ---------- The account's values into this browser ---------- */

  function apply(merged) {
    const { out } = localFields();
    const differs = (n) => !!merged[n] && !Vault.same(merged[n].v, out[n] == null ? null : out[n]);
    const changes = { settings: false, ai: false, notion: null, drafts: [] };
    applying = true;
    try {
      const sets = Object.keys(merged).filter((n) => n.startsWith('set.') && differs(n) && validSetting(n.slice(4), merged[n].v));
      const s = Store.getSettings();
      const words = Object.keys(merged).filter((n) => n.startsWith('dict.') && typeof merged[n].v === 'string').map((n) => merged[n].v);
      const hasDict = Object.keys(merged).some((n) => n.startsWith('dict.'));
      const lower = new Set(words.map((w) => w.toLowerCase()));
      const kept = s.dictionary.filter((w) => lower.has(w.toLowerCase()));
      const dict = kept.concat(words.filter((w) => !kept.some((k) => k.toLowerCase() === w.toLowerCase())));
      const dictChanged = hasDict && !Vault.same([...dict].sort(), [...s.dictionary].sort());
      if (sets.length || dictChanged) {
        for (const n of sets) s[n.slice(4)] = merged[n].v;
        if (dictChanged) s.dictionary = dict;
        Store.saveSettings(s);
        changes.settings = true;
      }

      if (differs('ai.key')) { if (merged['ai.key'].v) Store.setKey(merged['ai.key'].v); else Store.clearKey(); changes.ai = true; }
      if (differs('ai.model')) { Store.setModel(merged['ai.model'].v || ''); changes.ai = true; }
      if (differs('ai.mode')) { Store.setModelMode(merged['ai.mode'].v); changes.ai = true; }

      if (differs('notion.token') || differs('notion.config')) {
        changes.notion = { prev: Store.getNotionConfig() };
        if (differs('notion.config')) Store.setNotionConfig(merged['notion.config'].v || null);
        if (differs('notion.token')) { if (merged['notion.token'].v) Store.setNotionToken(merged['notion.token'].v); else Store.clearNotionToken(); }
      }

      for (const n of Object.keys(merged)) {
        if (!n.startsWith('draft.') || !merged[n].v) continue;
        const d = Store.findByNotionId(n.slice(6));
        const m = draftMetaFrom(merged[n].v);
        if (!d || d.localOnly || !m || Vault.same(metaOf(d), metaOf(Object.assign({}, d, m)))) continue;
        Object.assign(d, m);
        Store.saveDraft(d);
        changes.drafts.push(d);
      }
    } finally {
      applying = false;
    }
    if (changes.settings || changes.ai || changes.notion || changes.drafts.length) call('onApplied', changes);
  }

  function draftMetaFrom(v) {
    if (!v || typeof v !== 'object') return null;
    const m = {};
    if (TDW.Formats && TDW.Formats.get(v.f).key === v.f) m.format = v.f;
    if (validBudget(v.b)) m.budget = v.b;
    if (typeof v.i === 'string') m.intent = v.i;
    m.nb = typeof v.nb === 'boolean' ? v.nb : null;
    return m;
  }

  /* ---------- Talking to the server ---------- */

  async function post(action, body) {
    let res;
    try {
      res = await fetch(API + action, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-TDW': '1' },
        body: JSON.stringify(body || {})
      });
    } catch (_) {
      throw err('offline', navigator.onLine === false ? "You're offline." : "Can't reach your account right now.");
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* not JSON: this server has no accounts */ }
    if (!data || typeof data !== 'object') throw err('unavailable', 'Accounts only work in the online app, not in a copy served from this computer.');
    if (!res.ok) throw Object.assign(err(data.error || 'error', data.message || 'Something went wrong.'), { status: res.status, doc: data });
    return data;
  }

  // One tab at a time talks to the server, so two tabs never send the same change twice.
  function locked(fn) {
    if (navigator.locks && navigator.locks.request) return navigator.locks.request(LOCK, fn);
    return fn();
  }

  // Merge the server's copy into this browser's, and apply what the server won.
  async function absorb(doc, known) {
    noteLocal(); // a change made here a moment ago is part of this browser's copy first
    const acc = read();
    if (!acc) return;
    const remote = known || (doc.ct ? await Vault.open(doc, acc.key, acc.userId) : {});
    const now = read();
    if (!now || now.userId !== acc.userId) return;
    const merged = Vault.merge(now.fields, remote);
    now.fields = merged;
    now.rev = doc.rev;
    now.dirty = Vault.differs(merged, remote);
    write(now);
    apply(merged);
  }

  function failed(e) {
    const code = e && e.code;
    if (code === 'signed_out') return lost("You're signed out of your account. Sign in again in Settings to keep syncing.");
    if (code === 'locked') return lost('Your password changed on another device. Sign in again in Settings.');
    setStatus(code === 'offline' ? 'offline' : 'error', (e && e.message) || 'Something went wrong.');
    const acc = read();
    if (acc && acc.dirty && code !== 'offline') pushSoon(RETRY_MS);
  }

  // The session ended somewhere else. This browser keeps its keys and settings; signing in again
  // merges them back.
  function lost(message) {
    clearTimeout(pushTimer);
    clearInterval(pollTimer);
    write(null);
    setStatus('idle');
    call('onSignedOut', message);
  }

  async function pushLocked() {
    for (let k = 0; k < 4; k++) {
      const acc = read();
      if (!acc || !acc.dirty) { if (acc) setStatus('synced'); return; }
      const seq = acc.seq;
      setStatus('syncing');
      let res;
      try {
        const sealed = await Vault.seal(acc.fields, acc.key, acc.userId);
        res = await post('push', { base: acc.rev, iv: sealed.iv, ct: sealed.ct });
      } catch (e) {
        if (e.code === 'conflict' && e.doc) {
          try { await absorb(e.doc); } catch (e2) { failed(e2); return; }
          continue;
        }
        failed(e);
        return;
      }
      const now = read();
      if (!now || now.userId !== acc.userId) return;
      now.rev = res.rev;
      now.at = Date.now();
      if (now.seq === seq) now.dirty = false;
      write(now);
    }
    const acc = read();
    if (acc && acc.dirty) pushSoon();
    else if (acc) setStatus('synced');
  }

  function pushNow() {
    clearTimeout(pushTimer);
    return locked(pushLocked);
  }

  function pushSoon(ms) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { pushNow().catch(failed); }, ms == null ? PUSH_MS : ms);
  }

  async function pull(force) {
    if (!signedIn() || (!force && Date.now() - lastPull < PULL_GAP_MS)) return;
    lastPull = Date.now();
    await locked(async () => {
      const acc = read();
      if (!acc) return;
      setStatus('syncing');
      try {
        const res = await post('pull');
        if (res.userId !== acc.userId) { lost("You're signed out of your account. Sign in again in Settings."); return; }
        if (res.rev !== acc.rev) await absorb(res);
        const now = read();
        if (now && now.dirty) await pushLocked();
        else if (now) { now.at = Date.now(); write(now); setStatus('synced'); }
      } catch (e) {
        failed(e);
      }
    });
  }

  function start() {
    clearInterval(pollTimer);
    if (signedIn()) pollTimer = setInterval(() => { if (document.visibilityState === 'visible') pull(); }, POLL_MS);
  }

  /* ---------- Signing in and out ---------- */

  function checkPassword(password) {
    if (String(password || '').length < 8) throw err('short', 'Use at least 8 characters.');
  }

  async function signUp(email, password) {
    const e = Vault.normEmail(email);
    checkPassword(password);
    const keys = await Vault.deriveKeys(e, password);
    const res = await post('signup', { email: e, auth: keys.auth });
    Store.setAccountEmail(res.email);
    write({ email: res.email, userId: res.userId, key: keys.key, rev: res.rev, fields: snapshot(Date.now()), seq: 1, dirty: true, at: 0 });
    start();
    await pushNow();
  }

  async function signIn(email, password) {
    const e = Vault.normEmail(email);
    const keys = await Vault.deriveKeys(e, password);
    const res = await post('login', { email: e, auth: keys.auth });
    let remote = {};
    if (res.ct) {
      try { remote = await Vault.open(res, keys.key, res.userId); } catch (x) {
        post('logout').catch(() => {});
        throw x;
      }
    }
    Store.setAccountEmail(res.email);
    write({ email: res.email, userId: res.userId, key: keys.key, rev: -1, fields: snapshot(0), seq: 1, dirty: false, at: 0 });
    await locked(async () => {
      await absorb(res, remote);
      const now = read();
      if (now && now.dirty) await pushLocked();
      else if (now) { now.at = Date.now(); write(now); setStatus('synced'); }
    });
    lastPull = Date.now();
    start();
  }

  // Signing out takes your keys and Notion connection out of this browser. Drafts stay.
  async function signOut() {
    const acc = read();
    if (!acc) return;
    if (acc.dirty) { try { await pushNow(); } catch (_) { /* offline: they wait for the next sign-in */ } }
    try { await post('logout'); } catch (_) { /* offline: the session expires unused */ }
    clearTimeout(pushTimer);
    clearInterval(pollTimer);
    write(null);
    setStatus('idle');
    if (TDW.Sync) TDW.Sync.disconnect();
    if (TDW.AI) TDW.AI.disconnect();
    call('onApplied', { settings: false, ai: true, notion: null, drafts: [] });
  }

  async function changePassword(current, next) {
    checkPassword(next);
    await locked(async () => {
      const acc = read();
      if (!acc) throw err('signed_out', "You're signed out.");
      const [oldKeys, newKeys] = await Promise.all([Vault.deriveKeys(acc.email, current), Vault.deriveKeys(acc.email, next)]);
      for (let k = 0; k < 3; k++) {
        const now = read();
        if (!now) throw err('signed_out', "You're signed out.");
        const seq = now.seq;
        const sealed = await Vault.seal(now.fields, newKeys.key, now.userId);
        try {
          const res = await post('password', { auth: oldKeys.auth, newAuth: newKeys.auth, base: now.rev, iv: sealed.iv, ct: sealed.ct });
          const after = read();
          after.key = newKeys.key;
          after.rev = res.rev;
          after.at = Date.now();
          if (after.seq === seq) after.dirty = false;
          write(after);
          if (after.dirty) pushSoon(0);
          return;
        } catch (e) {
          if (e.code !== 'conflict' || !e.doc) throw e;
          await absorb(e.doc);
        }
      }
      throw err('conflict', 'Your account kept changing. Try again.');
    });
  }

  // The account goes; this browser keeps what it has.
  async function deleteAccount(password) {
    const acc = read();
    if (!acc) return;
    const keys = await Vault.deriveKeys(acc.email, password);
    await post('delete', { auth: keys.auth });
    clearTimeout(pushTimer);
    clearInterval(pollTimer);
    write(null);
    setStatus('idle');
  }

  function init(h) {
    hooks = h || {};
    Store.onWrite((key) => {
      if (!SYNCED.has(key) || applying || holds) return;
      if (signedIn()) queueNote();
    });
    Store.onExternal((ch) => { if (ch.key === 'tdw.account') { peeked = null; emit(); } });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') pull();
      else if (read() && read().dirty) pushNow().catch(failed);
    });
    window.addEventListener('online', () => pull(true));
    if (signedIn()) {
      start();
      pull(true);
    }
  }

  TDW.Account = {
    init, signUp, signIn, signOut, changePassword, deleteAccount, pull, pushNow, noteDraft, draftMeta,
    // While held (a Notion secret being tested, say), changes wait, then go as one.
    hold() {
      holds++;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        holds--;
        if (!holds && signedIn()) queueNote();
      };
    },
    state() {
      const acc = read();
      return { signedIn: !!acc, email: acc ? acc.email : '', at: acc ? acc.at : 0, dirty: !!(acc && acc.dirty), status: status.state, message: status.message };
    },
    lastEmail: () => Store.getAccountEmail(),
    onChange(fn) { listeners.push(fn); }
  };
})();
