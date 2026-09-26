/* App state, events, and boot. Loaded last. */
(function () {
  'use strict';
  const TDW = window.TDW;
  const { Engine, Editor, UI, Store, Sound, Panel, Popover, Dialogs, Spell, Sync, Formats } = TDW;

  const APP_VERSION = '1.2.2';
  const SAMPLE_TEXT = [
    'Every word you type costs ten dollars. That sounds harsh, but it is really the fastest way to learn to cut.',
    'Most people write long sentences because they are afraid that short ones will make them look simple to readers.',
    'This sentence is here to show you what happens when a writer keeps adding clauses and qualifications that the reader has to hold in their head while they wait for the point, which arrives much too late.',
    'The report was written by a committee in order to utilize every possible word.',
    "I think you already know what to do. Delete what doesn't earn its keep and watch the register quietly drop."
  ].join('\n');
  const TYPES = ['spelling', 'veryHard', 'hard', 'complex', 'passive', 'adverb', 'qualifier'];
  const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
  const PLACEHOLDER = 'Start typing. Every word costs $10.';
  const BUMP = { pan: 0, gain: 0.6 };
  const SYNC_LABEL = { syncing: 'Syncing…', synced: 'Synced', offline: 'Offline', error: 'Sync error', 'other-tab': 'Syncing in another tab' };

  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const editor = $('editor');
  const chrome = $('chrome');

  const state = {
    mode: 'write', draft: null, analysis: null, words: 0, dirty: false,
    settings: null, aiBusy: false, cycle: { type: null, index: -1 }, loading: false
  };

  /* ---------- Settings and theme ---------- */
  function setThemeColor() {
    const v = getComputedStyle(root).getPropertyValue(state.mode === 'edit' ? '--desk' : '--paper').trim();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && v) meta.setAttribute('content', v);
  }

  function applySettings() {
    const s = state.settings;
    root.dataset.skin = s.skin;
    root.style.setProperty('--text-offset', s.textSize + 'px');
    root.classList.toggle('tw-scroll', !!s.typewriterScroll);
    setThemeColor();
  }

  function updateSettings(patch) {
    Object.assign(state.settings, patch);
    Store.saveSettings(state.settings);
    applySettings();
    if ('sound' in patch) Sound.setProfile(patch.sound);
    if ('volume' in patch) Sound.setVolume(patch.volume);
    if ('skin' in patch || 'textSize' in patch) Editor.render();
  }

  const hiddenTypes = () => TYPES.filter((t) => state.settings.highlights[t] === false);

  function toggleHighlight(type) {
    state.settings.highlights[type] = state.settings.highlights[type] === false;
    Store.saveSettings(state.settings);
    Editor.setHidden(hiddenTypes());
    Popover.hide();
  }

  const analyze = (text) => Engine.analyze(text, { isKnown: Spell.isReady() ? Spell.known : undefined });

  /* ---------- Personal dictionary ---------- */
  function addWord(word) {
    const w = String(word || '').trim();
    if (!w) return;
    const list = state.settings.dictionary;
    if (!list.some((x) => x.toLowerCase() === w.toLowerCase())) list.push(w);
    Spell.addWord(w);
    Store.saveSettings(state.settings);
    Popover.hide();
    if (state.mode === 'edit') refresh();
  }

  function removeWord(word) {
    state.settings.dictionary = state.settings.dictionary.filter((x) => x !== word);
    Spell.setPersonal(state.settings.dictionary);
    Store.saveSettings(state.settings);
    if (state.mode === 'edit') refresh();
  }

  /* ---------- Saving ---------- */
  let saveTimer = 0;
  let statusTimer = 0;
  let saveFailed = false;

  function setSaveStatus(text, ms) {
    clearTimeout(statusTimer);
    $('save-status').textContent = text;
    if (ms) statusTimer = setTimeout(() => { $('save-status').textContent = ''; }, ms);
  }

  function markDirty() {
    state.dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 600);
    setSaveStatus('Saving…');
  }

  function saveNow() {
    clearTimeout(saveTimer);
    if (!state.dirty || !state.draft) return true;
    const d = state.draft;
    if (!state.loading) d.text = Editor.getText();
    d.updatedAt = Date.now();
    if (Store.saveDraft(d)) {
      state.dirty = false;
      saveFailed = false;
      setSaveStatus('Saved', 2000);
      return true;
    }
    setSaveStatus('Not saved: storage is full');
    if (!saveFailed) UI.toast('Storage is full. Delete old drafts to make room.');
    saveFailed = true;
    return false;
  }

  // Tell sync about an edit to the open draft (text or title).
  function syncEdit() {
    const d = state.draft;
    if (d && !d.localOnly && Sync.isConnected()) Sync.noteEdit(d.id);
  }

  /* ---------- Formats ---------- */

  // Edit-mode aids: the fold, text past the limit, and X thread numbers. Write mode shows none.
  function updateAids() {
    const d = state.draft;
    if (!d) return;
    if (state.mode !== 'edit') { Editor.setFx([]); Editor.setAids(null); return; }
    const f = Formats.get(d.format);
    const text = Editor.getText();
    const fx = [];
    let posts = null;
    if (f.thread) {
      const list = Formats.posts(text);
      for (const p of list) {
        const i = Formats.xOverflowIndex(text, p.start, p.end, f.limit);
        if (i >= 0) fx.push({ type: 'overflow', start: i, end: p.end });
      }
      if (list.length > 1) {
        posts = list.map((p, k) => ({
          start: p.start, end: p.end, label: (k + 1) + '/' + list.length,
          title: 'Post ' + (k + 1) + ' of ' + list.length + ' · ' + Formats.xLength(text.slice(p.start, p.end)) + '/' + f.limit + ' · click to select'
        }));
      }
    } else if (f.limit && text.length > f.limit) {
      const at = /[\uDC00-\uDFFF]/.test(text[f.limit]) ? f.limit - 1 : f.limit; // never split an emoji
      fx.push({ type: 'overflow', start: at, end: text.length });
    }
    Editor.setFx(fx);
    Editor.setAids(f.fold || posts ? { fold: f.fold || null, posts } : null);
  }

  function applyFormat() {
    const f = Formats.get(state.draft.format);
    root.dataset.format = f.key;
    $('format-select').value = f.key;
    updateAids();
    Editor.render();
  }

  function threadHint(f) {
    if (!f.thread || Store.threadHintShown()) return;
    Store.setThreadHintShown();
    UI.toast('Threads: a line with just --- starts the next post. ⌘↩ adds one.');
  }

  function setFormat(key) {
    const d = state.draft;
    const from = Formats.get(d.format);
    const to = Formats.get(key);
    if (from === to) return;
    if (d.budget === Formats.budgetOf(from, state.settings)) d.budget = Formats.budgetOf(to, state.settings);
    d.format = to.key;
    Store.saveDraft(d);
    applyFormat();
    threadHint(to);
    if (state.mode === 'edit') refresh();
  }

  // ⌘↩ in X: a new post. On an empty line the separator takes that line.
  function insertSeparator() {
    const text = Editor.getText();
    const p = editor.selectionEnd;
    const ls = text.lastIndexOf('\n', p - 1) + 1;
    const le = text.indexOf('\n', p);
    const empty = p === ls && (le < 0 ? text.length : le) === ls;
    Editor.replaceRange(p, p, empty ? '---\n' : '\n---\n');
  }

  /* ---------- Drafts ---------- */
  function loadDraft(d) {
    clearTimeout(saveTimer);
    state.draft = d;
    state.dirty = false;
    Store.setOpen(d.id);
    Store.setLast(d.id);
    Popover.hide();
    Panel.closeResults();
    Panel.closeBudget();
    Editor.setText(d.text);
    state.words = Engine.countWords(d.text);
    setSaveStatus('');
    applyFormat();
    Panel.renderDetails(true);
    if (state.mode === 'edit') refresh();
    if (Dialogs.isDraftsOpen()) Dialogs.renderDraftList();
  }

  let openSeq = 0;
  let loadingCount = 0;

  function onLoading(on) {
    loadingCount = Math.max(0, loadingCount + (on ? 1 : -1));
    state.loading = loadingCount > 0;
    editor.readOnly = state.loading;
    editor.placeholder = state.loading ? 'Loading from Notion…' : PLACEHOLDER;
    if (on) {
      Popover.hide();
      Editor.setText('');
      state.words = 0;
      if (state.mode === 'edit') refresh();
    }
  }

  // Linked drafts may need their text from Notion first.
  async function openDraft(target) {
    const d = typeof target === 'string' ? Store.getDraft(target) : target;
    if (!d || state.draft === d) return;
    saveNow();
    const seq = ++openSeq;
    state.draft = d;
    state.dirty = false;
    Store.setOpen(d.id);
    await Sync.prepare(d);
    if (seq !== openSeq || Store.getDraft(d.id) !== d) return;
    loadDraft(d);
  }

  function newDraft(text) {
    saveNow();
    openSeq++;
    const f = Formats.get(state.settings.defaultFormat);
    const d = Store.newDraft({ text: text || '', format: f.key, budget: Formats.budgetOf(f, state.settings) });
    loadDraft(d);
    threadHint(f);
    if (text) syncEdit();
    return d;
  }

  function openNewest() {
    const next = Store.listDrafts()[0];
    if (next) openDraft(next);
    else newDraft('');
  }

  function draftDeleted(id) {
    if (!state.draft || state.draft.id !== id) return;
    clearTimeout(saveTimer);
    state.dirty = false;
    state.draft = null;
    openNewest();
  }

  function setBudget(v) {
    state.draft.budget = v;
    markDirty();
    saveNow();
    refreshPanel();
  }

  function setIntent(text) {
    state.draft.intent = text;
    markDirty();
    saveNow();
  }

  // The Name field in Details.
  function setTitle(value) {
    const d = state.draft;
    d.title = value;
    d.updatedAt = Date.now();
    Store.saveDraft(d);
    syncEdit();
    if (Dialogs.isDraftsOpen()) Dialogs.renderDraftList();
  }

  function setProp(name, value) {
    const d = state.draft;
    d.props[name] = value;
    Store.saveDraft(d);
    Sync.noteProp(d.id, name);
    if (Dialogs.isDraftsOpen()) Dialogs.renderDraftList();
  }

  // Every programmatic text change goes through here so undo keeps working and cuts can chime.
  function edit(start, end, text, opts) {
    const before = state.words;
    Editor.replaceRange(start, end, text);
    const saved = before - state.words;
    if (saved > 0 && state.mode === 'edit' && !(opts && opts.silent)) Sound.play('coin');
    return saved;
  }

  function insertSample() {
    const text = Editor.getText();
    if (!text.trim()) Editor.replaceRange(0, text.length, SAMPLE_TEXT);
    else newDraft(SAMPLE_TEXT);
  }

  /* ---------- Changes from Notion and from other tabs ---------- */

  // Replace the editor text without losing the caret: keep it inside the unchanged prefix,
  // otherwise shift it by the change in length.
  function replaceText(text) {
    const old = editor.value;
    if (old === text) return;
    let p = 0;
    const max = Math.min(old.length, text.length);
    while (p < max && old.charCodeAt(p) === text.charCodeAt(p)) p++;
    const shift = (i) => (i <= p ? i : Math.max(0, Math.min(text.length, i + text.length - old.length)));
    const s = shift(editor.selectionStart);
    const e = shift(editor.selectionEnd);
    editor.value = text;
    editor.setSelectionRange(s, e);
    state.words = Engine.countWords(text);
    Popover.hide();
    updateAids();
    if (state.mode === 'edit') refresh();
    else Editor.render();
  }

  function onList() {
    if (Dialogs.isDraftsOpen()) Dialogs.renderDraftList();
    if (!state.draft || state.loading) return;
    Panel.renderDetails();
    updateSyncStatus();
  }

  function onRemoteText(d) {
    if (d === state.draft && !state.loading) replaceText(d.text);
    onList();
  }

  function onRemoteDelete(d) {
    if (d === state.draft) {
      clearTimeout(saveTimer);
      state.dirty = false;
      state.draft = null;
      openNewest();
      UI.toast('“' + Store.displayTitle(d) + '” was deleted in Notion.');
    }
    onList();
  }

  function onExternal(ch) {
    const d = state.draft;
    if (ch.key && ch.key.startsWith('tdw.draft.') && d && ch.id === d.id) {
      if (!ch.draft) draftDeleted(ch.id);
      else if (!state.dirty && !state.loading) {
        if (root.dataset.format !== Formats.get(d.format).key) applyFormat();
        replaceText(d.text);
        refreshPanel();
      }
    }
    onList();
  }

  /* ---------- Sync status ---------- */
  function updateSyncStatus() {
    const b = $('sync-status');
    const s = Sync.status();
    const show = Sync.isConnected() && !!SYNC_LABEL[s.state];
    b.hidden = !show;
    if (!show) return;
    b.textContent = SYNC_LABEL[s.state];
    b.classList.toggle('is-error', s.state === 'error');
  }

  function syncToast() {
    const s = Sync.status();
    const what = s.message || SYNC_LABEL[s.state] || '';
    const when = s.at ? 'Last sync ' + UI.relTime(s.at) + '.' : 'Not synced yet.';
    UI.toast((what ? what.replace(/\.?$/, '.') + ' ' : '') + when);
  }

  /* ---------- Analysis and modes ---------- */
  const isSentence = (i) => i.type === 'hard' || i.type === 'veryHard';
  let analyzeTimer = 0;

  function refresh() {
    clearTimeout(analyzeTimer);
    state.analysis = analyze(Editor.getText());
    Editor.setMarks(state.analysis.issues.filter(isSentence), state.analysis.issues.filter((i) => !isSentence(i)));
    Editor.setHidden(hiddenTypes());
    Editor.render();
    Panel.render(state.analysis, state.draft, state.words);
  }

  function refreshPanel() {
    if (state.mode === 'edit') Panel.render(state.analysis, state.draft, state.words);
  }

  function setMode(m) {
    state.mode = m;
    root.dataset.mode = m;
    $('mode-write').setAttribute('aria-pressed', String(m === 'write'));
    $('mode-edit').setAttribute('aria-pressed', String(m === 'edit'));
    setThemeColor();
    updateAids();
    if (m === 'edit') {
      refresh();
      Panel.renderDetails(true);
    } else {
      clearTimeout(analyzeTimer);
      Editor.setMarks([], []);
      Editor.render();
      Popover.hide();
      Panel.closeSheet();
      Panel.closeResults();
      Panel.closeBudget();
      hideChrome();
    }
    requestAnimationFrame(() => {
      Editor.scrollToIndex(Editor.caretIndex(), m === 'write' ? 0.45 : 0.35);
      editor.focus({ preventScroll: true });
    });
  }

  /* ---------- "No backspace" stages (Write mode) ---------- */
  let blockWarned = false;

  function noBackspace() {
    const d = state.draft;
    if (!state.settings.noBackspace || state.mode !== 'write' || !d) return false;
    const c = Sync.config();
    const schema = (c && c.schema) || {};
    return Object.keys(d.props || {}).some((name) => {
      const t = schema[name] && schema[name].type;
      const v = d.props[name];
      return (!t || t === 'select' || t === 'status') && typeof v === 'string' && /no backspace/i.test(v);
    });
  }

  function blockDelete(e) {
    e.preventDefault();
    if (blockWarned) return;
    blockWarned = true;
    UI.toast('Draft 1 is no-backspace. Keep writing; Edit mode can delete.');
  }

  /* ---------- Chrome auto-hide (Write mode) ---------- */
  let chromeTimer = 0;
  let mouseAnchor = null;

  function showChrome() {
    chrome.classList.add('is-shown');
    clearTimeout(chromeTimer);
    chromeTimer = setTimeout(function hideLater() {
      if (chrome.matches(':hover')) { chromeTimer = setTimeout(hideLater, 400); return; }
      chrome.classList.remove('is-shown');
    }, 1600);
  }

  function hideChrome() {
    clearTimeout(chromeTimer);
    chrome.classList.remove('is-shown');
  }

  /* ---------- Editor events ---------- */
  let writeRaf = 0;

  function onInput() {
    if (state.loading) return;
    const text = Editor.getText();
    const prev = state.words;
    const words = Engine.countWords(text);
    const d = state.draft;
    state.words = words;
    d.text = text;
    markDirty();
    syncEdit();
    Popover.hide();
    updateAids();
    if (state.mode === 'edit') {
      if (text.length < 15000) {
        refresh();
      } else {
        clearTimeout(analyzeTimer);
        analyzeTimer = setTimeout(refresh, 150);
        Editor.render();
        Panel.render(state.analysis, d, words);
      }
      if (words < prev) Panel.refund(prev - words);
      const budget = d.budget;
      if (words > prev && ((prev * 10 <= budget * 0.9 && words * 10 > budget * 0.9) || (prev * 10 <= budget && words * 10 > budget))) {
        Sound.play('bell');
      }
    } else if (!writeRaf) {
      writeRaf = requestAnimationFrame(() => {
        writeRaf = 0;
        if (state.settings.typewriterScroll) Editor.typewriterScroll();
        else Editor.render();
      });
    }
  }

  function onCaretMove() {
    if (state.mode === 'edit') {
      if (editor.selectionStart === editor.selectionEnd) Popover.showAt(Editor.caretIndex());
    } else if (state.settings.typewriterScroll) {
      requestAnimationFrame(() => Editor.typewriterScroll());
    }
  }

  function onDocKeydown(e) {
    const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
    const key = String(e.key || '').toLowerCase();
    const dialogOpen = !!document.querySelector('dialog[open]');
    if (mod && key === 'e') {
      e.preventDefault();
      if (!dialogOpen) setMode(state.mode === 'write' ? 'edit' : 'write');
    } else if (mod && key === 's') {
      e.preventDefault();
      state.dirty = state.dirty || !!state.draft;
      if (saveNow()) UI.toast('Saved');
    } else if (e.key === 'Escape' && !dialogOpen) {
      if (Popover.isOpen()) Popover.hide();
      else if (Panel.isBudgetOpen()) Panel.closeBudget(true);
      else if (Panel.isSheetOpen()) Panel.closeSheet();
    }
  }

  function wire() {
    editor.addEventListener('keydown', (e) => {
      const k = Sound.kindForKey(e); if (k) Sound.play(k, k === 'back' && noBackspace() ? BUMP : { pan: Sound.panForKey(e), repeat: e.repeat });
      if ((e.key === 'Backspace' || e.key === 'Delete') && noBackspace()) blockDelete(e);
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.altKey && Formats.get(state.draft.format).thread) {
        e.preventDefault();
        insertSeparator();
      }
      if (state.mode === 'write') {
        hideChrome();
        root.classList.add('is-typing');
        mouseAnchor = null;
      }
    });
    editor.addEventListener('beforeinput', (e) => {
      if (Editor.busy || !e.inputType) return;
      if (e.inputType.startsWith('delete') && noBackspace()) {
        if (performance.now() - Sound.lastKeyAt > 60) Sound.play('back', BUMP);
        blockDelete(e);
        return;
      }
      if (!e.inputType.startsWith('insert')) return;
      if (performance.now() - Sound.lastKeyAt > 60) Sound.play('key');
    });
    editor.addEventListener('input', onInput);
    editor.addEventListener('click', onCaretMove);
    editor.addEventListener('keyup', (e) => { if (NAV_KEYS.has(e.key)) onCaretMove(); });

    document.addEventListener('keydown', onDocKeydown);
    document.addEventListener('mousemove', (e) => {
      if (!mouseAnchor) { mouseAnchor = { x: e.clientX, y: e.clientY }; return; }
      if (Math.hypot(e.clientX - mouseAnchor.x, e.clientY - mouseAnchor.y) <= 4) return;
      mouseAnchor = { x: e.clientX, y: e.clientY };
      root.classList.remove('is-typing');
      if (state.mode === 'write') showChrome();
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
    window.addEventListener('pagehide', saveNow);

    $('mode-write').addEventListener('click', () => setMode('write'));
    $('mode-edit').addEventListener('click', () => setMode('edit'));
    $('btn-drafts').addEventListener('click', () => Dialogs.openDrafts());
    $('btn-settings').addEventListener('click', () => Dialogs.openSettings());
    $('format-select').addEventListener('change', (e) => setFormat(e.target.value));
    $('sync-status').addEventListener('click', syncToast);

    const fs = $('btn-fullscreen');
    fs.hidden = !document.fullscreenEnabled;
    fs.addEventListener('click', () => {
      const p = document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen();
      if (p && p.catch) p.catch(() => {});
    });
    document.addEventListener('fullscreenchange', () => {
      fs.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
    });
  }

  /* ---------- Boot ---------- */
  function boot() {
    TDW.mockAI = false; // tests switch the fake AI on from JS

    state.settings = Store.getSettings();
    applySettings();
    Sound.init(state.settings);

    $('btn-settings').append(UI.icon('sliders'));
    $('format-select').append(...Formats.LIST.map((f) => UI.el('option', { value: f.key, text: f.label })));
    Editor.init({ textarea: editor, backdrop: $('backdrop'), surface: $('surface'), aids: $('aids') });
    Panel.init();
    Popover.init();
    Dialogs.init();
    Store.setBusyCheck(() => state.dirty);
    Store.onExternal(onExternal);
    Sync.init({ onRemoteText, onRemoteDelete, onList, onStatus: updateSyncStatus, onLoading, current: () => state.draft });

    const lastId = Store.getLast();
    const first = (lastId && Store.getDraft(lastId)) || Store.listDrafts()[0] || null;
    if (first) openDraft(first);
    else newDraft('');

    setMode('write');
    wire();
    if (Sync.isConnected()) Sync.start();
    updateSyncStatus();

    if (!Store.isMemoryOnly() && !Store.hintShown()) {
      UI.toast('Press ⌘E (Ctrl+E on Windows) or click Edit to see your spend and fixes.');
      Store.setHintShown();
    }
    if (location.protocol === 'https:' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    document.fonts.ready.then(() => Editor.render());
    Spell.load('dict/en-us.txt?v=' + APP_VERSION).then(() => {
      Spell.setPersonal(state.settings.dictionary);
      if (state.mode === 'edit') refresh();
    }).catch(() => {});
  }

  TDW.App = {
    state, APP_VERSION, SAMPLE_TEXT,
    setMode, saveNow, openDraft, newDraft, draftDeleted, analyze,
    updateSettings, toggleHighlight, hiddenTypes, setBudget, setIntent, setTitle, setProp, edit, insertSample,
    addWord, removeWord, refreshPanel, updateSyncStatus, openSettings: (section) => Dialogs.openSettings(section),
    syncChanged() { onList(); Panel.renderDetails(true); }
  };
  boot();
})();
