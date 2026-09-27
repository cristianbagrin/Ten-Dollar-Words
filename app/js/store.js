/* Drafts and settings in localStorage, with an in-memory fallback. Every draft is loaded once
   into memory: getDraft returns the same object every time, and the app and sync both change
   that object and save it. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};

  const DEFAULTS = {
    skin: 'typewriter', sound: 'typewriter', volume: 0.35, typewriterScroll: true, textSize: 0, defaultBudget: 2000,
    dictionary: [], noBackspace: true, defaultFormat: 'basic',
    highlights: { spelling: true, veryHard: true, hard: true, complex: true, passive: true, adverb: true, qualifier: true }
  };
  const PREFIX = 'tdw.draft.';
  const CONFIG = 'tdw.notion';
  const PROBE = 'tdw.__probe';
  const MARKS = 'tdw.notionMarks';
  const ACCOUNT = 'tdw.account';
  const MARK_MS = 60000;
  // Written only by sync. The open draft keeps its own text while it has unsaved typing,
  // but it still takes these, so a Notion link learned in another tab is never lost.
  const LINK_FIELDS = ['notionId', 'url', 'remoteTitle', 'contentFetchedAt', 'contentEditedAt'];

  const mem = new Map();
  const drafts = new Map();
  const savedText = new Map(); // id -> the text last saved or loaded, to tell when the text changed
  const listeners = [];
  const writers = [];          // told about every key this tab writes (the account watches its keys)
  let checked = false;
  let memoryOnly = false;
  let persistAsked = false;
  let loaded = false;
  let config;
  let openId = null;
  let isBusy = () => false;

  const countWords = (t) => TDW.Engine.countWords(t);
  const isQuota = (e) => !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);

  function useMemory() {
    if (memoryOnly) return;
    memoryOnly = true;
    if (TDW.UI) TDW.UI.toast("This browser won't let the app save. Copy your text before you close it.");
  }

  function check() {
    if (checked) return;
    checked = true;
    try {
      localStorage.getItem('tdw.settings');
      localStorage.setItem(PROBE, '1');
      localStorage.removeItem(PROBE);
    } catch (e) {
      if (!isQuota(e)) useMemory();
    }
  }

  function get(k) {
    check();
    if (!memoryOnly) {
      try { return localStorage.getItem(k); } catch (_) { useMemory(); }
    }
    return mem.has(k) ? mem.get(k) : null;
  }

  function wrote(k) {
    for (const fn of writers) {
      try { fn(k); } catch (e) { setTimeout(() => { throw e; }); }
    }
  }

  // Returns true, or 'quota' when storage is full.
  function set(k, v) {
    check();
    if (!memoryOnly) {
      try { localStorage.setItem(k, v); wrote(k); return true; } catch (e) {
        if (isQuota(e)) return 'quota';
        useMemory();
      }
    }
    mem.set(k, v);
    wrote(k);
    return true;
  }

  function remove(k) {
    check();
    if (!memoryOnly) {
      try { localStorage.removeItem(k); wrote(k); return; } catch (_) { useMemory(); }
    }
    mem.delete(k);
    wrote(k);
  }

  function parse(s, fallback) {
    if (s == null) return fallback;
    try { return JSON.parse(s); } catch (_) { return fallback; }
  }
  const readJSON = (k, fallback) => parse(get(k), fallback);

  const newId = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const validBudget = (b) => { const n = Math.round(Number(b) / 10) * 10; return n >= 10 ? n : 0; };
  const str = (v, fallback) => (typeof v === 'string' ? v : fallback);

  const plainLine = (l) => (TDW.Inline ? TDW.Inline.plain(l) : l.replace(/^#+/, '')).trim();

  // The title is the draft's first sentence.
  function firstSentence(text) {
    const line = String(text || '').split('\n').map(plainLine).find(Boolean) || '';
    if (!line) return '';
    const list = TDW.Engine ? TDW.Engine.splitSentences(line) : [];
    const first = (list.length ? line.slice(list[0].start, list[0].end) : line).trim();
    return first.length > 150 ? first.slice(0, 147).replace(/\s+\S*$/, '') + '…' : first;
  }
  // Pages that only have a title in Notion keep it until they get some text.
  const displayTitle = (d) => firstSentence(d.text) || String(d.title || '').trim() || 'Untitled draft';

  function normalize(d) {
    const now = Date.now();
    const props = d.props && typeof d.props === 'object' && !Array.isArray(d.props) ? d.props : {};
    return {
      id: String(d.id),
      text: str(d.text, ''),
      title: str(d.title, ''),
      format: d.format === 'email' || d.format === 'instagram' ? 'basic' : str(d.format, 'basic'), // retired formats
      budget: validBudget(d.budget) || DEFAULTS.defaultBudget,
      createdAt: Number(d.createdAt) || now,
      updatedAt: Number(d.updatedAt) || now,
      textAt: Number(d.textAt) || 0, // when this text was written, in any tab; 0 = unknown
      intent: str(d.intent, ''),
      notionId: str(d.notionId, '') || null,
      url: str(d.url, '') || null,
      props,
      dirty: !!d.dirty,
      propsDirty: !!d.propsDirty,
      contentFetchedAt: Number(d.contentFetchedAt) || 0,
      contentEditedAt: str(d.contentEditedAt, '') || null,
      remoteTitle: str(d.remoteTitle, null),
      localOnly: !!d.localOnly,
      nb: typeof d.nb === 'boolean' ? d.nb : null // backspace blocked here, or null to follow the stage
    };
  }

  function emit(change) {
    for (const fn of listeners) {
      try { fn(change); } catch (e) { setTimeout(() => { throw e; }); }
    }
  }

  const unlink = (d) => Object.assign(d, { notionId: null, url: null, props: {}, remoteTitle: null });

  // Another tab saved something. Reload that one draft in place so every reference stays valid.
  function onStorage(e) {
    if (!e.key || (e.storageArea && e.storageArea !== localStorage)) return;
    if (e.key === CONFIG) {
      const before = parse(e.oldValue, null);
      config = parse(e.newValue, null);
      if (before && config && before.databaseId && config.databaseId && before.databaseId !== config.databaseId) {
        for (const d of drafts.values()) unlink(d);
      }
      emit({ key: e.key });
      return;
    }
    if (!e.key.startsWith(PREFIX)) { emit({ key: e.key, value: e.newValue }); return; }
    const id = e.key.slice(PREFIX.length);
    const cur = drafts.get(id);
    if (e.newValue == null) {
      if (cur) { drafts.delete(id); savedText.delete(id); emit({ key: e.key, id, draft: null }); }
      return;
    }
    const raw = parse(e.newValue, null);
    if (!raw || typeof raw !== 'object') return;
    const incoming = normalize(Object.assign({}, raw, { id }));
    if (!cur) {
      drafts.set(id, incoming);
      savedText.set(id, incoming.text);
      emit({ key: e.key, id, draft: incoming });
      return;
    }
    // A stale copy from another tab must never drop a link this tab already has.
    if (cur.notionId && !incoming.notionId) for (const k of LINK_FIELDS) incoming[k] = cur[k];
    if (id === openId && isBusy()) {
      for (const k of LINK_FIELDS) cur[k] = incoming[k];
      return;
    }
    // Text older than ours: another tab saved its copy (say, marking it synced) just after we
    // saved newer typing. Keep our text, take the rest, and put our copy back in storage.
    if (incoming.text !== cur.text && incoming.textAt < cur.textAt) {
      Object.assign(cur, incoming, { text: cur.text, textAt: cur.textAt, updatedAt: Math.max(cur.updatedAt, incoming.updatedAt), dirty: cur.dirty || incoming.dirty });
      set(PREFIX + id, JSON.stringify(cur));
      emit({ key: e.key, id, draft: cur });
      return;
    }
    Object.assign(cur, incoming);
    savedText.set(id, cur.text);
    emit({ key: e.key, id, draft: cur });
  }

  function load() {
    if (loaded) return;
    loaded = true;
    check();
    const keys = [];
    if (!memoryOnly) {
      try {
        for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
      } catch (_) { useMemory(); }
    }
    keys.push(...mem.keys());
    for (const k of keys) {
      if (!k || !k.startsWith(PREFIX)) continue;
      const id = k.slice(PREFIX.length);
      const raw = readJSON(k, null);
      if (!drafts.has(id) && raw && typeof raw === 'object') {
        const d = normalize(Object.assign({}, raw, { id }));
        drafts.set(id, d);
        savedText.set(id, d.text);
      }
    }
    window.addEventListener('storage', onStorage);
  }

  function listDrafts() {
    load();
    return [...drafts.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function getDraft(id) {
    load();
    return drafts.get(id) || null;
  }

  function findByNotionId(notionId) {
    load();
    for (const d of drafts.values()) if (d.notionId === notionId) return d;
    return null;
  }

  function saveDraft(draft) {
    load();
    drafts.set(draft.id, draft);
    if (savedText.get(draft.id) !== draft.text) {
      draft.textAt = Math.max(Date.now(), (draft.textAt || 0) + 1);
      savedText.set(draft.id, draft.text);
    }
    if (set(PREFIX + draft.id, JSON.stringify(draft)) === 'quota') return false;
    if (!persistAsked) {
      persistAsked = true;
      try {
        const p = navigator.storage && navigator.storage.persist && navigator.storage.persist();
        if (p && p.catch) p.catch(() => {});
      } catch (_) { /* ignore */ }
    }
    return true;
  }

  function deleteDraft(id) {
    load();
    drafts.delete(id);
    savedText.delete(id);
    remove(PREFIX + id);
  }

  function newDraft(opts) {
    const o = opts || {};
    const now = Date.now();
    const draft = normalize({
      id: newId(), text: o.text || '', title: o.title || '', format: o.format || 'basic',
      budget: o.budget || getSettings().defaultBudget, notionId: o.notionId || null,
      intent: o.intent || '', nb: typeof o.nb === 'boolean' ? o.nb : null,
      createdAt: o.createdAt || now, updatedAt: o.updatedAt || now
    });
    saveDraft(draft);
    return draft;
  }

  function getSettings() {
    const saved = readJSON('tdw.settings', {});
    const obj = saved && typeof saved === 'object' ? saved : {};
    const s = Object.assign({}, DEFAULTS, obj);
    s.highlights = Object.assign({}, DEFAULTS.highlights, obj.highlights);
    s.dictionary = Array.isArray(obj.dictionary) ? obj.dictionary.filter((w) => typeof w === 'string' && w) : [];
    if (TDW.Formats && TDW.Formats.get(s.defaultFormat).key !== s.defaultFormat) s.defaultFormat = 'basic';
    return s;
  }

  // The settings object as saved in this browser, or null before anything was saved.
  function getStoredSettings() {
    const s = readJSON('tdw.settings', null);
    return s && typeof s === 'object' && !Array.isArray(s) ? s : null;
  }

  // The signed-in account (see account.js), or null.
  function getAccount() {
    const a = readJSON(ACCOUNT, null);
    const ok = a && typeof a === 'object' && typeof a.email === 'string' && typeof a.userId === 'string' &&
      typeof a.key === 'string' && a.fields && typeof a.fields === 'object' && Number.isInteger(a.rev);
    return ok ? a : null;
  }

  function getNotionConfig() {
    if (config === undefined) config = readJSON(CONFIG, null);
    return config && typeof config === 'object' ? config : null;
  }

  TDW.Store = {
    DEFAULTS,
    listDrafts, getDraft, findByNotionId, saveDraft, deleteDraft, newDraft, displayTitle, firstSentence, countWords,
    getSettings, getStoredSettings,
    saveSettings(s) { set('tdw.settings', JSON.stringify(s)); },
    getAccount,
    setAccount(a) { if (a) set(ACCOUNT, JSON.stringify(a)); else remove(ACCOUNT); },
    getAccountEmail() { return get('tdw.accountEmail') || ''; },
    setAccountEmail(e) { set('tdw.accountEmail', e); },
    getKey() { return get('tdw.geminiKey') || ''; },
    setKey(k) { set('tdw.geminiKey', k); },
    clearKey() { remove('tdw.geminiKey'); },
    getModel() { return get('tdw.geminiModel') || ''; },
    setModel(m) { if (m) set('tdw.geminiModel', m); else remove('tdw.geminiModel'); },
    getModelMode() { return get('tdw.geminiModelMode') === 'manual' ? 'manual' : 'auto'; },
    setModelMode(m) { if (m === 'manual') set('tdw.geminiModelMode', 'manual'); else remove('tdw.geminiModelMode'); },
    getLast() { return get('tdw.last'); },
    setLast(id) { set('tdw.last', id); },
    hintShown() { return get('tdw.hintShown') === '1'; },
    setHintShown() { set('tdw.hintShown', '1'); },
    threadHintShown() { return get('tdw.hintThread') === '1'; },
    setThreadHintShown() { set('tdw.hintThread', '1'); },
    isMemoryOnly() { check(); return memoryOnly; },

    getNotionToken() { return get('tdw.notionToken') || ''; },
    setNotionToken(t) { set('tdw.notionToken', t); },
    clearNotionToken() { remove('tdw.notionToken'); },
    getNotionConfig,
    setNotionConfig(c) {
      config = c || null;
      if (c) set(CONFIG, JSON.stringify(c)); else remove(CONFIG);
    },
    getNotionTrash() { const l = readJSON('tdw.notionTrash', []); return Array.isArray(l) ? l.filter((x) => typeof x === 'string') : []; },
    setNotionTrash(list) { if (list.length) set('tdw.notionTrash', JSON.stringify(list)); else remove('tdw.notionTrash'); },
    // Pages trashed or restored in the last minute, by any tab: a query can still list a page
    // that was just trashed, or miss one that was just restored. The latest mark wins.
    markPage(notionId, kind) {
      const now = Date.now();
      const old = readJSON(MARKS, {});
      const marks = {};
      for (const id of Object.keys(old && typeof old === 'object' ? old : {})) {
        const m = old[id];
        if (m && now - m.at < MARK_MS) marks[id] = m;
      }
      marks[notionId] = { kind, at: now };
      set(MARKS, JSON.stringify(marks));
    },
    pageMarked(notionId, kind) {
      const marks = readJSON(MARKS, {});
      const m = marks && marks[notionId];
      return !!m && m.kind === kind && Date.now() - m.at < MARK_MS;
    },
    // Tells the syncing tab that another tab came to the front.
    setSyncWant(v) { set('tdw.syncWant', JSON.stringify(v)); },
    unlink,

    // The open draft, and whether it has typing that isn't saved yet (storage events skip it then).
    setOpen(id) { openId = id; },
    setBusyCheck(fn) { isBusy = fn; },
    onExternal(fn) { listeners.push(fn); },
    onWrite(fn) { writers.push(fn); }
  };
})();
