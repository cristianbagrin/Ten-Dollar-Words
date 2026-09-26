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
    chevUp: svg('<path d="M4 10l4-4 4 4" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>')
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

  TDW.UI = { el, icon, toast, hideToast, rehostToast, money, plural, costNote, relTime, reducedMotion };
})();
