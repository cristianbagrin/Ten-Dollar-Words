/* Tips on highlighted text: quick fixes and AI rewrites. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};
  const { el, icon, money, plural, costNote, toast } = TDW.UI;
  const { Engine, Editor } = TDW;
  const app = () => TDW.App;

  const INFO = {
    spelling: ['Spelling', 'Did you mean:'],
    veryHard: ['Very hard to read', 'Readers will lose the thread. Split it or cut it.'],
    hard: ['Hard to read', 'Shorten it or split it in two.'],
    complex: ['Wordy', 'Try:'],
    passive: ['Passive voice', 'Say who did what.'],
    adverb: ['Adverb', 'Cut it, or pick a stronger verb.'],
    qualifier: ['Weakener', 'Say it like you mean it.']
  };
  const INTENSIFIERS = new Set(TDW.Data.INTENSIFIERS);
  const NEXT_WORD = /^[ \t ]+([A-Za-z'’-]+)/;
  const isSentence = (t) => t === 'hard' || t === 'veryHard';

  let pop = null;
  let current = null;
  let ctrl = null;
  let raf = 0;

  function stopAI() {
    if (ctrl) { ctrl.abort(); ctrl = null; }
  }

  function position() {
    if (!current || pop.hidden) return;
    const rect = Editor.markRect(current.id);
    if (!rect) { hide(); return; }
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let top = rect.bottom + 8;
    if (top + h > window.innerHeight) top = rect.top - h - 8;
    // On wide screens keep the tip inside the writing area, clear of the side panel.
    const pr = document.getElementById('panel').getBoundingClientRect();
    const edge = window.innerWidth > 900 && pr.width > 0 ? pr.left : window.innerWidth;
    const left = Math.min(Math.max(rect.left, 16), edge - w - 16);
    pop.style.top = Math.round(top) + 'px';
    pop.style.left = Math.round(left) + 'px';
  }

  function schedule() {
    if (!pop || pop.hidden || raf) return;
    raf = requestAnimationFrame(() => { raf = 0; position(); });
  }

  function hide() {
    stopAI();
    current = null;
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    pop.replaceChildren();
    Editor.setActive(null);
  }

  function sentenceOf(index) {
    const a = app().state.analysis;
    return (a && a.sentenceList.find((r) => r.start <= index && index < r.end)) || null;
  }

  function sentenceStartOf(index) {
    const s = sentenceOf(index);
    return s ? s.start : -1;
  }

  const stillThere = (issue) => Editor.getText().slice(issue.start, issue.end) === issue.text;

  // Delete [start, end) cleanly (one space, sentence stays capitalized).
  function cutRange(issue, start, end) {
    if (!stillThere(issue)) { hide(); return; }
    const plan = Editor.cutPlan(Editor.getText(), start, end, sentenceStartOf(start));
    hide();
    app().edit(plan.start, plan.end, plan.replacement);
  }

  function swap(issue, word) {
    if (!stillThere(issue)) { hide(); return; }
    hide();
    app().edit(issue.start, issue.end, word);
  }

  const cutButton = (issue, amount) =>
    el('button', { type: 'button', class: 'btn', text: 'Cut it · saves ' + money(amount), onclick: () => cutRange(issue, issue.start, issue.end) });

  // A word chip with its money effect: "exhausted · saves $10".
  const chip = (word, savedWords, onclick, note) =>
    el('button', { type: 'button', class: 'chip', title: note || null, onclick }, word,
      el('span', { class: 'chip-note', text: ' · ' + costNote(savedWords) }));

  function aiButton(issue, box) {
    const off = TDW.AI.status() === 'none';
    box.append(el('button', {
      type: 'button', class: 'btn', disabled: off,
      text: issue.type === 'passive' ? 'Rewrite with AI' : 'Simplify with AI',
      onclick: () => runAI(issue, box)
    }));
    if (off) box.append(el('p', { class: 'pop-note', text: 'Connect Gemini in Settings' }));
  }

  // "More options (AI)" / "Stronger word (AI)": AI swaps for a weak phrase, shown as chips.
  function strongerSlot(target, label) {
    const slot = el('div', { class: 'pop-ai' });
    const idle = () => {
      stopAI();
      const off = TDW.AI.status() === 'none';
      slot.replaceChildren(el('button', { type: 'button', class: 'btn-outline', disabled: off, text: label, onclick: run }));
      if (off) slot.append(el('p', { class: 'pop-note', text: 'Connect Gemini in Settings' }));
      position();
    };
    const showError = (err) => {
      slot.replaceChildren(el('p', { class: 'pop-note ai-error', text: TDW.AI.errorMessage(err) }),
        el('button', { type: 'button', class: 'btn-outline', text: 'Try again', onclick: run }));
      position();
    };
    function run() {
      stopAI();
      const c = new AbortController();
      ctrl = c;
      slot.replaceChildren(el('span', { class: 'pop-msg', text: 'Thinking…' }),
        el('button', { type: 'button', class: 'btn-quiet', text: 'Stop', onclick: idle }));
      position();
      const s = sentenceOf(target.start);
      const sentence = s ? Editor.getText().slice(s.start, s.end) : target.phrase;
      TDW.AI.stronger({ phrase: target.phrase, sentence }, c.signal).then((out) => {
        if (ctrl !== c) return;
        ctrl = null;
        if (!out.options.length) { showError({ code: 'bad_json' }); return; }
        const words = Engine.countWords(target.phrase);
        slot.replaceChildren(el('div', { class: 'pop-actions' }, out.options.map((o) => {
          const word = Editor.matchCase(target.phrase, o.text);
          return chip(word, words - Engine.countWords(word), () => applyPhrase(target, word), o.note);
        })));
        position();
      }, (err) => {
        if (ctrl !== c) return;
        ctrl = null;
        if (!err || err.code !== 'cancelled') showError(err);
      });
    }
    idle();
    return slot;
  }

  function applyPhrase(target, word) {
    if (Editor.getText().slice(target.start, target.end) !== target.phrase) { toast('That sentence changed. Run it again.'); return; }
    hide();
    app().edit(target.start, target.end, word);
  }

  // Fills the action row. Returns the message when it differs from the default.
  function fillActions(issue, box) {
    const t = issue.type;
    const words = Engine.countWords(issue.text);
    if (t === 'spelling') {
      const fixes = TDW.Spell.isReady() ? TDW.Spell.suggest(issue.text) : [];
      for (const fix of fixes) box.append(chip(fix, words - Engine.countWords(fix), () => swap(issue, fix)));
      box.append(el('button', { type: 'button', class: 'btn-quiet', text: 'Add to dictionary', onclick: () => app().addWord(issue.text) }));
      return fixes.length ? null : 'No suggestions.';
    }
    if (t === 'adverb') { box.append(cutButton(issue, 10)); return null; }
    if (t === 'qualifier' && issue.suggestion && issue.cut) {
      for (const alt of issue.suggestion.split(', ')) {
        const word = Editor.matchCase(issue.text, alt);
        box.append(chip(word, words - Engine.countWords(alt), () => swap(issue, word)));
      }
      const weak = issue.text.slice(0, issue.cut.end - issue.cut.start);
      box.append(el('button', {
        type: 'button', class: 'btn-outline', text: 'Cut ‘' + weak + '’ · saves ' + money(Engine.countWords(weak) * 10),
        onclick: () => cutRange(issue, issue.cut.start, issue.cut.end)
      }));
      box.append(strongerSlot({ start: issue.start, end: issue.end, phrase: issue.text }, 'More options (AI)'));
      return 'Try one strong word:';
    }
    if (t === 'qualifier') {
      box.append(cutButton(issue, words * 10));
      const text = Editor.getText();
      const next = INTENSIFIERS.has(issue.text.toLowerCase()) && NEXT_WORD.exec(text.slice(issue.end));
      if (next) {
        const end = issue.end + next[0].length;
        box.append(strongerSlot({ start: issue.start, end, phrase: text.slice(issue.start, end) }, 'Stronger word (AI)'));
      }
      return null;
    }
    if (t === 'complex' && !issue.suggestion) { box.append(cutButton(issue, words * 10)); return 'Cut it.'; }
    if (t === 'complex') {
      for (const alt of issue.suggestion.split(', ')) {
        const word = Editor.matchCase(issue.text, alt);
        box.append(chip(word, words - Engine.countWords(alt), () => swap(issue, word)));
      }
      return null;
    }
    aiButton(issue, box);
    return null;
  }

  function useOption(target, newText) {
    const text = Editor.getText();
    let start = target.start;
    let end = target.end;
    if (text.slice(start, end) !== target.original) {
      const i = text.indexOf(target.original);
      if (i < 0) { toast('That sentence changed. Run it again.'); return; }
      start = i;
      end = i + target.original.length;
    }
    hide();
    app().edit(start, end, newText);
  }

  function renderOptions(box, options, target) {
    const before = Engine.countWords(target.original);
    box.replaceChildren(el('ul', { class: 'opt-list' }, options.map((o) => {
      const n = Engine.countWords(o.text);
      return el('li', { class: 'opt' },
        el('p', { class: 'opt-text', text: o.text }),
        el('div', { class: 'opt-foot' },
          el('span', { class: 'opt-meta', text: n + ' ' + plural(n, 'word', 'words') + ' · ' + costNote(before - n) }),
          el('button', { type: 'button', class: 'btn-outline btn-sm', text: 'Use this', onclick: () => useOption(target, o.text) })));
    })));
    position();
  }

  function runAI(issue, box) {
    const text = Editor.getText();
    const range = issue.type === 'passive' ? sentenceOf(issue.start) || issue : issue;
    const original = text.slice(range.start, range.end);
    const ls = text.lastIndexOf('\n', range.start - 1) + 1;
    let le = text.indexOf('\n', range.end);
    if (le < 0) le = text.length;
    const paragraph = text.slice(ls, le);

    stopAI();
    const c = new AbortController();
    ctrl = c;
    const restore = () => { stopAI(); box.replaceChildren(); aiButton(issue, box); position(); };
    box.replaceChildren(el('span', { class: 'pop-msg', text: 'Thinking…' }),
      el('button', { type: 'button', class: 'btn-quiet', text: 'Stop', onclick: restore }));
    position();

    const call = issue.type === 'passive'
      ? TDW.AI.activeVoice({ sentence: original, paragraph, phrase: issue.text }, c.signal)
      : TDW.AI.simplify({ sentence: original, paragraph }, c.signal);
    const showError = (err) => {
      box.replaceChildren(el('p', { class: 'pop-note ai-error', text: TDW.AI.errorMessage(err) }),
        el('button', { type: 'button', class: 'btn-outline', text: 'Try again', onclick: () => runAI(issue, box) }));
      position();
    };
    call.then((out) => {
      if (ctrl !== c) return;
      ctrl = null;
      if (out.options.length) renderOptions(box, out.options, { start: range.start, end: range.end, original });
      else showError({ code: 'bad_json' });
    }, (err) => {
      if (ctrl !== c) return;
      ctrl = null;
      if (!err || err.code !== 'cancelled') showError(err);
    });
  }

  function show(issue) {
    stopAI();
    current = issue;
    const [title, msg] = INFO[issue.type];
    const actions = el('div', { class: 'pop-actions' });
    const message = fillActions(issue, actions) || msg;
    pop.replaceChildren(
      el('div', { class: 'pop-head' },
        el('span', { class: 'swatch sw-' + issue.type, 'aria-hidden': 'true' }),
        el('span', { class: 'pop-title', text: title }),
        el('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Close', onclick: hide }, icon('close'))),
      el('p', { class: 'pop-msg', text: message }),
      actions);
    pop.setAttribute('aria-label', title);
    pop.hidden = false;
    Editor.setActive(issue.id);
    position();
  }

  function showAt(index) {
    const a = app().state.analysis;
    if (!a) { hide(); return; }
    const hidden = app().hiddenTypes();
    const inside = (i) => !hidden.includes(i.type) && i.start <= index && index <= i.end;
    let best = null;
    for (const i of a.issues) {
      if (isSentence(i.type) || !inside(i)) continue;
      if (!best || i.end - i.start < best.end - best.start) best = i;
    }
    if (!best) best = a.issues.find((i) => isSentence(i.type) && inside(i)) || null;
    if (!best) { hide(); return; }
    if (current && current.id === best.id && !pop.hidden) { position(); return; }
    show(best);
  }

  TDW.Popover = {
    init() {
      pop = document.getElementById('popover');
      window.addEventListener('scroll', schedule, { passive: true });
      window.addEventListener('resize', schedule);
      document.addEventListener('pointerdown', (e) => {
        if (pop.hidden || pop.contains(e.target) || document.getElementById('editor').contains(e.target)) return;
        hide();
      });
    },
    show,
    showAt,
    hide,
    isOpen() { return !!pop && !pop.hidden; }
  };
})();
