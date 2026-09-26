/* Edit-mode panel: register, details, grade, fixes, and AI results. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};
  const { el, icon, money, plural, reducedMotion } = TDW.UI;
  const { Engine, Editor } = TDW;
  const app = () => TDW.App;
  const $ = (id) => document.getElementById(id);

  const ORDER = ['spelling', 'veryHard', 'hard', 'complex', 'passive', 'adverb', 'qualifier'];
  const NAMES = {
    spelling: 'spelling mistakes', veryHard: 'very hard sentences', hard: 'hard sentences', complex: 'wordy phrases',
    passive: 'passive voice', adverb: 'adverbs', qualifier: 'weakeners'
  };
  const VERDICT = { clear: ['Clear', 'good'], mixed: ['Mixed', 'ok'], unclear: ['Unclear', 'bad'] };
  const MATCH = { yes: 'Yes', partly: 'Partly', no: 'No' };
  const GRADE_CLASS = { Good: 'good', OK: 'ok', Hard: 'bad' };

  const rows = {};
  let shownSpent = null;
  let tweenRaf = 0;
  let refundEl = null;
  let refundTotal = 0;
  let lastDropAt = 0;
  let aiCtrl = null;
  let current = { draft: null };

  /* ---------- Fix rows ---------- */
  function rowCopy(type, n, a) {
    const b = (x) => el('b', { text: String(x) });
    const total = a ? a.sentences : 0;
    const t = a ? a.targets : { adverb: 0, passive: 0 };
    switch (type) {
      case 'spelling': return n === 0 ? ['No spelling mistakes.'] : [b(n), n === 1 ? ' spelling mistake.' : ' spelling mistakes.'];
      case 'veryHard': return n === 0 ? ['No very hard sentences.'] : [b(n), ' of ' + total + ' sentences ' + (n === 1 ? 'is' : 'are') + ' very hard to read.'];
      case 'hard': return n === 0 ? ['No hard sentences.'] : [b(n), ' of ' + total + ' sentences ' + (n === 1 ? 'is' : 'are') + ' hard to read.'];
      case 'complex': return n === 0 ? ['No wordy phrases.'] : n === 1 ? [b(1), ' phrase has a simpler option.'] : [b(n), ' phrases have simpler options.'];
      case 'passive': return n === 0 ? ['No passive voice.'] : [b(n), (n === 1 ? ' use' : ' uses') + ' of passive voice. Aim for ' + t.passive + ' or fewer.'];
      case 'adverb': return n === 0 ? ['No adverbs.'] : [b(n), (n === 1 ? ' adverb' : ' adverbs') + '. Aim for ' + t.adverb + ' or fewer.'];
      default: return n === 0 ? ['No weakeners.'] : n === 1 ? [b(1), ' weakener. Cut it to sound sure.'] : [b(n), ' weakeners. Cut them to sound sure.'];
    }
  }

  function buildRows() {
    const list = $('issue-list');
    for (const type of ORDER) {
      const text = el('span', { class: 'issue-text' });
      const jump = el('button', { type: 'button', class: 'issue-jump', onclick: () => jumpTo(type) },
        el('span', { class: 'swatch sw-' + type, 'aria-hidden': 'true' }), text);
      const eye = el('button', {
        type: 'button', class: 'issue-eye',
        onclick: () => { app().toggleHighlight(type); updateEye(type); }
      });
      const li = el('li', { class: 'issue-row', dataset: { type } }, jump, eye);
      rows[type] = { li, jump, text, eye, on: null };
      list.append(li);
    }
  }

  function updateEye(type) {
    const on = app().state.settings.highlights[type] !== false;
    const r = rows[type];
    if (r.on === on) return;
    r.on = on;
    r.eye.setAttribute('aria-pressed', String(on));
    r.eye.setAttribute('aria-label', (on ? 'Hide ' : 'Show ') + NAMES[type]);
    r.eye.replaceChildren(icon(on ? 'eye' : 'eyeOff'));
  }

  function jumpTo(type) {
    const a = app().state.analysis;
    if (!a) return;
    const list = a.issues.filter((i) => i.type === type);
    if (!list.length) return;
    const caret = Editor.caretIndex();
    let index = list.findIndex((i) => i.start > caret);
    if (index < 0) index = 0;
    const issue = list[index];
    app().state.cycle = { type, index };
    Editor.select(issue.start, issue.end);
    TDW.Popover.show(issue);
  }

  /* ---------- Register ---------- */
  function tweenTo(to) {
    const node = $('reg-spent');
    cancelAnimationFrame(tweenRaf);
    if (shownSpent === null || shownSpent === to || reducedMotion()) {
      shownSpent = to;
      node.textContent = to.toLocaleString('en-US');
      return;
    }
    const from = shownSpent;
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 250);
      shownSpent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      node.textContent = shownSpent.toLocaleString('en-US');
      if (k < 1) tweenRaf = requestAnimationFrame(step);
    };
    tweenRaf = requestAnimationFrame(step);
  }

  function renderRegister(draft, words) {
    const spent = words * 10;
    const budget = draft.budget;
    const over = spent > budget;
    tweenTo(spent);
    $('reg-fill').style.width = Math.min(spent / budget, 1) * 100 + '%';
    $('register').classList.toggle('is-over', over);
    $('reg-stamp').hidden = !over;
    $('reg-budget').textContent = money(budget);
  }

  function refund(droppedWords) {
    const now = Date.now();
    refundTotal = (refundEl && now - lastDropAt < 700 ? refundTotal : 0) + droppedWords * 10;
    lastDropAt = now;
    if (refundEl) refundEl.remove();
    const spent = $('reg-spent');
    const chip = el('div', { class: 'refund', 'aria-hidden': 'true', text: '+' + money(refundTotal) });
    chip.style.left = spent.offsetLeft + spent.offsetWidth + 10 + 'px';
    chip.style.top = spent.offsetTop + 4 + 'px';
    $('register').append(chip);
    refundEl = chip;
    setTimeout(() => {
      chip.remove();
      if (refundEl === chip) refundEl = null;
    }, 900);
  }

  function openBudget() {
    const input = $('budget-input');
    input.value = String(current.draft ? current.draft.budget : 2000);
    $('budget-form').hidden = false;
    input.focus();
    input.select();
  }

  function closeBudget(focusLink) {
    if ($('budget-form').hidden) return;
    $('budget-form').hidden = true;
    if (focusLink) $('reg-budget').focus();
  }

  function submitBudget(e) {
    e.preventDefault();
    const input = $('budget-input');
    const v = Math.round(Number(input.value) / 10) * 10;
    if (!(v >= 10)) { input.focus(); return; }
    app().setBudget(v);
    closeBudget(true);
  }

  /* ---------- Mobile sheet ---------- */
  function setSheet(open) {
    const panel = $('panel');
    panel.classList.toggle('is-open', open);
    $('panel-handle').setAttribute('aria-expanded', String(open));
    if (!open) panel.scrollTop = 0;
  }

  /* ---------- Render ---------- */
  function updateAI() {
    const none = TDW.AI.status() === 'none';
    $('ai-note').textContent = none ? 'Connect Gemini in Settings to use AI help.' : '';
    const blocked = !none && (app().state.aiBusy || !Editor.getText().trim());
    $('ai-tighten').disabled = blocked;
    $('ai-message').disabled = blocked;
  }

  function render(a, draft, words) {
    current = { draft };
    renderRegister(draft, words);

    const grade = $('grade-num');
    const pill = $('grade-pill');
    if (!words || !a) {
      grade.textContent = 'Grade —';
      pill.hidden = true;
    } else {
      const label = Engine.gradeLabel(a.grade);
      grade.textContent = 'Grade ' + a.grade;
      pill.textContent = label;
      pill.className = 'pill ' + GRADE_CLASS[label];
      pill.hidden = false;
    }

    $('issue-list').hidden = !words;
    $('issues-empty').hidden = !!words;
    for (const type of ORDER) {
      const n = a ? a.counts[type] : 0;
      const r = rows[type];
      r.text.replaceChildren(...rowCopy(type, n, a));
      r.li.classList.toggle('is-zero', n === 0);
      r.jump.setAttribute('aria-disabled', String(n === 0));
      updateEye(type);
    }

    // The numbers behind the amount, on hover.
    const amount = document.querySelector('.reg-amount');
    if (words && a) {
      const chars = Editor.getText().length;
      const min = Math.max(1, Math.round(a.readingTimeSec / 60));
      amount.title = words + ' ' + plural(words, 'word', 'words') + ' · ' + chars + ' ' +
        plural(chars, 'character', 'characters') + ' · ' + min + ' min read';
    } else {
      amount.removeAttribute('title');
    }

    updateAI();

    const fixes = a ? a.issues.length : 0;
    $('panel-summary').textContent = money(words * 10) + ' of ' + money(draft.budget) +
      ' · Grade ' + (words && a ? a.grade : '—') + ' · ' + fixes + ' ' + plural(fixes, 'fix', 'fixes');
  }

  /* ---------- AI results ---------- */
  const HIDE_FOR_RESULTS = ['issues', 'ai-desk'];
  const show = (...nodes) => $('ai-body').replaceChildren(...nodes);

  function setBusy(busy) {
    app().state.aiBusy = busy;
    updateAI();
  }

  function stopAI() {
    if (aiCtrl) { aiCtrl.abort(); aiCtrl = null; }
    if (app().state.aiBusy) setBusy(false);
  }

  function openResults() {
    for (const id of HIDE_FOR_RESULTS) $(id).hidden = true;
    $('ai-results').hidden = false;
  }

  function closeResults() {
    stopAI();
    if ($('ai-results').hidden) return;
    $('ai-results').hidden = true;
    for (const id of HIDE_FOR_RESULTS) $(id).hidden = false;
    $('ai-body').replaceChildren();
  }

  function runAI(call, onDone, retry) {
    stopAI();
    const ctrl = new AbortController();
    aiCtrl = ctrl;
    setBusy(true);
    show(el('div', { class: 'ai-loading' },
      el('span', { text: 'Thinking…' }),
      el('button', { type: 'button', class: 'btn-quiet', text: 'Stop', onclick: closeResults })));
    call(ctrl.signal).then((out) => {
      if (aiCtrl !== ctrl) return;
      aiCtrl = null;
      setBusy(false);
      onDone(out);
    }, (err) => {
      if (aiCtrl !== ctrl) return;
      aiCtrl = null;
      setBusy(false);
      if (err && err.code === 'cancelled') return;
      show(el('div', { class: 'ai-block' },
        el('p', { class: 'ai-error', text: TDW.AI.errorMessage(err) }),
        el('button', { type: 'button', class: 'btn-outline', text: 'Try again', onclick: retry })));
    });
  }

  function startTighten() {
    if (TDW.AI.status() === 'none') { app().openSettings('ai'); return; }
    const text = Editor.getText();
    const s = Editor.getSelection();
    const input = s.end - s.start > 20 ? text.slice(s.start, s.end) : text;
    if (!input.trim()) return;
    openResults();
    runAI((signal) => TDW.AI.tighten({ text: input }, signal), renderTighten, startTighten);
  }

  // Cut or replace one AI edit in the live text. Returns false when the quote is gone.
  function applyEdit(ed) {
    if (ed.done) return false;
    ed.done = true;
    ed.row.classList.add('is-done');
    const text = Editor.getText();
    const idx = text.indexOf(ed.find);
    if (idx === -1) {
      ed.btn.replaceWith(el('span', { class: 'edit-note', text: 'Text changed. Skipped.' }));
      return false;
    }
    if (ed.replace === '') {
      let a = idx, b = idx + ed.find.length;
      while (a < b && /\s/.test(text[a])) a++;
      while (b > a && /\s/.test(text[b - 1])) b--;
      const sentence = Engine.analyze(text).sentenceList.find((r) => r.start <= a && a < r.end);
      const plan = Editor.cutPlan(text, a, b, sentence ? sentence.start : -1);
      app().edit(plan.start, plan.end, plan.replacement, { silent: true });
    } else {
      app().edit(idx, idx + ed.find.length, ed.replace, { silent: true });
    }
    ed.btn.textContent = 'Applied';
    ed.btn.disabled = true;
    return true;
  }

  function renderTighten(out) {
    const edits = out.edits
      .map((e) => Object.assign({}, e, { save: (Engine.countWords(e.find) - Engine.countWords(e.replace)) * 10 }))
      .filter((e) => e.save > 0);
    const block = el('div', { class: 'ai-block' });
    if (out.truncated) block.append(el('p', { class: 'hint', text: 'Only the first 60,000 characters were checked.' }));
    if (!edits.length) {
      block.append(el('p', { text: "Nothing to cut. It's tight already." }));
      show(block);
      return;
    }
    if (out.summary) block.append(el('p', { text: out.summary }));

    const allBtn = el('button', { type: 'button', class: 'btn' });
    const syncAll = () => {
      const left = edits.filter((e) => !e.done);
      allBtn.textContent = 'Apply all · saves ' + money(left.reduce((sum, e) => sum + e.save, 0));
      allBtn.hidden = !left.length;
    };
    const coin = () => { if (app().state.mode === 'edit') TDW.Sound.play('coin'); };

    const list = el('ul', { class: 'edit-list' });
    for (const ed of edits) {
      ed.btn = el('button', { type: 'button', class: 'btn-outline btn-sm', text: 'Apply' });
      ed.row = el('li', { class: 'edit-row' },
        el('div', { class: 'edit-change' },
          el('s', { class: 'edit-find', text: ed.find }), ' → ',
          ed.replace ? el('span', { text: ed.replace }) : el('span', { class: 'edit-cut', text: 'cut' })),
        ed.why ? el('p', { class: 'edit-why', text: ed.why }) : null,
        el('div', { class: 'edit-foot' }, el('span', { class: 'save-badge', text: '−' + money(ed.save) }), ed.btn));
      ed.btn.addEventListener('click', () => { if (applyEdit(ed)) coin(); syncAll(); });
      list.append(ed.row);
    }
    allBtn.addEventListener('click', () => {
      let any = false;
      for (const ed of edits) if (applyEdit(ed)) any = true;
      if (any) coin();
      syncAll();
    });
    syncAll();
    block.append(allBtn, list);
    show(block);
  }

  function startMessage() {
    if (TDW.AI.status() === 'none') { app().openSettings('ai'); return; }
    if (!Editor.getText().trim()) return;
    stopAI();
    openResults();
    const area = el('textarea', { id: 'msg-intent', class: 'field', rows: '3' });
    area.value = (current.draft && current.draft.intent) || '';
    const form = el('form', { class: 'msg-form' },
      el('label', { for: 'msg-intent', text: 'What should readers take away? (optional)' }),
      area,
      el('div', null, el('button', { type: 'submit', class: 'btn', text: 'Check' })));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const intent = area.value.trim();
      app().setIntent(intent);
      runMessage(intent);
    });
    show(form);
    area.focus();
  }

  function runMessage(intent) {
    runAI((signal) => TDW.AI.messageCheck({ text: Editor.getText(), intent }, signal), renderMessage, () => runMessage(intent));
  }

  function sharper(label, text, btnLabel, which) {
    const btn = el('button', { type: 'button', class: 'btn-outline btn-sm', text: btnLabel });
    btn.addEventListener('click', () => {
      const list = Engine.analyze(Editor.getText()).sentenceList;
      const r = which === 'first' ? list[0] : list[list.length - 1];
      if (!r) return;
      app().edit(r.start, r.end, text);
      btn.disabled = true;
    });
    return el('div', { class: 'ai-block' }, el('div', { class: 'label', text: label }), el('p', { class: 'sharper', text }), btn);
  }

  function renderMessage(out) {
    const head = el('div', { class: 'ai-block' },
      el('div', { class: 'label', text: 'Readers will take away' }),
      el('p', { class: 'takeaway', text: out.takeaway }));
    const verdict = VERDICT[out.verdict];
    if (verdict) head.append(el('span', { class: 'pill ' + verdict[1], text: verdict[0] }));
    if (out.match !== 'none' && MATCH[out.match]) head.append(el('p', null, 'Matches what you meant: ', el('b', { text: MATCH[out.match] })));
    if (out.why) head.append(el('p', { text: out.why }));
    const nodes = [head];
    if (out.offMessage.length) {
      nodes.push(el('div', { class: 'ai-block' },
        el('div', { class: 'label', text: 'Off message' }),
        el('ul', { class: 'off-list' }, out.offMessage.map((o) => el('li', null,
          el('button', {
            type: 'button', class: 'off-quote', text: o.quote,
            onclick: () => {
              const i = Editor.getText().indexOf(o.quote);
              if (i >= 0) Editor.select(i, i + o.quote.length);
            }
          }),
          o.reason ? el('p', { class: 'off-reason', text: o.reason }) : null)))));
    }
    if (out.strongerOpening) nodes.push(sharper('Sharper opening', out.strongerOpening, 'Use as opening', 'first'));
    if (out.strongerEnding) nodes.push(sharper('Sharper ending', out.strongerEnding, 'Use as ending', 'last'));
    show(...nodes);
  }

  /* ---------- Init ---------- */
  function init() {
    buildRows();
    $('panel-handle').querySelector('.chev').append(icon('chevUp'));
    $('panel-handle').addEventListener('click', () => setSheet(!$('panel').classList.contains('is-open')));
    $('reg-budget').addEventListener('click', openBudget);
    const form = $('budget-form');
    form.noValidate = true;
    form.addEventListener('submit', submitBudget);
    $('budget-cancel').addEventListener('click', () => closeBudget(true));
    $('btn-sample').addEventListener('click', () => app().insertSample());
    $('ai-tighten').addEventListener('click', startTighten);
    $('ai-message').addEventListener('click', startMessage);
    $('ai-back').addEventListener('click', closeResults);
  }

  TDW.Panel = {
    init,
    render,
    refund,
    updateAI,
    closeResults,
    closeBudget,
    isBudgetOpen() { return !$('budget-form').hidden; },
    closeSheet() { setSheet(false); },
    isSheetOpen() { return $('panel').classList.contains('is-open'); }
  };
})();
