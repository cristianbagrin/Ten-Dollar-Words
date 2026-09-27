/* App state, events, and boot. Loaded last. */
(function () {
  'use strict';
  const TDW = window.TDW;
  const { Engine, Editor, UI, Store, Sound, Panel, Popover, Dialogs, Spell, Sync, Formats } = TDW;

  const APP_VERSION = '1.4.1';
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
  const FOLD_TITLE = {
    phone: 'On a phone, LinkedIn shows everything before this mark. The rest hides behind “…see more”.',
    desktop: 'On a computer, LinkedIn shows everything before this mark. The rest hides behind “…see more”.'
  };
  const CHROME_SHOW = 60;  // the bar slides in when the pointer is this close to the top
  const CHROME_HIDE = 84;  // and leaves as soon as it moves below this

  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const editor = $('editor');
  const chrome = $('chrome');

  const state = {
    mode: 'write', draft: null, analysis: null, words: 0, dirty: false,
    settings: null, aiBusy: false, cycle: { type: null, index: -1 }, loading: false
  };
  const controls = {};

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
    if ('noBackspace' in patch) updateBackspace();
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
  const foldCache = new Map();

  function foldOf(shown, cfg) {
    const key = cfg.label + '\u0000' + shown.slice(0, cfg.chars + 1);
    if (!foldCache.has(key)) {
      if (foldCache.size > 200) foldCache.clear();
      foldCache.set(key, Formats.foldIndex(shown, cfg));
    }
    return foldCache.get(key);
  }

  // The aids: X post windows (both modes); the LinkedIn fold and text past the limit (Edit mode).
  function updateAids() {
    const d = state.draft;
    if (!d) return;
    const f = Formats.get(d.format);
    const text = Editor.getText();
    const edit = state.mode === 'edit';
    const fx = [];
    const folds = [];
    if (edit && f.fold && text.trim()) {
      const shown = Formats.render(text, f);
      for (const key of Object.keys(Formats.FOLDS)) {
        const cfg = Formats.FOLDS[key];
        const k = foldOf(shown.text, cfg);
        if (k >= 0) folds.push({ index: shown.map[k], label: cfg.label, title: FOLD_TITLE[key] });
      }
      if (f.limit && shown.text.length > f.limit) fx.push({ type: 'overflow', start: shown.map[f.limit], end: text.length });
    }
    if (edit && f.thread) {
      for (const p of Formats.posts(text)) {
        const x = Formats.xPost(text, p.start, p.end, f.limit);
        if (x.over >= 0) fx.push({ type: 'overflow', start: x.over, end: p.end });
      }
    }
    Editor.setThread(!!f.thread);
    Editor.setFx(fx);
    Editor.setAids({
      folds,
      post: f.thread ? (s, e) => ({ words: Engine.countWords(text.slice(s, e)), length: Formats.xPost(text, s, e, f.limit).length, limit: f.limit }) : null
    });
  }

  function applyFormat() {
    const f = Formats.get(state.draft.format);
    root.dataset.format = f.key;
    if (controls.format) controls.format.set(f.key, false);
    if (controls.formatBtn) controls.formatBtn.firstChild.textContent = f.label;
    updateAids();
    Editor.render();
  }

  function threadHint(f) {
    if (!f.thread || Store.threadHintShown()) return;
    Store.setThreadHintShown();
    UI.toast('Each window is one post. ⌘↩ starts the next; backspace at the top of a post joins it to the one above.');
  }

  function setFormat(key) {
    const d = state.draft;
    const from = Formats.get(d.format);
    const to = Formats.get(key);
    if (from === to) return;
    const anchor = captureAnchor();
    if (d.budget === Formats.budgetOf(from, state.settings)) d.budget = Formats.budgetOf(to, state.settings);
    d.format = to.key;
    Store.saveDraft(d);
    applyFormat();
    threadHint(to);
    if (state.mode === 'edit') refresh();
    restoreAnchor(anchor);
    Editor.focus();
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
    updateBackspace();
    if (state.mode === 'edit') refresh();
    if (Dialogs.isDraftsOpen()) Dialogs.renderDraftList();
  }

  let openSeq = 0;
  let loadingCount = 0;

  function onLoading(on) {
    loadingCount = Math.max(0, loadingCount + (on ? 1 : -1));
    state.loading = loadingCount > 0;
    Editor.setReadOnly(state.loading);
    Editor.setPlaceholder(state.loading ? 'Loading from Notion…' : PLACEHOLDER);
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

  // A Notion property changed in the Drafts drawer.
  function setProp(d, name, value) {
    d.props[name] = value;
    const c = Sync.config();
    const t = c && c.schema && c.schema[name] && c.schema[name].type;
    if (t === 'status' || t === 'select') d.nb = null; // a new stage decides backspace again
    Store.saveDraft(d);
    Sync.noteProp(d.id, name);
    if (d === state.draft) updateBackspace();
  }

  // Every programmatic text change goes through here so undo keeps working and cuts can chime.
  function edit(start, end, text, opts) {
    const before = state.words;
    Editor.replaceRange(start, end, text);
    const saved = before - state.words;
    if (saved > 0 && state.mode === 'edit' && !(opts && opts.silent)) Sound.play('coin');
    return saved;
  }

  function cut(start, end, sentenceStart, opts) {
    const before = state.words;
    Editor.cut(start, end, sentenceStart);
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
  function replaceText(text) {
    if (Editor.getText() === text) return;
    Editor.replaceText(text);
    state.words = Engine.countWords(text);
    Popover.hide();
    updateAids();
    if (state.mode === 'edit') refresh();
    else Editor.render();
  }

  function onList() {
    if (Dialogs.isDraftsOpen()) Dialogs.renderDraftList();
    if (!state.draft || state.loading) return;
    updateBackspace();
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
    b.dataset.state = s.state;
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

  // Remember which line sits where on screen, so a layout change can put it back.
  function captureAnchor() {
    const vh = window.innerHeight;
    const caret = Editor.caretIndex();
    const rc = Editor.rectAt(caret);
    if (rc && rc.lineTop > 0 && rc.lineTop < vh - rc.lh) return { index: caret, y: rc.lineTop };
    const sheet = $('surface').getBoundingClientRect();
    const idx = Editor.indexFromPoint(sheet.left + Math.min(40, sheet.width / 2), vh * 0.4);
    if (idx == null) return null;
    const r = Editor.rectAt(idx);
    return r ? { index: idx, y: r.lineTop } : null;
  }

  function restoreAnchor(a) {
    if (!a) return;
    const r = Editor.rectAt(a.index);
    if (r) window.scrollBy(0, r.lineTop - a.y);
  }

  function setMode(m) {
    const anchor = captureAnchor();
    state.mode = m;
    root.dataset.mode = m;
    if (controls.mode) controls.mode.set(m, true);
    setThemeColor();
    updateAids();
    if (m === 'edit') {
      refresh();
    } else {
      clearTimeout(analyzeTimer);
      Editor.setMarks([], []);
      Editor.render();
      Popover.hide();
      Panel.closeSheet();
      Panel.closeResults();
      Panel.closeBudget();
      hideChrome(true);
    }
    updateBackspace();
    restoreAnchor(anchor);
    Editor.focus();
  }

  /* ---------- No backspace ---------- */
  let blockWarned = false;

  function stageSaysNo(d) {
    const c = Sync.config();
    const schema = (c && c.schema) || {};
    return Object.keys(d.props || {}).some((name) => {
      const t = schema[name] && schema[name].type;
      const v = d.props[name];
      return (!t || t === 'select' || t === 'status') && typeof v === 'string' && /no backspace/i.test(v);
    });
  }

  // Is backspace off for this draft? The toggle wins; otherwise the Notion stage decides.
  function backspaceOff(d) {
    if (!d) return false;
    if (typeof d.nb === 'boolean') return d.nb;
    return !!state.settings.noBackspace && stageSaysNo(d);
  }

  const noBackspace = () => state.mode === 'write' && backspaceOff(state.draft);

  function updateBackspace() {
    const on = backspaceOff(state.draft);
    if (controls.nb) controls.nb.set(on);
    root.classList.toggle('no-backspace', on);
  }

  function setBackspaceOff(on) {
    const d = state.draft;
    if (!d) return;
    d.nb = on === (state.settings.noBackspace && stageSaysNo(d)) ? null : on;
    Store.saveDraft(d);
    blockWarned = false;
    updateBackspace();
    Editor.focus();
    UI.toast(on ? 'Backspace is off' : 'Backspace is on');
  }

  function blocked() {
    if (performance.now() - Sound.lastKeyAt > 60) Sound.play('back', BUMP);
    if (blockWarned) return;
    blockWarned = true;
    UI.toast('Backspace is off');
  }

  /* ---------- Top bar in Write mode: only when the pointer is near it ---------- */
  let chromeTimer = 0;
  const canHover = window.matchMedia('(hover: hover) and (pointer: fine)');

  function showChrome() {
    clearTimeout(chromeTimer);
    chrome.classList.add('is-shown');
  }

  function hideChrome(now) {
    clearTimeout(chromeTimer);
    const go = () => {
      if (!now && (chrome.matches(':hover') || chrome.contains(document.activeElement) || UI.menuOpen())) {
        chromeTimer = setTimeout(go, 500);
        return;
      }
      chrome.classList.remove('is-shown');
    };
    if (now) go();
    else chromeTimer = setTimeout(go, 350);
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
    } else {
      Editor.render();
      if (!writeRaf) {
        writeRaf = requestAnimationFrame(() => {
          writeRaf = 0;
          if (state.settings.typewriterScroll) Editor.typewriterScroll();
        });
      }
    }
  }

  function onCaretMove() {
    if (state.mode === 'edit') {
      const s = Editor.getSelection();
      if (s.start === s.end) Popover.showAt(s.end);
    } else if (state.settings.typewriterScroll && !pointerSelecting && performance.now() - lastPointerAt > 600) {
      // Only after typing or arrow keys: a click or a selection never moves the page.
      const s = Editor.getSelection();
      if (s.start === s.end) requestAnimationFrame(() => Editor.typewriterScroll());
    }
  }

  // Copy: LinkedIn and X get what the post will show; Basic and Substack also get rich text.
  function clipboard(slice) {
    const f = state.draft ? Formats.get(state.draft.format) : Formats.get('basic');
    if (f.social) return { text: Formats.render(slice, f).text };
    return { text: Formats.render(slice, 'plain').text, html: Formats.toHTML(slice) };
  }

  function onDocKeydown(e) {
    const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
    const key = String(e.key || '').toLowerCase();
    const dialogOpen = !!document.querySelector('dialog[open]');
    if (mod && key === 'e') {
      e.preventDefault();
      if (!dialogOpen) setMode(state.mode === 'write' ? 'edit' : 'write');
    } else if (mod && key === 's' && !e.shiftKey) {
      e.preventDefault();
      state.dirty = state.dirty || !!state.draft;
      if (saveNow()) UI.toast('Saved');
    } else if (e.key === 'Escape' && !dialogOpen && !UI.menuOpen()) {
      if (Popover.isOpen()) Popover.hide();
      else if (Panel.isBudgetOpen()) Panel.closeBudget(true);
      else if (Panel.isSheetOpen()) Panel.closeSheet();
    }
  }

  let pointerSelecting = false;
  let lastPointerAt = 0;

  function wire() {
    editor.addEventListener('keydown', (e) => {
      if (state.loading) return;
      const k = Sound.kindForKey(e);
      if (k && !(k === 'back' && noBackspace())) Sound.play(k, { pan: Sound.panForKey(e), repeat: e.repeat });
      if ((e.key === 'Backspace' || e.key === 'Delete') && noBackspace()) { e.preventDefault(); blocked(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.altKey && Formats.get(state.draft.format).thread) {
        e.preventDefault();
        Editor.insertSeparator();
      }
      if (state.mode === 'write') {
        hideChrome(true);
        root.classList.add('is-typing');
      }
    });
    editor.addEventListener('beforeinput', (e) => {
      if (!e.inputType || !e.inputType.startsWith('insert') || e.inputType === 'insertCompositionText') return;
      if (performance.now() - Sound.lastKeyAt > 60) Sound.play('key');
    });
    editor.addEventListener('pointerdown', () => { pointerSelecting = true; lastPointerAt = performance.now(); });
    document.addEventListener('pointerup', () => {
      if (!pointerSelecting) return;
      pointerSelecting = false;
      lastPointerAt = performance.now();
      if (state.mode === 'edit') onCaretMove();
    });
    editor.addEventListener('keyup', (e) => { if (NAV_KEYS.has(e.key)) onCaretMove(); });

    document.addEventListener('keydown', onDocKeydown);
    let last = null;
    document.addEventListener('mousemove', (e) => {
      if (last && Math.hypot(e.clientX - last.x, e.clientY - last.y) <= 3) return;
      last = { x: e.clientX, y: e.clientY };
      root.classList.remove('is-typing');
      if (state.mode !== 'write' || !canHover.matches) return;
      if (e.clientY <= CHROME_SHOW || chrome.contains(e.target)) showChrome();
      else if (e.clientY > CHROME_HIDE && chrome.classList.contains('is-shown') && !UI.menuOpen()) hideChrome(true);
    });
    // Leaving the window through the top keeps the bar (you overshot it); leaving any other way hides it.
    document.documentElement.addEventListener('mouseleave', (e) => {
      if (state.mode !== 'write' || !canHover.matches || UI.menuOpen()) return;
      if (e.clientY < CHROME_SHOW) showChrome();
      else hideChrome(true);
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
    window.addEventListener('pagehide', saveNow);

    $('btn-drafts').addEventListener('click', () => Dialogs.openDrafts());
    $('btn-settings').addEventListener('click', () => Dialogs.openSettings());
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

  function buildControls() {
    controls.mode = UI.segmented({
      label: 'Mode', value: 'write', class: 'seg-mode',
      options: [{ value: 'write', label: 'Write', title: 'Write (⌘E)' }, { value: 'edit', label: 'Edit', title: 'Edit (⌘E)' }],
      onChange: (v) => setMode(v)
    });
    $('mode-slot').append(controls.mode);

    controls.format = UI.segmented({
      label: 'Format', value: 'basic', class: 'seg-format',
      options: Formats.LIST.map((f) => ({ value: f.key, label: f.label })),
      onChange: (v) => setFormat(v)
    });
    const btn = UI.el('button', { type: 'button', class: 'btn-quiet format-btn', 'aria-label': 'Format' }, 'Basic', UI.icon('chevDown'));
    btn.addEventListener('click', () => {
      const cur = state.draft && state.draft.format;
      UI.menu(btn, Formats.LIST.map((f) => ({ label: f.label, value: f.key, checked: f.key === cur })), (it) => { setFormat(it.value); });
    });
    controls.formatBtn = btn;
    $('format-slot').append(controls.format, btn);

    controls.nb = UI.toggle({ label: 'No backspace', title: 'No backspace in Write mode', onChange: setBackspaceOff });
    $('nb-slot').append(UI.el('span', { class: 'nb-label', 'aria-hidden': 'true', text: 'No backspace' }), controls.nb);
    $('nb-slot').querySelector('.nb-label').addEventListener('click', () => controls.nb.click());
  }

  /* ---------- Boot ---------- */
  function boot() {
    TDW.mockAI = false; // tests switch the fake AI on from JS

    state.settings = Store.getSettings();
    applySettings();
    Sound.init(state.settings);

    $('btn-settings').append(UI.icon('sliders'));
    buildControls();
    Editor.init({
      root: editor, surface: $('surface'), under: $('under'), aids: $('aids'),
      hooks: {
        onChange: onInput,
        onSelect: () => { if (!pointerSelecting) onCaretMove(); },
        canDelete: () => !noBackspace(),
        onBlocked: blocked,
        clipboard
      }
    });
    Editor.setPlaceholder(PLACEHOLDER);
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
    setMode, saveNow, openDraft, newDraft, draftDeleted, analyze, setFormat,
    updateSettings, toggleHighlight, hiddenTypes, setBudget, setIntent, setProp, edit, cut, insertSample,
    addWord, removeWord, refreshPanel, updateSyncStatus, openSettings: (section) => Dialogs.openSettings(section),
    syncChanged() { onList(); },
    backspaceOff
  };
  boot();
})();
