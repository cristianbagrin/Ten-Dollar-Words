/* Drafts drawer and Settings dialog. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};
  const { el, icon, toast, money, plural, relTime } = TDW.UI;
  const { Store, Sync } = TDW;
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

  let draftsDlg = null;
  let settingsDlg = null;
  let listEl = null;
  let footNote = null;
  let lastModels = null;
  let aiStatus = { text: '', error: false };

  function wireDialog(dlg) {
    dlg.addEventListener('click', (e) => {
      if (e.target !== dlg) return;
      const r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
    });
    dlg.addEventListener('close', () => TDW.UI.rehostToast());
  }

  const closeButton = (dlg) =>
    el('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('close'));

  /* ---------- Drafts drawer ---------- */
  function buildDrafts() {
    listEl = el('ul', { class: 'draft-list' });
    footNote = el('p', { class: 'hint' });
    draftsDlg.append(
      el('div', { class: 'dlg-head' }, el('h2', { id: 'drafts-title', text: 'Drafts' }), closeButton(draftsDlg)),
      el('div', { class: 'drawer-new' },
        el('button', { type: 'button', class: 'btn', text: 'New draft', onclick: newDraft })),
      listEl,
      el('div', { class: 'drawer-foot' }, footNote)
    );
    wireDialog(draftsDlg);
  }

  function stageOf(d) {
    const c = Sync.config();
    const schema = (c && c.schema) || {};
    const name = Object.keys(schema).find((n) => schema[n].type === 'status');
    const v = (name && d.props[name]) || d.props.Stage || d.props.Status;
    return typeof v === 'string' ? v : '';
  }

  function renderDraftList() {
    if (!listEl) return;
    const cur = app().state.draft;
    listEl.replaceChildren(...Store.listDrafts().map((d) => draftRow(d, !!cur && cur.id === d.id)));
    const c = Sync.config();
    footNote.textContent = c ? 'Synced with ' + c.dbTitle : 'Drafts live in this browser only. Connect Notion in Settings to sync them.';
  }

  function draftRow(d, isCurrent) {
    const fetched = !(d.notionId && !d.contentFetchedAt && !d.text);
    const words = Store.countWords(d.text);
    const meta = relTime(d.updatedAt) + ' · ' +
      (fetched ? words + ' ' + plural(words, 'word', 'words') + ' · ' + money(words * 10) : '—');
    const stage = stageOf(d);
    const actions = el('div', { class: 'draft-actions' });
    const showActions = () => actions.replaceChildren(
      el('button', { type: 'button', class: 'btn-quiet btn-sm', text: 'Delete', onclick: showConfirm }));
    function showConfirm() {
      const keep = el('button', { type: 'button', class: 'btn-quiet btn-sm', text: 'Keep', onclick: () => { showActions(); actions.lastChild.focus(); } });
      actions.replaceChildren(
        el('span', { class: 'draft-confirm', text: 'Delete this draft?' }),
        el('button', { type: 'button', class: 'btn-quiet btn-sm danger', text: 'Delete', onclick: () => deleteDraft(d.id) }),
        keep
      );
      keep.focus();
    }
    showActions();
    return el('li', { class: 'draft-row' + (isCurrent ? ' is-current' : '') },
      el('button', {
        type: 'button', class: 'draft-open', 'aria-current': isCurrent ? 'true' : null,
        onclick: () => { draftsDlg.close(); app().openDraft(d.id); }
      },
        el('span', { class: 'draft-title', text: Store.displayTitle(d) }),
        el('span', { class: 'draft-meta' }, meta, stage ? el('span', { class: 'draft-stage', text: stage }) : null)),
      actions);
  }

  function newDraft() {
    draftsDlg.close();
    app().newDraft('');
    app().setMode('write');
  }

  function deleteDraft(id) {
    const d = Store.getDraft(id);
    if (!d) return;
    if (app().state.draft === d) app().saveNow();
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
        if (draftsDlg.open) renderDraftList();
      }
    });
  }

  function openDrafts() {
    app().saveNow();
    renderDraftList();
    draftsDlg.showModal();
  }

  /* ---------- Settings ---------- */
  const update = (patch) => app().updateSettings(patch);
  const field = (label, input) => el('div', { class: 'set-field' }, el('label', { for: input.id, class: 'set-sub', text: label }), input);

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
        el('span', { id: 'set-sound-label', text: 'Typing sound' }),
        el('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': 'set-sound-label' },
          SOUNDS.map(([value, name]) => el('label', null,
            radio('sound', value, s.sound === value, () => update({ sound: value })), name)))),
      el('div', { class: 'set-field' },
        el('label', { for: 'set-volume', class: 'set-sub', text: 'Volume' }),
        el('div', { class: 'range-row' }, vol,
          el('button', { type: 'button', class: 'btn-outline btn-sm', text: 'Test', onclick: test }))));
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
    const tw = el('input', { type: 'checkbox', checked: !!s.typewriterScroll, onchange: () => update({ typewriterScroll: tw.checked }) });
    const nb = el('input', { type: 'checkbox', checked: !!s.noBackspace, onchange: () => update({ noBackspace: nb.checked }) });
    const size = el('input', {
      type: 'range', id: 'set-size', min: '-2', max: '4', step: '1', value: String(s.textSize),
      oninput: () => update({ textSize: Number(size.value) })
    });
    const fmt = el('select', { id: 'set-format', onchange: () => update({ defaultFormat: fmt.value }) },
      TDW.Formats.LIST.map((f) => el('option', { value: f.key, text: f.label })));
    fmt.value = s.defaultFormat;
    return el('section', { class: 'set-sec', 'aria-labelledby': 'set-writing' },
      el('h3', { id: 'set-writing', class: 'label', text: 'Writing' }),
      el('label', { class: 'check' }, tw, el('span', { text: "Keep the line you're typing in the middle (Write mode)" })),
      el('label', { class: 'check' }, nb, el('span', { text: "Block backspace when a draft's stage says “no backspace”" })),
      field('New drafts use', fmt),
      field('Text size', size),
      dictionaryField(),
      el('p', { class: 'hint', text: 'Shortcuts: ⌘E or Ctrl+E switches Write and Edit. Esc closes panels.' }));
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
        el('label', { for: 'set-budget', class: 'set-sub', text: 'Default budget for new drafts' }),
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
          el('p', { text: 'Synced with ' + c.dbTitle }),
          st.at ? el('p', { class: 'hint', text: 'Last sync ' + relTime(st.at) }) : null,
          el('div', null, off)].filter(Boolean));
        return;
      }
      const secret = el('input', { type: 'password', id: 'set-notion-secret', autocomplete: 'off', spellcheck: 'false', placeholder: 'ntn_…' });
      const link = el('input', { type: 'text', id: 'set-notion-link', autocomplete: 'off', spellcheck: 'false', inputmode: 'url' });
      const n = Store.listDrafts().filter((d) => !d.notionId && (d.text.trim() || d.title.trim())).length;
      const upload = el('input', { type: 'checkbox', checked: true });
      const status = el('p', { class: 'ai-status', 'aria-live': 'polite' });
      const go = el('button', { type: 'button', class: 'btn', text: 'Connect' });
      go.addEventListener('click', () => {
        go.disabled = true;
        status.classList.remove('is-error');
        status.textContent = 'Connecting…';
        Sync.connect(secret.value, link.value, { uploadLocal: n > 0 && upload.checked }).then(() => {
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
        n > 0 ? el('label', { class: 'check' }, upload, el('span', { text: 'Also add my ' + n + ' ' + plural(n, 'draft', 'drafts') + ' from this device' })) : null,
        el('div', null, go),
        status].filter(Boolean));
    };
    render();
    return sec;
  }

  function aiSection() {
    const keyInput = el('input', { type: 'password', id: 'set-key', autocomplete: 'off', spellcheck: 'false' });
    const status = el('p', { class: 'ai-status', 'aria-live': 'polite' });
    const modelSel = el('select', { id: 'set-model', onchange: () => Store.setModel(modelSel.value) });
    const modelField = el('div', { class: 'set-field' }, el('label', { for: 'set-model', class: 'set-sub', text: 'Model' }), modelSel);
    const removeBtn = el('button', { type: 'button', class: 'btn-quiet danger', text: 'Remove key' });
    const testBtn = el('button', { type: 'button', class: 'btn', text: 'Save and test' });

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
      const current = Store.getModel() || (lastModels && lastModels[0]) || '';
      const names = [...new Set([...(lastModels || []), current].filter(Boolean))].sort();
      modelSel.replaceChildren(...names.map((n) => el('option', { value: n, text: n.replace(/^models\//, '') })));
      modelSel.value = current;
      const hasKey = !!Store.getKey();
      modelField.hidden = !(hasKey || lastModels) || !names.length;
      removeBtn.hidden = !hasKey;
    };

    testBtn.addEventListener('click', () => {
      testBtn.disabled = true;
      aiStatus = { text: '', error: false };
      showStatus();
      TDW.AI.connect(keyInput.value).then((res) => {
        lastModels = res.models;
        aiStatus = { text: 'Connected. Using ' + res.model.replace(/^models\//, '') + '.', error: false };
      }, (err) => {
        aiStatus = { text: err && err.detail ? 'Something went wrong: ' + err.detail : TDW.AI.errorMessage(err), error: true };
      }).then(() => {
        testBtn.disabled = false;
        showKey();
        showStatus();
        fillModels();
        app().refreshPanel();
      });
    });
    removeBtn.addEventListener('click', () => {
      TDW.AI.disconnect();
      lastModels = null;
      aiStatus = { text: '', error: false };
      showKey();
      showStatus();
      fillModels();
      app().refreshPanel();
    });

    if (!aiStatus.text && Store.getKey() && Store.getModel()) {
      aiStatus = { text: 'Connected. Using ' + Store.getModel().replace(/^models\//, '') + '.', error: false };
    }
    showKey();
    showStatus();
    fillModels();

    return el('section', { id: 'set-ai', class: 'set-sec', 'aria-labelledby': 'set-ai-title' },
      el('h3', { id: 'set-ai-title', class: 'label', text: 'AI help (Gemini)' }),
      el('p', { class: 'hint' },
        'Paste a Gemini API key. It stays in this browser and is only sent to Google. ',
        el('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener', text: 'Get a free key at Google AI Studio' })),
      el('div', { class: 'set-field' },
        el('label', { for: 'set-key', class: 'set-sub', text: 'API key' }),
        el('div', { class: 'key-row' }, keyInput, testBtn)),
      status,
      modelField,
      el('div', null, removeBtn),
      el('p', { class: 'hint', text: "On Google's free tier, Google may use what you send to improve its products. Keep private client work out, or use a paid key." }));
  }

  function openSettings(section) {
    const s = app().state.settings;
    settingsDlg.replaceChildren(
      el('div', { class: 'dlg-head' }, el('h2', { id: 'settings-title', text: 'Settings' }), closeButton(settingsDlg)),
      el('div', { class: 'settings-body' },
        lookSection(s), soundSection(s), writingSection(s), budgetSection(s), notionSection(), aiSection()),
      el('p', { class: 'set-foot', text: 'Ten-Dollar Words · version ' + app().APP_VERSION }));
    settingsDlg.showModal();
    if (section === 'ai') {
      document.getElementById('set-ai').scrollIntoView({ block: 'start' });
      document.getElementById('set-key').focus({ preventScroll: true });
    }
  }

  TDW.Dialogs = {
    init() {
      draftsDlg = document.getElementById('drafts-dialog');
      settingsDlg = document.getElementById('settings-dialog');
      buildDrafts();
      wireDialog(settingsDlg);
    },
    openDrafts,
    openSettings,
    renderDraftList,
    isDraftsOpen() { return !!draftsDlg && draftsDlg.open; }
  };
})();
