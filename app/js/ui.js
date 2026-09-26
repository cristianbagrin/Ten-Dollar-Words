/* Shared helpers: element builder, toast, money and time formatting, icons. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};

  const svg = (inner) => '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">' + inner + '</svg>';
  const EYE = '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" stroke-width="1.4"/><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/>';

  TDW.icons = {
    close: svg('<path d="M4 4l8 8M12 4l-8 8" stroke-width="1.6" stroke-linecap="round"/>'),
    sliders: svg('<path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7" stroke-width="1.5" stroke-linecap="round"/><circle cx="10.5" cy="4.5" r="1.6" stroke-width="1.5"/><circle cx="5.5" cy="11.5" r="1.6" stroke-width="1.5"/>'),
    eye: svg(EYE),
    eyeOff: svg(EYE + '<path d="M2.5 13.5l11-11" stroke-width="1.4" stroke-linecap="round"/>'),
    chevUp: svg('<path d="M4 10l4-4 4 4" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
    chevLeft: svg('<path d="M10 4l-4 4 4 4" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
    chevRight: svg('<path d="M6 4l4 4-4 4" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
    chevDown: svg('<path d="M4.5 6.5l3.5 3.5 3.5-3.5" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
    trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2c.05.7.6 1.3 1.3 1.3h3.2c.7 0 1.25-.6 1.3-1.3l.6-8.2" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>'),
    plus: svg('<path d="M8 3.5v9M3.5 8h9" stroke-width="1.6" stroke-linecap="round"/>')
  };

  // Icons are static constants, so parsing them as HTML is safe.
  function icon(name) {
    const t = document.createElement('template');
    t.innerHTML = TDW.icons[name];
    return t.content.firstChild;
  }

  // el('button', { class, text, type, onclick, dataset, ... }, ...children). Strings become text nodes.
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'dataset') Object.assign(n.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') n[k] = v;
        else n.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
    return n;
  }

  const topDialog = () => {
    const open = document.querySelectorAll('dialog[open]');
    return open.length ? open[open.length - 1] : null;
  };

  // A modal dialog makes the rest of the page inert, so the toast moves inside it while one is open.
  function rehostToast() {
    const t = document.getElementById('toast');
    if (!t) return;
    const host = (!t.hidden && topDialog()) || document.body;
    if (t.parentNode !== host) host.append(t);
  }

  let toastTimer = 0;
  function hideToast() {
    clearTimeout(toastTimer);
    const t = document.getElementById('toast');
    if (!t) return;
    t.hidden = true;
    rehostToast();
  }

  function toast(msg, action) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.replaceChildren(el('span', { class: 'toast-msg', text: msg }));
    if (action) {
      t.append(el('button', {
        type: 'button', class: 'toast-btn', text: action.label,
        onclick: () => { hideToast(); action.run(); }
      }));
    }
    t.hidden = false;
    rehostToast();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 6000 : 3500);
  }

  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const plural = (n, one, many) => (n === 1 ? one : many);

  // Money effect of swapping text: words saved > 0 saves money.
  function costNote(savedWords) {
    if (savedWords > 0) return 'saves ' + money(savedWords * 10);
    if (savedWords < 0) return 'costs ' + money(-savedWords * 10) + ' more';
    return 'same cost';
  }

  function relTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60e3) return 'just now';
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' min ago';
    if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' h ago';
    if (diff < 2 * 86400e3) return 'yesterday';
    const d = new Date(ts);
    const opts = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString('en-US', opts);
  }

  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Segmented toggle: the thumb stretches like a drop of ink to the new choice ---------- */
  function segmented(o) {
    const wrap = el('div', { class: 'seg' + (o.class ? ' ' + o.class : ''), role: 'radiogroup', 'aria-label': o.label });
    const thumb = el('span', { class: 'seg-thumb', 'aria-hidden': 'true' });
    let current = o.value;
    let at = null;
    const btns = o.options.map((opt) => {
      const b = el('button', {
        type: 'button', role: 'radio', class: 'seg-opt', title: opt.title || null,
        dataset: { value: opt.value }, 'aria-checked': String(opt.value === current), tabindex: opt.value === current ? '0' : '-1'
      }, opt.label);
      b.addEventListener('click', () => pick(opt.value, true));
      return b;
    });
    wrap.append(thumb, ...btns);

    function pick(v, user) {
      if (v === current) return;
      set(v, true);
      if (user && o.onChange) o.onChange(v);
    }

    function place(animate) {
      const b = btns.find((x) => x.dataset.value === current);
      if (!b || !b.offsetWidth) { thumb.style.opacity = b ? '' : '0'; return; }
      const to = { x: b.offsetLeft, w: b.offsetWidth };
      thumb.style.opacity = '';
      if (animate && at && (at.x !== to.x || at.w !== to.w) && !reducedMotion() && thumb.animate) {
        const left = Math.min(at.x, to.x), right = Math.max(at.x + at.w, to.x + to.w);
        const lead = to.x > at.x ? 'right' : 'left';
        thumb.animate([
          { transform: 'translateX(' + at.x + 'px)', width: at.w + 'px', easing: 'cubic-bezier(.45,0,.55,1)' },
          { transform: 'translateX(' + (lead === 'right' ? at.x : left) + 'px) scaleY(.82)', width: (right - left) + 'px', offset: 0.42, easing: 'cubic-bezier(.2,.8,.25,1)' },
          { transform: 'translateX(' + to.x + 'px) scaleY(1.07)', width: to.w + 'px', offset: 0.8, easing: 'ease-out' },
          { transform: 'translateX(' + to.x + 'px)', width: to.w + 'px' }
        ], { duration: 480, easing: 'linear' });
      }
      thumb.style.transform = 'translateX(' + to.x + 'px)';
      thumb.style.width = to.w + 'px';
      at = to;
    }

    function set(v, animate) {
      current = v;
      for (const b of btns) {
        const on = b.dataset.value === v;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
      place(animate);
    }

    wrap.addEventListener('keydown', (e) => {
      const i = btns.findIndex((b) => b.dataset.value === current);
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = btns[(i + d + btns.length) % btns.length];
      pick(next.dataset.value, true);
      next.focus();
    });
    if (window.ResizeObserver) new ResizeObserver(() => place(false)).observe(wrap);
    requestAnimationFrame(() => place(false));
    wrap.set = set;
    wrap.get = () => current;
    return wrap;
  }

  /* ---------- Switch ---------- */
  function toggle(o) {
    const b = el('button', {
      type: 'button', role: 'switch', class: 'switch' + (o.class ? ' ' + o.class : ''),
      'aria-checked': String(!!o.checked), 'aria-label': o.label || null, id: o.id || null, title: o.title || null
    }, el('span', { class: 'switch-knob', 'aria-hidden': 'true' }));
    b.addEventListener('click', () => {
      const on = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', String(on));
      if (o.onChange) o.onChange(on);
    });
    b.set = (on) => b.setAttribute('aria-checked', String(!!on));
    return b;
  }

  /* ---------- Menu: a small list anchored to a button ---------- */
  let openMenu = null;
  function closeMenu() {
    if (!openMenu) return;
    const m = openMenu;
    openMenu = null;
    m.cleanup();
    if (m.onClose) m.onClose();
    m.node.classList.add('is-leaving');
    setTimeout(() => m.node.remove(), reducedMotion() ? 0 : 120);
    if (m.anchor && m.anchor.isConnected && m.returnFocus) m.anchor.focus({ preventScroll: true });
  }

  // items: [{ label, value, checked, note, danger }] or { type: 'sep' }. onPick(item) returns
  // true to keep the menu open (multi-select). extra: a node shown below the list.
  function menu(anchor, items, onPick, extra, onClose) {
    closeMenu();
    const host = anchor.closest('dialog') || document.body;
    const node = el('div', { class: 'menu', role: 'menu' });
    const buttons = [];
    for (const it of items) {
      if (it.type === 'sep') { node.append(el('div', { class: 'menu-sep', role: 'separator' })); continue; }
      const b = el('button', {
        type: 'button', class: 'menu-item' + (it.danger ? ' danger' : ''),
        role: it.checked != null ? 'menuitemcheckbox' : 'menuitem',
        'aria-checked': it.checked != null ? String(!!it.checked) : null
      },
      el('span', { class: 'menu-check', 'aria-hidden': 'true' }),
      el('span', { class: 'menu-label', text: it.label }),
      it.note ? el('span', { class: 'menu-note', text: it.note }) : null);
      b.addEventListener('click', () => {
        const keep = onPick(it, b);
        if (!keep) closeMenu();
      });
      buttons.push(b);
      node.append(b);
    }
    if (extra) node.append(extra);
    host.append(node);
    const r = anchor.getBoundingClientRect();
    const w = node.offsetWidth, h = node.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - w - 12);
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 6);
    node.style.left = Math.max(12, left) + 'px';
    node.style.top = top + 'px';
    const onDown = (e) => { if (!node.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closeMenu(); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); openMenu.returnFocus = true; closeMenu(); return; }
      const i = buttons.indexOf(document.activeElement);
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && buttons.length) {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        buttons[(i + d + buttons.length) % buttons.length].focus();
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', onDown, true));
    document.addEventListener('keydown', onKey, true);
    const onScroll = (e) => { if (!node.contains(e.target)) closeMenu(); };
    window.addEventListener('scroll', onScroll, true);
    openMenu = {
      node, anchor, returnFocus: false, onClose: onClose || null,
      cleanup() {
        document.removeEventListener('pointerdown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('scroll', onScroll, true);
      }
    };
    const first = buttons.find((b) => b.getAttribute('aria-checked') === 'true') || buttons[0];
    if (first) first.focus({ preventScroll: true });
    return node;
  }

  /* ---------- Calendar: a month of days, like Notion's date picker ---------- */
  const pad2 = (n) => String(n).padStart(2, '0');
  const isoOf = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  function calendar(o) {
    const today = isoOf(new Date());
    let chosen = o.value || '';
    const start = chosen ? new Date(chosen + 'T12:00:00') : new Date();
    let view = new Date(start.getFullYear(), start.getMonth(), 1);
    let focusIso = chosen || today;
    const title = el('span', { class: 'cal-title', 'aria-live': 'polite' });
    const grid = el('div', { class: 'cal-grid', role: 'grid' });
    const nav = (d) => { view = new Date(view.getFullYear(), view.getMonth() + d, 1); draw(); };
    const node = el('div', { class: 'cal' },
      el('div', { class: 'cal-head' }, title,
        el('div', { class: 'cal-nav' },
          el('button', { type: 'button', class: 'btn-icon cal-arrow', 'aria-label': 'Previous month', onclick: () => nav(-1) }, icon('chevLeft')),
          el('button', { type: 'button', class: 'btn-icon cal-arrow', 'aria-label': 'Next month', onclick: () => nav(1) }, icon('chevRight')))),
      el('div', { class: 'cal-week', 'aria-hidden': 'true' }, ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((w) => el('span', { text: w }))),
      grid,
      el('div', { class: 'cal-foot' },
        el('button', { type: 'button', class: 'btn-quiet btn-sm', text: 'Today', onclick: () => o.onPick(today) }),
        chosen ? el('button', { type: 'button', class: 'btn-quiet btn-sm', text: 'Clear', onclick: () => o.onPick('') }) : null));
    function draw() {
      title.textContent = view.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      const first = new Date(view.getFullYear(), view.getMonth(), 1 - view.getDay());
      const days = [];
      for (let k = 0; k < 42; k++) {
        const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + k);
        const iso = isoOf(d);
        const cls = 'cal-day' + (d.getMonth() !== view.getMonth() ? ' is-out' : '') + (iso === today ? ' is-today' : '') + (iso === chosen ? ' is-chosen' : '');
        days.push(el('button', {
          type: 'button', class: cls, text: String(d.getDate()), tabindex: iso === focusIso ? '0' : '-1',
          'aria-label': d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
          'aria-pressed': iso === chosen ? 'true' : 'false', dataset: { iso }, onclick: () => o.onPick(iso)
        }));
      }
      grid.replaceChildren(...days);
    }
    grid.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (!step) return;
      e.preventDefault();
      const cur = new Date((document.activeElement.dataset.iso || focusIso) + 'T12:00:00');
      cur.setDate(cur.getDate() + step);
      focusIso = isoOf(cur);
      if (cur.getMonth() !== view.getMonth() || cur.getFullYear() !== view.getFullYear()) view = new Date(cur.getFullYear(), cur.getMonth(), 1);
      draw();
      node.focusDay();
    });
    node.focusDay = () => { const b = grid.querySelector('[tabindex="0"]'); if (b) b.focus({ preventScroll: true }); };
    draw();
    return node;
  }

  TDW.UI = {
    el, icon, toast, hideToast, rehostToast, money, plural, costNote, relTime, reducedMotion,
    segmented, toggle, menu, closeMenu, calendar, menuOpen: () => !!openMenu
  };
})();
