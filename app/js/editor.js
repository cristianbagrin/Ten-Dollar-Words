/* The editor: a native textarea stacked over a backdrop div that draws the highlights.
   Both layers must wrap text identically (see .type-surface in app.css). */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};
  const TYPES = ['spelling', 'hard', 'veryHard', 'complex', 'passive', 'adverb', 'qualifier'];

  let ta = null;
  let bd = null;
  let surface = null;
  let fxMarks = [];
  let sentMarks = [];
  let wordMarks = [];
  let activeId = null;
  let resizeRaf = 0;
  // Edit-mode aids: { fold: { chars, lines, label, title } | null, posts: [{ start, end, label, title }] | null }
  let aids = null;
  let aidsEl = null;
  let tickEl = null;
  let labelEl = null;
  const postEls = [];

  function escapeHTML(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // fx / sent / word: arrays of {start, end, type, id?}, each sorted and non-overlapping within itself.
  // markers: [{ index, cls }]
  function buildHTML(text, fx, sent, word, markers) {
    const cuts = new Set([0, text.length]);
    for (const arr of [fx, sent, word]) for (const m of arr) { cuts.add(m.start); cuts.add(m.end); }
    for (const mk of markers) cuts.add(mk.index);
    const pts = [...cuts].filter((p) => p >= 0 && p <= text.length).sort((a, b) => a - b);
    const skip = (arr, i, pos) => { while (i < arr.length && arr[i].end <= pos) i++; return i; };
    const cover = (arr, i, a) => (i < arr.length && arr[i].start <= a && a < arr[i].end ? arr[i] : null);
    let out = '', fi = 0, si = 0, wi = 0, openF = null, openS = null, openW = null;
    const closeW = () => { if (openW) { out += '</mark>'; openW = null; } };
    const closeS = () => { closeW(); if (openS) { out += '</span>'; openS = null; } };
    const closeF = () => { closeS(); if (openF) { out += '</span>'; openF = null; } };
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k], b = k + 1 < pts.length ? pts[k + 1] : a;
      fi = skip(fx, fi, a); si = skip(sent, si, a); wi = skip(word, wi, a);
      const F = cover(fx, fi, a), S = cover(sent, si, a), W = cover(word, wi, a);
      if (F !== openF) { closeF(); openF = F; if (F) out += '<span class="fx fx-' + F.type + '">'; }
      if (S !== openS) { closeS(); openS = S; if (S) out += '<span class="hs hs-' + S.type + '" data-id="' + S.id + '">'; }
      if (W !== openW) { closeW(); openW = W; if (W) out += '<mark class="hl hl-' + W.type + '" data-id="' + W.id + '">'; }
      for (const mk of markers) if (mk.index === a) out += '<span class="' + mk.cls + '"></span>';
      if (b > a) out += escapeHTML(text.slice(a, b));
    }
    closeF();
    if (text === '' || text.endsWith('\n')) out += ' ';
    return out;
  }

  const findMark = (id) => bd.querySelector('[data-id="' + CSS.escape(id) + '"]');

  function autosize() {
    const minPx = parseFloat(getComputedStyle(ta).minHeight) || 0;
    ta.style.height = Math.max(bd.offsetHeight + 2, minPx) + 'px';
  }

  function postButton(i) {
    if (!postEls[i]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'post-num margin-aid';
      b.addEventListener('click', () => {
        const p = aids && aids.posts && aids.posts[i];
        if (p) Editor.select(p.start, p.end);
      });
      aidsEl.append(b);
      postEls[i] = b;
    }
    return postEls[i];
  }

  const setBox = (n, top, height, left) => {
    n.style.top = top + 'px';
    n.style.height = height + 'px';
    if (left != null) n.style.left = left + 'px';
    n.hidden = false;
  };

  // Place the fold tick and label and the post numbers from the markers render() just drew.
  // An empty marker's offsetTop falls inside its line box, so floor(top / lineH) finds the line.
  function placeAids(text) {
    if (!aidsEl) return;
    tickEl.hidden = true;
    labelEl.hidden = true;
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    const lineTop = (top) => Math.floor((top + 1) / lh) * lh;
    const fold = aids && aids.fold;
    if (fold && (text.length > fold.chars || bd.offsetHeight > fold.lines * lh + 1)) {
      const mk = bd.querySelector('.fold-marker');
      let y = (fold.lines - 1) * lh; // the line limit cuts first
      if (mk && mk.offsetTop < fold.lines * lh) {
        y = lineTop(mk.offsetTop);
        setBox(tickEl, y, lh, mk.offsetLeft);
      }
      labelEl.textContent = fold.label;
      labelEl.title = fold.title;
      setBox(labelEl, y, lh);
    }
    const posts = (aids && aids.posts) || [];
    const marks = posts.length ? bd.querySelectorAll('.post-marker') : [];
    posts.forEach((p, i) => {
      const b = postButton(i);
      b.textContent = p.label;
      b.title = p.title;
      b.setAttribute('aria-label', 'Select post ' + p.label.replace('/', ' of '));
      if (marks[i]) setBox(b, lineTop(marks[i].offsetTop), lh);
    });
    for (let i = posts.length; i < postEls.length; i++) postEls[i].hidden = true;
  }

  function render(markerIndex) {
    if (!ta) return;
    const text = ta.value;
    const markers = [{ index: markerIndex != null ? markerIndex : ta.selectionEnd, cls: 'caret-marker' }];
    const fold = aids && aids.fold;
    if (fold && text.length > fold.chars) {
      const at = /[\uDC00-\uDFFF]/.test(text[fold.chars]) ? fold.chars - 1 : fold.chars; // never split an emoji
      markers.push({ index: at, cls: 'fold-marker' });
    }
    if (aids && aids.posts) for (const p of aids.posts) markers.push({ index: p.start, cls: 'post-marker' });
    bd.innerHTML = buildHTML(text, fxMarks, sentMarks, wordMarks, markers);
    if (activeId) {
      const n = findMark(activeId);
      if (n) n.classList.add('is-active');
    }
    autosize();
    placeAids(text);
  }

  function caretTop(index) {
    render(index);
    const m = bd.querySelector('.caret-marker');
    return m ? m.offsetTop : 0;
  }

  function scrollToIndex(index, frac) {
    const top = caretTop(index);
    const lineH = parseFloat(getComputedStyle(ta).lineHeight) || 30;
    const y = surface.getBoundingClientRect().top + window.scrollY + top + lineH / 2;
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    window.scrollTo(0, Math.max(0, y - vh * frac));
  }

  function replaceRange(start, end, text) {
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(start, end);
    const before = ta.value;
    let ok = false;
    Editor.busy = true;
    try { ok = text === '' ? document.execCommand('delete') : document.execCommand('insertText', false, text); } catch (_) { ok = false; }
    Editor.busy = false;
    const expect = before.slice(0, start) + text + before.slice(end);
    if (!ok || ta.value !== expect) {
      ta.value = expect; // fallback loses native undo; acceptable
      ta.setSelectionRange(start + text.length, start + text.length);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // Plan for deleting a word or phrase cleanly: take one neighboring space, keep the sentence capitalized.
  function cutPlan(text, start, end, sentenceStart) {
    let s = start, e = end;
    if (text[e] === ',') e++;
    if (text[e] === ' ') e++;
    else if (text[s - 1] === ' ') s--;
    const next = text[e] || '';
    if (start === sentenceStart && /^[a-z]$/.test(next)) return { start: s, end: e + 1, replacement: next.toUpperCase() };
    return { start: s, end: e, replacement: '' };
  }

  function matchCase(original, replacement) {
    if (original.length > 1 && original === original.toUpperCase() && original !== original.toLowerCase()) return replacement.toUpperCase();
    const c = original.charAt(0);
    if (c !== c.toLowerCase()) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
    return replacement;
  }

  const Editor = {
    busy: false,
    init(opts) {
      ta = opts.textarea;
      bd = opts.backdrop;
      surface = opts.surface;
      if (opts.aids) {
        aidsEl = opts.aids;
        tickEl = document.createElement('span');
        tickEl.className = 'fold-tick';
        tickEl.setAttribute('aria-hidden', 'true');
        labelEl = document.createElement('span');
        labelEl.className = 'fold-label margin-aid';
        tickEl.hidden = labelEl.hidden = true;
        aidsEl.append(tickEl, labelEl);
      }
      ta.addEventListener('scroll', () => { ta.scrollTop = 0; });
      window.addEventListener('resize', () => {
        cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => render());
      });
      if (document.fonts) document.fonts.addEventListener('loadingdone', () => render());
    },
    setText(text) {
      ta.value = text;
      ta.setSelectionRange(text.length, text.length);
      render();
    },
    getText() { return ta.value; },
    setMarks(sent, word) { sentMarks = sent; wordMarks = word; },
    setFx(list) { fxMarks = list; },
    setAids(cfg) { aids = cfg || null; },
    setHidden(types) { for (const t of TYPES) bd.classList.toggle('hide-' + t, types.includes(t)); },
    setActive(id) {
      const old = bd.querySelector('.is-active');
      if (old) old.classList.remove('is-active');
      activeId = id || null;
      const n = activeId && findMark(activeId);
      if (n) n.classList.add('is-active');
    },
    render,
    caretTop,
    scrollToIndex,
    typewriterScroll() { scrollToIndex(ta.selectionEnd, 0.45); },
    replaceRange,
    select(start, end) {
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(start, end);
      scrollToIndex(start, 0.35);
    },
    caretIndex() { return ta.selectionEnd; },
    markRect(id) {
      const n = findMark(id);
      if (!n) return null;
      const rects = n.getClientRects();
      return rects.length ? rects[0] : null;
    },
    cutPlan,
    matchCase,
    buildHTML
  };

  TDW.Editor = Editor;
})();
