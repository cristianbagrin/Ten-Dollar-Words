/* Drafts drawer and Settings dialog. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};
  const { el, icon, toast, money, plural, relTime, segmented, toggle, menu, closeMenu, device, keys } = TDW.UI;
  const { Store, Sync, Account } = TDW;
  const app = () => TDW.App;

  const SKINS = [
    ['typewriter', 'Typewriter', 'Putty and ribbon ink.'],
    ['ditto', 'Ditto', 'Purple ink on lilac, like old school handouts.'],
    ['night', 'Night desk', 'Dark navy with mustard light.']
  ];
  const SOUNDS = [['typewriter', 'Typewriter'], ['soft', 'Soft keys'], ['off', 'Off']];
  const STEPS = [
    'Create an internal integration and copy its secret.',
    'In Notion, open the database → ••• → Connections → add it.',
    'Paste the secret and the database link here.'
  ];
  const CHIP_TYPES = new Set(['status', 'select', 'multi_select', 'date', 'checkbox', 'rich_text', 'number', 'url', 'email', 'phone_number']);

  let draftsDlg = null;
  let settingsDlg = null;
  let listEl = null;
  let footNote = null;
  let aiStatus = { text: '', error: false };
  let accountRefresh = null; // redraws the account status in an open Settings

  function wireDialog(dlg) {
    dlg.addEventListener('click', (e) => {
      if (e.target !== dlg) return;
      const r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeDialog(dlg);
    });
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (!TDW.UI.menuOpen()) closeDialog(dlg);
    });
    dlg.addEventListener('close', () => { closeMenu(); TDW.UI.rehostToast(); });
  }

  // Let the closing animation play, then close.
  function closeDialog(dlg) {
    if (!dlg.open || dlg.classList.contains('is-closing')) return;
    closeMenu();
    if (TDW.UI.reducedMotion()) { dlg.close(); return; }
    dlg.classList.add('is-closing');
    setTimeout(() => { dlg.classList.remove('is-closing'); dlg.close(); }, 180);
  }

  const closeButton = (dlg) =>
    el('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Close', onclick: () => closeDialog(dlg) }, icon('close'));

  /* ---------- Drafts drawer ---------- */
  function buildDrafts() {
    listEl = el('ul', { class: 'draft-list' });
    footNote = el('p', { class: 'hint' });
    draftsDlg.append(
      el('div', { class: 'dlg-head' }, el('h2', { id: 'drafts-title', text: 'Drafts', tabindex: '-1', autofocus: true }), closeButton(draftsDlg)),
      el('div', { class: 'drawer-new' },
        el('button', { type: 'button', class: 'btn', onclick: newDraft }, icon('plus'), 'New draft')),
      listEl,
      el('div', { class: 'drawer-foot' }, footNote)
    );
    wireDialog(draftsDlg);
  }

  function renderDraftList() {
    if (!listEl) return;
    const cur = app().state.draft;
    const focusKey = document.activeElement && listEl.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    listEl.replaceChildren(...Store.listDrafts().map((d) => draftRow(d, !!cur && cur.id === d.id)));
    if (focusKey) {
      const again = listEl.querySelector('[data-key="' + CSS.escape(focusKey) + '"]');
      if (again) again.focus({ preventScroll: true });
    }
    const c = Sync.config();
    footNote.textContent = c ? 'Synced with ' + c.dbTitle : 'Drafts live in this browser only. Connect Notion in Settings to sync them.';
  }

  function draftRow(d, isCurrent) {
    const fetched = !(d.notionId && !d.contentFetchedAt && !d.text);
    const words = Store.countWords(d.text);
    const meta = relTime(d.updatedAt) + (fetched ? ' · ' + words + ' ' + plural(words, 'word', 'words') + ' · ' + money(words * 10) : '');
    const title = Store.displayTitle(d);
    const open = () => { closeDialog(draftsDlg); app().openDraft(d.id); };
    const linked = !!(d.url && /^https?:\/\//.test(d.url));
    // The title opens the page in Notion; the rest of the row opens the draft here.
    const titleEl = linked
      ? el('a', { class: 'draft-title is-link', href: d.url, target: '_blank', rel: 'noopener', title: 'Open in Notion', text: title, onclick: (e) => e.stopPropagation() })
      : el('span', { class: 'draft-title', text: title });
    return el('li', { class: 'draft-row' + (isCurrent ? ' is-current' : '') },
      el('div', { class: 'draft-top' },
        el('div', {
          class: 'draft-open', role: 'button', tabindex: '0', 'aria-current': isCurrent ? 'true' : null, dataset: { key: 'open:' + d.id },
          'aria-label': 'Open “' + title + '”', onclick: open,
          onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); open(); } }
        },
        titleEl,
        el('span', { class: 'draft-meta', text: meta })),
        el('button', {
          type: 'button', class: 'btn-icon draft-del', 'aria-label': 'Delete “' + title + '”', title: 'Delete',
          dataset: { key: 'del:' + d.id }, onclick: () => deleteDraft(d.id)
        }, icon('trash'))),
      propChips(d));
  }

  /* ---------- Notion properties as chips ---------- */
  function propChips(d) {
    const c = Sync.config();
    if (!c || d.localOnly || !c.schema) return null;
    const rank = (t) => ['status', 'select', 'multi_select', 'date'].indexOf(t) + 1 || 9;
    const names = Object.keys(c.schema).filter((n) => n !== c.titleProp && CHIP_TYPES.has(c.schema[n].type))
      .sort((x, y) => rank(c.schema[x].type) - rank(c.schema[y].type));
    if (!names.length) return null;
    return el('div', { class: 'draft-props' }, names.map((n) => propChip(d, n, c.schema[n])));
  }

  function showValue(s, v) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '';
    if (s.type === 'multi_select') return v.join(', ');
    if (s.type === 'date') {
      const t = Date.parse(String(v).slice(0, 10) + 'T12:00:00');
      return isNaN(t) ? String(v) : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
    }
    if (s.type === 'checkbox') return v ? '✓' : '';
    return String(v);
  }

  function propChip(d, name, s) {
    const v = d.props[name];
    const shown = showValue(s, v);
    const color = s.colors && typeof v === 'string' ? s.colors[v] : null;
    const chip = el('button', {
      type: 'button', class: 'prop-chip' + (shown ? '' : ' is-empty') + (s.type === 'checkbox' && v ? ' is-on' : ''),
      dataset: { color: color || '', key: 'prop:' + d.id + ':' + name },
      title: name + (shown ? ': ' + shown : ''), 'aria-label': name + ': ' + (shown || 'empty')
    }, shown && s.type !== 'checkbox' ? shown : name);
    const set = (value) => { app().setProp(d, name, value); renderDraftList(); };
    chip.addEventListener('click', () => {
      if (s.type === 'checkbox') { set(!v); return; }
      if (s.type === 'status' || s.type === 'select') {
        const items = (s.options || []).map((o) => ({ label: o, value: o, checked: o === v }));
        if (s.type === 'select' && v) items.push({ type: 'sep' }, { label: 'Clear', value: null });
        menu(chip, items, (it) => set(it.value));
        return;
      }
      if (s.type === 'multi_select') {
        const chosen = new Set(Array.isArray(v) ? v : []);
        menu(chip, (s.options || []).map((o) => ({ label: o, value: o, checked: chosen.has(o) })), (it, btn) => {
          if (chosen.has(it.value)) chosen.delete(it.value); else chosen.add(it.value);
          btn.setAttribute('aria-checked', String(chosen.has(it.value)));
          app().setProp(d, name, [...chosen]);
          return true;
        }, null, renderDraftList);
        return;
      }
      openFieldMenu(chip, d, name, s, v);
    });
    return chip;
  }

  // A small form in a menu, for dates and typed values.
  function openFieldMenu(chip, d, name, s, v) {
    if (s.type === 'date') {
      const cal = TDW.UI.calendar({
        value: v ? String(v).slice(0, 10) : '',
        onPick: (iso) => { app().setProp(d, name, iso || null); closeMenu(); renderDraftList(); }
      });
      menu(chip, [], () => false, cal);
      cal.focusDay();
      return;
    }
    const type = { date: 'date', number: 'number', url: 'url', email: 'email', phone_number: 'tel' }[s.type] || 'text';
    const input = el('input', { type, class: 'menu-input', 'aria-label': name, value: v == null ? '' : s.type === 'date' ? String(v).slice(0, 10) : String(v) });
    const save = () => {
      const raw = input.value.trim();
      const value = raw === '' ? null : s.type === 'number' ? Number(raw) : raw;
      app().setProp(d, name, value);
      closeMenu();
      renderDraftList();
    };
    const form = el('form', { class: 'menu-form' }, el('label', { class: 'menu-form-label', text: name }), input,
      el('div', { class: 'row-end' },
        v != null && v !== '' ? el('button', { type: 'button', class: 'btn-quiet btn-sm', text: 'Clear', onclick: () => { input.value = ''; save(); } }) : null,
        el('button', { type: 'submit', class: 'btn btn-sm', text: 'Save' })));
    form.noValidate = true;
    form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
    if (s.type === 'date') input.addEventListener('change', save);
    menu(chip, [], () => false, form);
    input.focus();
    if (s.type === 'date' && input.showPicker) { try { input.showPicker(); } catch (_) { /* needs a gesture */ } }
  }

  function newDraft() {
    closeDialog(draftsDlg);
    app().newDraft('');
    app().setMode('write');
  }

  function deleteDraft(id) {
    const d = Store.getDraft(id);
    if (!d) return;
    const wasOpen = app().state.draft === d;
    if (wasOpen) app().saveNow();
    const copy = JSON.parse(JSON.stringify(d));
    Sync.trash(d);
    Store.deleteDraft(id);
    app().draftDeleted(id);
    renderDraftList();
    toast('Draft deleted', {
      label: 'Undo',
      run: () => {
        Store.saveDraft(copy);
        Sync.restore(copy);
        if (wasOpen) app().openDraft(copy.id);
        if (draftsDlg.open) renderDraftList();
      }
    });
  }

  function openDrafts() {
    app().saveNow();
    renderDraftList();
    draftsDlg.showModal();
    const cur = listEl.querySelector('.is-current .draft-open');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- Settings ---------- */
  const update = (patch) => app().updateSettings(patch);
  const field = (label, input) => el('div', { class: 'set-field' }, el('label', { for: input.id, class: 'set-sub', text: label }), input);

  function switchRow(label, checked, onChange, hint) {
    const id = 'sw-' + Math.random().toString(36).slice(2, 8);
    const sw = toggle({ checked, onChange, id });
    return el('div', { class: 'switch-row' },
      el('label', { for: id, class: 'switch-text' }, el('span', { text: label }), hint ? el('span', { class: 'hint', text: hint }) : null),
      sw);
  }

  function radio(name, value, checked, onChange) {
    return el('input', { type: 'radio', name, value, class: 'sr-only', checked, onchange: onChange });
  }

  function lookSection(s) {
    return el('section', { class: 'set-sec', 'aria-labelledby': 'set-look' },
      el('h3', { id: 'set-look', class: 'label', text: 'Look' }),
      el('div', { class: 'skins', role: 'radiogroup', 'aria-labelledby': 'set-look' },
        SKINS.map(([value, name, desc]) => el('label', { class: 'skin-card', 'data-skin': value },
          radio('skin', value, s.skin === value, () => update({ skin: value })),
          el('span', { class: 'skin-sample', 'aria-hidden': 'true', text: 'Aa' }),
          el('span', { class: 'skin-name' }, el('span', { class: 'skin-dot', 'aria-hidden': 'true' }), name),
          el('span', { class: 'skin-desc', text: desc })))));
  }

  function soundSection(s) {
    const vol = el('input', {
      type: 'range', id: 'set-volume', min: '0', max: '1', step: '0.05', value: String(s.volume),
      oninput: () => TDW.Sound.setVolume(Number(vol.value)),
      onchange: () => update({ volume: Number(vol.value) })
    });
    const test = () => {
      TDW.Sound.unlock();
      ['key', 'key', 'space', 'key', 'enter'].forEach((k, i) => setTimeout(() => TDW.Sound.play(k), i * 90));
    };
    return el('section', { class: 'set-sec', 'aria-labelledby': 'set-sound' },
      el('h3', { id: 'set-sound', class: 'label', text: 'Sound' }),
      el('div', { class: 'set-field' },
        el('span', { class: 'set-sub', text: 'Typing sound' }),
        segmented({
          label: 'Typing sound', value: s.sound,
          options: SOUNDS.map(([value, label]) => ({ value, label })),
          onChange: (v) => { update({ sound: v }); if (v !== 'off') test(); }
        })),
      el('div', { class: 'set-field' },
        el('label', { for: 'set-volume', class: 'set-sub', text: 'Volume' }),
        el('div', { class: 'range-row' }, vol,
          el('button', { type: 'button', class: 'btn-outline btn-sm', text: 'Test', onclick: test }))),
      device.phone && device.apple ? el('p', { class: 'hint', text: 'Silent mode on your iPhone mutes these sounds.' }) : null);
  }

  function dictionaryField() {
    const box = el('div', { class: 'dict' });
    const render = () => {
      const words = app().state.settings.dictionary;
      box.replaceChildren(...(words.length
        ? words.map((w) => el('span', { class: 'dict-chip' }, w,
          el('button', {
            type: 'button', class: 'dict-x', 'aria-label': 'Remove ' + w,
            onclick: () => { app().removeWord(w); render(); }
          }, icon('close'))))
        : [el('p', { class: 'hint', text: 'Words you add show up here.' })]));
    };
    render();
    return el('div', { class: 'set-field' }, el('span', { class: 'set-sub', text: 'Your dictionary' }), box);
  }

  function writingSection(s) {
    const size = el('input', {
      type: 'range', id: 'set-size', min: '-2', max: '4', step: '1', value: String(s.textSize),
      oninput: () => update({ textSize: Number(size.value) })
    });
    return el('section', { class: 'set-sec', 'aria-labelledby': 'set-writing' },
      el('h3', { id: 'set-writing', class: 'label', text: 'Writing' }),
      switchRow("Keep the line you're typing in the middle", !!s.typewriterScroll, (on) => update({ typewriterScroll: on }), 'Write mode'),
      switchRow('Turn off backspace when the stage says “no backspace”', !!s.noBackspace, (on) => update({ noBackspace: on }),
        'The No backspace switch in the top bar can override it for any draft.'),
      el('div', { class: 'set-field' },
        el('span', { class: 'set-sub', text: 'New drafts use' }),
        segmented({
          label: 'New drafts use', value: TDW.Formats.get(s.defaultFormat).key,
          options: TDW.Formats.LIST.map((f) => ({ value: f.key, label: f.label })),
          onChange: (v) => update({ defaultFormat: v })
        })),
      field('Text size', size),
      dictionaryField(),
      el('p', { class: 'hint', text: shortcutsText() }));
  }

  function shortcutsText() {
    if (device.phone) {
      return 'Formatting as you type: # and a space makes a heading, - a bullet, 1. a numbered list, [] a checkbox, > a quote, ' +
        '--- a divider (in X, a new post). **Two stars** around words make them bold, *one* makes them italic.';
    }
    return 'Shortcuts: ' + keys('⌘E') + ' switches Write and Edit.' + (device.apple ? ' ⌃← and ⌃→ switch the format.' : '') +
      ' ' + keys('⌘B') + ' bold, ' + keys('⌘I') + ' italic, ' + keys('⌘⇧S') + ' strike, ' + keys('⌘K') + ' link, ' +
      keys('⌘⌥1') + '–3 headings. In X, ' + keys('⌘↩') + ' starts a new post.';
  }

  function budgetSection(s) {
    const input = el('input', {
      type: 'number', id: 'set-budget', min: '10', step: '10', inputmode: 'numeric', value: String(s.defaultBudget),
      onchange: () => {
        const n = Math.round(Number(input.value) / 10) * 10;
        if (n >= 10) update({ defaultBudget: n });
        input.value = String(app().state.settings.defaultBudget);
      }
    });
    return el('section', { class: 'set-sec', 'aria-labelledby': 'set-budget-title' },
      el('h3', { id: 'set-budget-title', class: 'label', text: 'Budget' }),
      el('div', { class: 'set-field' },
        el('label', { for: 'set-budget', class: 'set-sub', text: 'Default budget for Basic drafts' }),
        el('div', { class: 'money-input' }, el('span', { text: '$' }), input)));
  }

  function notionSection() {
    const sec = el('section', { id: 'set-notion', class: 'set-sec', 'aria-labelledby': 'set-notion-title' });
    const heading = () => el('h3', { id: 'set-notion-title', class: 'label', text: 'Notion sync' });
    const render = () => {
      const c = Sync.config();
      if (c) {
        const st = Sync.status();
        const off = el('button', { type: 'button', class: 'btn-quiet danger', text: 'Disconnect' });
        off.addEventListener('click', () => { Sync.disconnect(); render(); app().syncChanged(); });
        sec.replaceChildren(...[heading(),
          el('p', { text: 'Synced with ' + c.dbTitle + '.' }),
          el('p', { class: 'hint', text: (st.at ? 'Last sync ' + relTime(st.at) + '. ' : '') + (Account.state().signedIn
            ? 'The secret is saved to your account, so your other devices have it too.'
            : 'The secret stays saved in this browser. Sign in above to have it on your other devices too.') }),
          el('div', null, off)].filter(Boolean));
        return;
      }
      const secret = el('input', { type: 'password', id: 'set-notion-secret', autocomplete: 'off', spellcheck: 'false', placeholder: 'ntn_…' });
      const link = el('input', { type: 'text', id: 'set-notion-link', autocomplete: 'off', spellcheck: 'false', inputmode: 'url' });
      const n = Store.listDrafts().filter((d) => !d.notionId && (d.text.trim() || d.title.trim())).length;
      let upload = true;
      const status = el('p', { class: 'ai-status', 'aria-live': 'polite' });
      const go = el('button', { type: 'button', class: 'btn', text: 'Connect' });
      go.addEventListener('click', () => {
        go.disabled = true;
        status.classList.remove('is-error');
        status.textContent = 'Connecting…';
        Sync.connect(secret.value, link.value, { uploadLocal: n > 0 && upload }).then(() => {
          render();
          app().syncChanged();
        }, (e) => {
          status.textContent = (e && e.message) || 'Something went wrong.';
          status.classList.add('is-error');
          go.disabled = false;
        });
      });
      sec.replaceChildren(...[heading(),
        el('p', { class: 'hint' }, 'Keep every draft in a Notion database, both ways. ',
          el('a', { href: 'https://www.notion.so/profile/integrations', target: '_blank', rel: 'noopener', text: 'Create an integration' })),
        el('ol', { class: 'steps' }, STEPS.map((t) => el('li', { text: t }))),
        field('Integration secret', secret),
        field('Database link', link),
        n > 0 ? switchRow('Also add my ' + n + ' ' + plural(n, 'draft', 'drafts') + ' from this device', true, (on) => { upload = on; }) : null,
        el('div', null, go),
        status].filter(Boolean));
    };
    render();
    return sec;
  }

  function aiSection() {
    const AI = TDW.AI;
    const keyInput = el('input', { type: 'password', id: 'set-key', autocomplete: 'off', spellcheck: 'false' });
    const status = el('p', { class: 'ai-status', 'aria-live': 'polite' });
    const modelSel = el('select', { id: 'set-model' });
    const modelHint = el('p', { class: 'hint' });
    const modelField = el('div', { class: 'set-field' }, el('label', { for: 'set-model', class: 'set-sub', text: 'Model' }), modelSel, modelHint);
    const removeBtn = el('button', { type: 'button', class: 'btn-quiet danger', text: 'Remove key' });
    const testBtn = el('button', { type: 'button', class: 'btn', text: 'Save and test' });
    const short = (n) => String(n || '').replace(/^models\//, '');

    const showStatus = () => {
      status.textContent = aiStatus.text;
      status.classList.toggle('is-error', aiStatus.error);
    };
    // A saved key is never put back in the field; the placeholder shows its last 4 characters.
    const showKey = () => {
      const key = Store.getKey();
      keyInput.value = '';
      keyInput.placeholder = key ? 'Key saved ••••' + key.slice(-4) : '';
    };
    const fillModels = () => {
      const listing = AI.listing();
      const auto = Store.getModelMode() === 'auto';
      const current = Store.getModel();
      const best = AI.bestModel(listing) || current;
      const names = [...new Set([...AI.usableModels(listing), current].filter(Boolean))];
      modelSel.replaceChildren(
        el('option', { value: 'auto', text: 'Automatic' + (best ? ' (' + short(best) + ')' : '') }),
        ...names.map((n) => el('option', { value: n, text: short(n) })));
      modelSel.value = auto ? 'auto' : current;
      modelHint.textContent = auto
        ? 'Recommended. Uses the newest Flash model, checks for a newer one each week, and falls back when Google is busy.'
        : 'Pinned. If it fails, the app still falls back to other models for that request.';
      const hasKey = !!Store.getKey();
      modelField.hidden = !hasKey;
      removeBtn.hidden = !hasKey;
    };
    modelSel.addEventListener('change', () => {
      if (modelSel.value === 'auto') AI.useAuto(); else AI.useModel(modelSel.value);
      aiStatus = { text: 'Using ' + short(Store.getModel()) + '.', error: false };
      showStatus();
      fillModels();
    });

    testBtn.addEventListener('click', () => {
      testBtn.disabled = true;
      aiStatus = { text: 'Testing…', error: false };
      showStatus();
      AI.connect(keyInput.value).then((res) => {
        aiStatus = { text: 'Connected. Using ' + short(res.model) + (Account.state().signedIn ? '. The key is saved to your account.' : '. The key stays saved in this browser.'), error: false };
      }, (err) => {
        aiStatus = { text: err && err.detail ? 'Something went wrong: ' + err.detail : AI.errorMessage(err), error: true };
      }).then(() => {
        testBtn.disabled = false;
        showKey();
        showStatus();
        fillModels();
        app().refreshPanel();
      });
    });
    removeBtn.addEventListener('click', () => {
      AI.disconnect();
      aiStatus = { text: '', error: false };
      showKey();
      showStatus();
      fillModels();
      app().refreshPanel();
    });

    if (!aiStatus.text && Store.getKey() && Store.getModel()) {
      aiStatus = { text: 'Connected. Using ' + short(Store.getModel()) + '.', error: false };
    }
    showKey();
    showStatus();
    fillModels();

    return el('section', { id: 'set-ai', class: 'set-sec', 'aria-labelledby': 'set-ai-title' },
      el('h3', { id: 'set-ai-title', class: 'label', text: 'AI help (Gemini)' }),
      el('p', { class: 'hint' },
        Account.state().signedIn
          ? 'Paste a Gemini API key once. Only Google gets to use it; your account keeps an encrypted copy for your other devices. '
          : 'Paste a Gemini API key once. It stays in this browser and is only sent to Google. ',
        el('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener', text: 'Get a free key at Google AI Studio' })),
      el('div', { class: 'set-field' },
        el('label', { for: 'set-key', class: 'set-sub', text: 'API key' }),
        el('div', { class: 'key-row' }, keyInput, testBtn)),
      status,
      modelField,
      el('div', null, removeBtn),
      el('p', { class: 'hint', text: "On Google's free tier, Google may use what you send to improve its products. Keep private client work out, or use a paid key." }));
  }

  /* ---------- Account ---------- */
  function accountSection() {
    const sec = el('section', { id: 'set-account', class: 'set-sec', 'aria-labelledby': 'set-account-title' });
    const heading = () => el('h3', { id: 'set-account-title', class: 'label', text: 'Account' });
    const status = el('p', { class: 'ai-status', 'aria-live': 'polite' });
    let mode = 'in';   // signed out: 'in' or 'up'
    let open = null;   // signed in: 'password', 'delete' or null
    let busy = false;

    const say = (text, error) => {
      status.textContent = text || '';
      status.classList.toggle('is-error', !!error);
    };
    const input = (type, id, autocomplete, extra) => el('input', Object.assign({ type, id, name: id, autocomplete, spellcheck: 'false', autocapitalize: 'off' }, extra || {}));
    const field = (label, inp, hint) => el('div', { class: 'set-field' }, el('label', { for: inp.id, class: 'set-sub', text: label }), inp, hint ? el('p', { class: 'hint', text: hint }) : null);

    // Runs a form's action with the button busy; errors show under the form.
    async function run(btn, label, fn) {
      if (busy) return;
      busy = true;
      btn.disabled = true;
      say(label);
      try {
        await fn();
        say('');
      } catch (e) {
        say((e && e.message) || 'Something went wrong.', true);
      } finally {
        busy = false;
        btn.disabled = false;
      }
    }

    function syncLine() {
      const st = Account.state();
      if (st.status === 'syncing') return 'Saving…';
      if (st.status === 'offline') return "You're offline. Changes wait until you're back.";
      if (st.status === 'error') return st.message;
      return st.at ? 'Last synced ' + relTime(st.at) + '.' : '';
    }

    function signedOutView() {
      const email = input('email', 'acct-email', 'username', { inputmode: 'email', value: Account.lastEmail() });
      const pw = input('password', 'acct-password', mode === 'up' ? 'new-password' : 'current-password', { minlength: '8' });
      const go = el('button', { type: 'submit', class: 'btn', text: mode === 'up' ? 'Create account' : 'Sign in' });
      const form = el('form', { class: 'acct-form' },
        field('Email', email),
        field('Password', pw, mode === 'up' ? "At least 8 characters. There's no way to reset it yet, so let your password manager save it." : ''),
        el('div', null, go));
      form.noValidate = true;
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!email.value.trim()) { email.focus(); return; }
        if (!pw.value) { pw.focus(); return; }
        const up = mode === 'up';
        run(go, up ? 'Creating your account…' : 'Signing in…', async () => {
          if (up) await Account.signUp(email.value, pw.value);
          else await Account.signIn(email.value, pw.value);
          render();
          refreshSettings();
          TDW.App.syncChanged();
          toast(up ? 'Account created. This browser’s keys and settings are saved to it.' : 'Signed in. Your keys and settings are here.');
        });
      });
      const pick = segmented({
        label: 'Account', value: mode,
        options: [{ value: 'in', label: 'Sign in' }, { value: 'up', label: 'Create account' }],
        onChange: (v) => { mode = v; say(''); render(); document.getElementById('acct-email').focus(); }
      });
      return [
        el('p', { class: 'hint', text: 'Sign in to have your Notion connection, Gemini key, settings and dictionary on every device you write on.' }),
        device.phone ? el('p', { class: 'hint', text: 'Easiest: connect Notion and Gemini on your computer, then sign in here.' }) : null,
        pick, form
      ];
    }

    function signedInView() {
      const st = Account.state();
      const out = el('button', { type: 'button', class: 'btn-outline', text: 'Sign out' });
      out.addEventListener('click', () => run(out, 'Signing out…', async () => {
        await Account.signOut();
        render();
        refreshSettings();
        TDW.App.syncChanged();
        toast('Signed out. Your keys and Notion connection left this browser.');
      }));
      const nodes = [
        el('p', null, 'Signed in as ', el('b', { text: st.email }), '.'),
        el('p', { class: 'hint' }, 'Your Notion connection, Gemini key, settings, dictionary and draft formats are saved to your account, encrypted with your password. ',
          el('span', { class: 'acct-sync', text: syncLine() })),
        el('div', { class: 'acct-actions' }, out,
          el('button', { type: 'button', class: 'btn-quiet', text: 'Change password', 'aria-expanded': String(open === 'password'), onclick: () => { open = open === 'password' ? null : 'password'; say(''); render(); } }),
          el('button', { type: 'button', class: 'btn-quiet danger', text: 'Delete account', 'aria-expanded': String(open === 'delete'), onclick: () => { open = open === 'delete' ? null : 'delete'; say(''); render(); } })),
        el('p', { class: 'hint', text: 'Signing out takes your keys and Notion connection out of this browser. Your drafts stay.' })
      ];
      // A hidden username tells the password manager which entry this is.
      const who = input('email', 'acct-user', 'username', { value: st.email, hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
      if (open === 'password') {
        const cur = input('password', 'acct-current', 'current-password');
        const next = input('password', 'acct-new', 'new-password', { minlength: '8' });
        const go = el('button', { type: 'submit', class: 'btn', text: 'Change password' });
        const form = el('form', { class: 'acct-form acct-sub' }, who,
          field('Current password', cur), field('New password', next, 'At least 8 characters. Your other devices will ask you to sign in again.'),
          el('div', { class: 'row-start' }, go, el('button', { type: 'button', class: 'btn-quiet', text: 'Cancel', onclick: () => { open = null; say(''); render(); } })));
        form.noValidate = true;
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          run(go, 'Changing your password…', async () => {
            await Account.changePassword(cur.value, next.value);
            open = null;
            render();
            toast('Password changed.');
          });
        });
        nodes.push(form);
      } else if (open === 'delete') {
        const pw = input('password', 'acct-delete', 'current-password');
        const go = el('button', { type: 'submit', class: 'btn btn-danger', text: 'Delete my account' });
        const form = el('form', { class: 'acct-form acct-sub' }, who,
          el('p', { text: 'This deletes your account and everything it keeps. This browser keeps its keys and drafts, and Notion keeps your pages.' }),
          field('Password', pw),
          el('div', { class: 'row-start' }, go, el('button', { type: 'button', class: 'btn-quiet', text: 'Cancel', onclick: () => { open = null; say(''); render(); } })));
        form.noValidate = true;
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          run(go, 'Deleting your account…', async () => {
            await Account.deleteAccount(pw.value);
            open = null;
            render();
            toast('Account deleted.');
          });
        });
        nodes.push(form);
      }
      return nodes;
    }

    let shown = null; // signed in or out, as drawn
    function render() {
      shown = Account.state().signedIn;
      sec.replaceChildren(heading(), ...(shown ? signedInView() : signedOutView()).filter(Boolean), status);
    }
    render();
    accountRefresh = () => {
      if (busy) return;
      if (Account.state().signedIn !== shown) { render(); return; } // signed in or out in another tab
      const line = sec.querySelector('.acct-sync');
      if (line) line.textContent = syncLine();
    };
    return sec;
  }

  // Something outside a section changed what it shows (signing in or out, another device). The
  // account section stays as it is, and so does any section you're typing in.
  function refreshSettings() {
    if (!settingsDlg || !settingsDlg.open) return;
    const body = settingsDlg.querySelector('.settings-body');
    if (!body) return;
    const active = document.activeElement;
    const s = app().state.settings;
    const next = [lookSection(s), writingSection(s), soundSection(s), budgetSection(s), notionSection(), aiSection()];
    [...body.children].slice(1).forEach((old, k) => {
      if (!(active && old.contains(active) && active.matches('input, textarea, select'))) old.replaceWith(next[k]);
    });
  }

  function openSettings(section) {
    const s = app().state.settings;
    settingsDlg.replaceChildren(
      el('div', { class: 'dlg-head' }, el('h2', { id: 'settings-title', text: 'Settings', tabindex: '-1', autofocus: true }), closeButton(settingsDlg)),
      el('div', { class: 'settings-body' },
        accountSection(), lookSection(s), writingSection(s), soundSection(s), budgetSection(s), notionSection(), aiSection()),
      el('p', { class: 'set-foot', text: 'Ten Dollar Words · version ' + app().APP_VERSION }));
    settingsDlg.showModal();
    if (section === 'ai') {
      document.getElementById('set-ai').scrollIntoView({ block: 'start' });
      document.getElementById('set-key').focus({ preventScroll: true });
    } else if (section === 'account') {
      const first = document.getElementById('acct-email');
      if (first) first.focus({ preventScroll: true });
    }
  }

  TDW.Dialogs = {
    init() {
      draftsDlg = document.getElementById('drafts-dialog');
      settingsDlg = document.getElementById('settings-dialog');
      buildDrafts();
      wireDialog(settingsDlg);
      Account.onChange(() => { if (settingsDlg.open && accountRefresh) accountRefresh(); });
    },
    openDrafts,
    openSettings,
    refreshSettings,
    renderDraftList,
    isDraftsOpen() { return !!draftsDlg && draftsDlg.open; }
  };
})();
