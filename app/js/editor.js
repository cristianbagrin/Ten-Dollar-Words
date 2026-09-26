/* The editor: a contenteditable with one <div class="ln"> per line of the draft.
   The draft text is the model. Every edit goes through the model and the changed lines are
   redrawn, so the page never holds text the model doesn't have. The one exception is IME
   composition (Chinese, Japanese…): the browser types into the page and the model catches up
   when composition ends. Markdown syntax stays in the text, drawn quietly. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};
  const Inline = TDW.Inline;
  const TYPES = ['spelling', 'hard', 'veryHard', 'complex', 'passive', 'adverb', 'qualifier'];
  const WRAPS = { bold: '**', italic: '*', strike: '~~' };
  const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

  let root = null;       // the contenteditable
  let surface = null;    // positioned parent of root, under and aids
  let under = null;      // behind the text: X post windows
  let aidsEl = null;     // above the text: fold ticks and labels, post footers
  let hooks = {};

  let text = '';
  let lines = [''];
  let starts = [0];
  let sel = { start: 0, end: 0, backward: false };
  let rendered = [];     // per line: class + html, to redraw only what changed
  let composing = false;
  let pendingRender = false;
  let readOnly = false;
  let thread = false;
  let aids = null;       // { folds: [{ index, label, title }], post: (start, end) => { words, length, limit } }
  let fxMarks = [];
  let sentMarks = [];
  let wordMarks = [];
  let activeId = null;
  let resizeRaf = 0;
  let reconcileTimer = 0;
  const history = { undo: [], redo: [] };

  /* ---------- Model ---------- */

  function setModel(t) {
    text = t;
    lines = t.split('\n');
    starts = new Array(lines.length);
    let p = 0;
    for (let i = 0; i < lines.length; i++) { starts[i] = p; p += lines[i].length + 1; }
  }

  function lineOf(index) {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  const lineEnd = (i) => starts[i] + lines[i].length;
  const isSep = (i) => thread && i >= 0 && i < lines.length && Inline.block(lines[i]).type === 'hr';

  // Marks keep pointing at the same words while the analysis catches up.
  function shift(list, start, end, len) {
    const d = len - (end - start);
    const out = [];
    for (const m of list) {
      if (m.end <= start) out.push(m);
      else if (m.start >= end) out.push(Object.assign({}, m, { start: m.start + d, end: m.end + d }));
    }
    return out;
  }

  /* ---------- Drawing ---------- */

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // layers: outer to inner, each a sorted list of non-overlapping { start, end, open, close }.
  function buildLine(s, layers, markers) {
    const cuts = new Set([0, s.length]);
    for (const L of layers) for (const r of L) { cuts.add(r.start); cuts.add(r.end); }
    for (const m of markers) cuts.add(m.index);
    const pts = [...cuts].filter((p) => p >= 0 && p <= s.length).sort((a, b) => a - b);
    const idx = layers.map(() => 0);
    const open = layers.map(() => null);
    let out = '';
    const closeFrom = (d) => { for (let k = layers.length - 1; k >= d; k--) if (open[k]) { out += open[k].close; open[k] = null; } };
    for (let p = 0; p < pts.length; p++) {
      const a = pts[p], b = p + 1 < pts.length ? pts[p + 1] : a;
      const want = layers.map((L, d) => {
        if (b <= a) return null;
        let i = idx[d];
        while (i < L.length && L[i].end <= a) i++;
        idx[d] = i;
        return i < L.length && L[i].start <= a && a < L[i].end ? L[i] : null;
      });
      let d = 0;
      while (d < layers.length && want[d] === open[d]) d++;
      closeFrom(d);
      for (let k = d; k < layers.length; k++) if (want[k]) { out += want[k].open; open[k] = want[k]; }
      for (const m of markers) if (m.index === a) out += m.html;
      if (b > a) out += esc(s.slice(a, b));
    }
    closeFrom(0);
    return out;
  }

  function clip(list, ls, le, open, close) {
    const out = [];
    for (const m of list) {
      if (m.end <= ls || m.start >= le || m.end <= m.start) continue;
      out.push({ start: Math.max(m.start, ls) - ls, end: Math.min(m.end, le) - ls, open: open(m), close });
    }
    return out;
  }

  function styleRuns(line, blk) {
    const out = [];
    if (blk.type === 'hr' || blk.type === 'opaque') {
      if (line.length) out.push({ start: 0, end: line.length, open: '<span class="pre">', close: '</span>' });
      return out;
    }
    if (blk.prefix) {
      let cls = 'pre';
      if (blk.type === 'li') cls += ' pre-li';
      if (blk.type === 'todo') cls += ' pre-todo' + (blk.checked ? ' is-done' : '');
      out.push({ start: 0, end: blk.prefix, open: '<span class="' + cls + '">', close: '</span>' });
    }
    const { flags } = Inline.parse(line, blk.prefix);
    let a = blk.prefix;
    const clsOf = (f) => [f & Inline.MD ? 'md' : '', f & Inline.B ? 'b' : '', f & Inline.I ? 'i' : '',
      f & Inline.S ? 's' : '', f & Inline.C ? 'c' : '', f & Inline.L ? 'lk' : ''].filter(Boolean).join(' ');
    for (let k = blk.prefix + 1; k <= line.length; k++) {
      if (k < line.length && flags[k] === flags[a]) continue;
      if (flags[a]) out.push({ start: a, end: k, open: '<span class="' + clsOf(flags[a]) + '">', close: '</span>' });
      a = k;
    }
    return out;
  }

  function lineClass(i, blk) {
    let c = 'ln ln-' + blk.type + (blk.checked ? ' is-done' : '');
    if (thread) {
      if (blk.type === 'hr') return 'ln sep';
      if (i === 0 || isSep(i - 1)) c += ' post-first';
      if (i === lines.length - 1 || isSep(i + 1)) c += ' post-last';
    }
    return c;
  }

  function lineHTML(i, blk, markers) {
    const line = lines[i];
    const ls = starts[i], le = ls + line.length;
    const layers = [
      clip(fxMarks, ls, le, (m) => '<span class="fx fx-' + m.type + '">', '</span>'),
      clip(sentMarks, ls, le, (m) => '<span class="hs hs-' + m.type + (m.id === activeId ? ' is-active' : '') + '" data-id="' + esc(m.id) + '">', '</span>'),
      clip(wordMarks, ls, le, (m) => '<mark class="hl hl-' + m.type + (m.id === activeId ? ' is-active' : '') + '" data-id="' + esc(m.id) + '">', '</mark>'),
      styleRuns(line, blk)
    ];
    const html = buildLine(line, layers, markers);
    return line.length ? html : html + '<br>';
  }

  function render() {
    if (!root) return;
    if (composing) { pendingRender = true; return; }
    pendingRender = false;
    const byLine = new Map();
    for (const f of (aids && aids.folds) || []) {
      if (f.index < 0 || f.index > text.length) continue;
      const i = lineOf(f.index);
      if (!byLine.has(i)) byLine.set(i, []);
      byLine.get(i).push({ index: f.index - starts[i], html: '<span class="mk mk-fold" data-fold="' + f.label + '"></span>' });
    }
    const n = lines.length;
    const classes = new Array(n), htmls = new Array(n), keys = new Array(n);
    for (let i = 0; i < n; i++) {
      const blk = Inline.block(lines[i]);
      classes[i] = lineClass(i, blk);
      htmls[i] = lineHTML(i, blk, byLine.get(i) || []);
      keys[i] = classes[i] + '\u0000' + htmls[i];
    }
    const touched = commit(keys, classes, htmls);
    root.classList.toggle('is-empty', text === '');
    if (touched && document.activeElement === root) applySel();
    placeAids();
  }

  function commit(keys, classes, htmls) {
    const kids = root.children;
    const valid = kids.length === rendered.length && root.childNodes.length === kids.length;
    if (!valid) {
      root.innerHTML = keys.map((_, i) => '<div class="' + classes[i] + '">' + htmls[i] + '</div>').join('');
      rendered = keys;
      return true;
    }
    let a = 0;
    while (a < keys.length && a < rendered.length && keys[a] === rendered[a]) a++;
    let z = 0;
    while (z < keys.length - a && z < rendered.length - a && keys[keys.length - 1 - z] === rendered[rendered.length - 1 - z]) z++;
    const oldCount = rendered.length - a - z, newCount = keys.length - a - z;
    if (!oldCount && !newCount) return false;
    const common = Math.min(oldCount, newCount);
    for (let k = 0; k < common; k++) {
      const node = kids[a + k];
      if (node.className !== classes[a + k]) node.className = classes[a + k];
      node.innerHTML = htmls[a + k];
    }
    if (newCount > oldCount) {
      const ref = kids[a + oldCount] || null;
      const frag = document.createDocumentFragment();
      for (let k = oldCount; k < newCount; k++) {
        const div = document.createElement('div');
        div.className = classes[a + k];
        div.innerHTML = htmls[a + k];
        frag.append(div);
      }
      root.insertBefore(frag, ref);
    } else {
      for (let k = oldCount - 1; k >= newCount; k--) kids[a + k].remove();
    }
    rendered = keys;
    return true;
  }

  /* ---------- Page positions <-> text positions ---------- */

  function lineEl(node) {
    let el = node;
    while (el && el.parentNode !== root) el = el.parentNode;
    return el && el.parentNode === root ? el : null;
  }

  function pointToIndex(node, offset) {
    if (!node) return null;
    if (node === root) return offset >= lines.length ? text.length : starts[offset];
    const el = lineEl(node);
    if (!el) return null;
    const li = Array.prototype.indexOf.call(root.children, el);
    if (li < 0 || li >= lines.length) return null;
    const r = document.createRange();
    r.setStart(el, 0);
    try { r.setEnd(node, offset); } catch (_) { return null; }
    return starts[li] + Math.min(r.toString().length, lines[li].length);
  }

  function indexToPoint(index) {
    const li = lineOf(Math.max(0, Math.min(index, text.length)));
    const el = root.children[li];
    if (!el) return { node: root, offset: 0 };
    let col = index - starts[li];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n, last = null;
    while ((n = walker.nextNode())) {
      if (col <= n.data.length) return { node: n, offset: col };
      col -= n.data.length;
      last = n;
    }
    return last ? { node: last, offset: last.data.length } : { node: el, offset: 0 };
  }

  function applySel() {
    if (!root || composing) return;
    const ds = document.getSelection();
    if (!ds) return;
    const a = indexToPoint(sel.backward ? sel.end : sel.start);
    const f = indexToPoint(sel.backward ? sel.start : sel.end);
    try { ds.setBaseAndExtent(a.node, a.offset, f.node, f.offset); } catch (_) { /* detached */ }
  }

  function readSel() {
    const ds = document.getSelection();
    if (!ds || !ds.rangeCount) return null;
    const a = pointToIndex(ds.anchorNode, ds.anchorOffset);
    const f = pointToIndex(ds.focusNode, ds.focusOffset);
    if (a == null || f == null) return null;
    return { start: Math.min(a, f), end: Math.max(a, f), backward: f < a };
  }

  function onSelectionChange() {
    if (composing || document.activeElement !== root) return;
    const s = readSel();
    if (!s) return;
    const prev = sel;
    sel = s;
    // The caret never rests on a thread separator: step over it the way it was going.
    if (thread && s.start === s.end && isSep(lineOf(s.start))) {
      const li = lineOf(s.start);
      const down = prev.end <= s.start;
      const to = down && li + 1 < lines.length ? starts[li + 1] : li > 0 ? lineEnd(li - 1) : starts[Math.min(li + 1, lines.length - 1)];
      sel = { start: to, end: to, backward: false };
      applySel();
    }
    if (prev.start !== sel.start || prev.end !== sel.end) call('onSelect');
  }

  function rectAt(index) {
    if (!root || !root.children.length) return null;
    const li = lineOf(Math.max(0, Math.min(index, text.length)));
    const el = root.children[li];
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 24;
    const p = indexToPoint(index);
    let rc = null;
    if (p.node.nodeType === 3) {
      const r = document.createRange();
      r.setStart(p.node, p.offset);
      r.collapse(true);
      const list = r.getClientRects();
      rc = list.length ? list[0] : null;
      if ((!rc || !rc.height) && p.node.data.length) {
        // Collapsed ranges at a line end can come back empty; measure the character instead.
        const k = p.offset < p.node.data.length ? p.offset : p.offset - 1;
        r.setStart(p.node, k);
        r.setEnd(p.node, k + 1);
        const c = r.getClientRects();
        const cr = c.length ? c[c.length - 1] : null;
        if (cr) rc = { left: p.offset < p.node.data.length ? cr.left : cr.right, top: cr.top, height: cr.height };
      }
    }
    if (!rc || !rc.height) return { left: box.left, top: box.top, height: lh, lineTop: box.top, lh };
    const lineTop = rc.top - (lh - rc.height) / 2;
    return { left: rc.left, top: rc.top, height: rc.height, lineTop, lh };
  }

  function indexFromPoint(x, y) {
    let node = null, offset = 0;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { node = p.offsetNode; offset = p.offset; }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    }
    return node && root.contains(node) ? pointToIndex(node, offset) : null;
  }

  /* ---------- Aids: fold ticks, X post windows ---------- */

  const aidPool = { tick: [], label: [], box: [], foot: [] };
  function pooled(kind, host, make) {
    const list = aidPool[kind];
    return (i) => {
      if (!list[i]) { list[i] = make(); host.append(list[i]); }
      list[i].hidden = false;
      return list[i];
    };
  }
  const hideFrom = (kind, n) => { for (let i = n; i < aidPool[kind].length; i++) aidPool[kind][i].hidden = true; };

  function segments() {
    const out = [];
    let from = -1;
    for (let i = 0; i < lines.length; i++) {
      if (isSep(i)) { if (from >= 0) out.push([from, i - 1]); from = -1; continue; }
      if (from < 0) from = i;
    }
    if (from >= 0) out.push([from, lines.length - 1]);
    return out;
  }

  function trimmed(a, b) {
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    return [a, b];
  }

  function placeAids() {
    if (!aidsEl || !root.children.length) return;
    const sr = surface.getBoundingClientRect();
    // Fold ticks and their labels in the right margin.
    const folds = [...root.querySelectorAll('.mk-fold')];
    const tick = pooled('tick', aidsEl, () => Object.assign(document.createElement('span'), { className: 'fold-tick' }));
    const label = pooled('label', aidsEl, () => Object.assign(document.createElement('span'), { className: 'fold-label margin-aid' }));
    const byY = new Map();
    folds.forEach((mk, i) => {
      const f = aids.folds.find((x) => x.label === mk.dataset.fold);
      const el = lineEl(mk);
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 24;
      const r = mk.getBoundingClientRect();
      const top = r.top + r.height / 2 - lh / 2 - sr.top;
      const t = tick(i);
      t.className = 'fold-tick fold-' + f.label;
      t.style.cssText = 'left:' + (r.left - sr.left) + 'px;top:' + top + 'px;height:' + lh + 'px';
      const key = Math.round(top);
      if (!byY.has(key)) byY.set(key, []);
      byY.get(key).push(f);
    });
    hideFrom('tick', folds.length);
    let li = 0;
    for (const [top, list] of byY) {
      const l = label(li++);
      const lh = aidPool.tick[0] ? parseFloat(aidPool.tick[0].style.height) : 24;
      l.textContent = list.length === 1 ? list[0].label : 'see more';
      l.title = list.map((f) => f.title).join('\n');
      l.style.cssText = 'top:' + top + 'px;height:' + lh + 'px';
    }
    hideFrom('label', li);

    // X: a window around every post.
    if (!thread) { hideFrom('box', 0); hideFrom('foot', 0); return; }
    const segs = segments();
    const box = pooled('box', under, () => Object.assign(document.createElement('div'), { className: 'post-box' }));
    const foot = pooled('foot', aidsEl, () => {
      const f = document.createElement('div');
      f.className = 'post-foot';
      const num = document.createElement('button');
      num.type = 'button';
      num.className = 'post-num';
      num.addEventListener('mousedown', (e) => e.preventDefault());
      num.addEventListener('click', () => { const r = f._range; if (r) Editor.select(r[0], r[1]); });
      const meta = document.createElement('span');
      meta.className = 'post-meta';
      f.append(num, meta);
      return f;
    });
    const cs = getComputedStyle(root);
    const pad = parseFloat(cs.getPropertyValue('--post-pad')) || 18;
    const footH = parseFloat(cs.getPropertyValue('--post-foot')) || 22;
    segs.forEach(([a, b], k) => {
      const first = root.children[a].getBoundingClientRect();
      const last = root.children[b].getBoundingClientRect();
      const top = first.top - sr.top - pad;
      const height = last.bottom - first.top + pad * 2 + footH;
      const bx = box(k);
      bx.style.cssText = 'top:' + top + 'px;height:' + height + 'px';
      const [s, e] = trimmed(starts[a], lineEnd(b));
      const info = aids && aids.post ? aids.post(s, e) : null;
      bx.classList.toggle('is-over', !!(info && info.length > info.limit));
      const f = foot(k);
      f._range = e > s ? [s, e] : null;
      f.style.cssText = 'top:' + (top + height - pad / 2 - footH) + 'px;height:' + footH + 'px';
      const num = f.firstChild;
      num.hidden = segs.length < 2;
      num.textContent = (k + 1) + '/' + segs.length;
      num.title = 'Select post ' + (k + 1);
      if (info) {
        f.lastChild.textContent = info.words + (info.words === 1 ? ' word' : ' words') + ' · ' + info.length + '/' + info.limit;
        f.classList.toggle('is-over', info.length > info.limit);
      } else f.lastChild.textContent = '';
    });
    hideFrom('box', segs.length);
    hideFrom('foot', segs.length);
  }

  /* ---------- History ---------- */

  function record(before, kind, insert) {
    const now = Date.now();
    const top = history.undo[history.undo.length - 1];
    const joinable = top && kind === top.kind && (kind === 'type' || kind === 'delete') && now - top.at < 1200 &&
      top.after.text === before.text && !(kind === 'type' && /\s/.test(insert) && !/\s$/.test(top.insert || ''));
    if (joinable) {
      top.after = { text, sel: Object.assign({}, sel) };
      top.at = now;
      top.insert = insert;
    } else {
      history.undo.push({ before, after: { text, sel: Object.assign({}, sel) }, kind, at: now, insert });
      if (history.undo.length > 400) history.undo.shift();
    }
    history.redo.length = 0;
  }

  function restore(state, kind) {
    setModel(state.text);
    sel = Object.assign({}, state.sel);
    fxMarks = sentMarks = wordMarks = [];
    render();
    focus();
    call('onChange', { kind });
  }

  function undo() {
    const e = history.undo.pop();
    if (!e) return;
    history.redo.push(e);
    restore(e.before, 'undo');
  }

  function redo() {
    const e = history.redo.pop();
    if (!e) return;
    history.undo.push(e);
    restore(e.after, 'redo');
  }

  /* ---------- Editing ---------- */

  function call(name, arg) { return typeof hooks[name] === 'function' ? hooks[name](arg) : undefined; }

  // The one door for every change: replace [start, end) with insert.
  function change(start, end, insert, opts) {
    const o = opts || {};
    start = Math.max(0, Math.min(start, text.length));
    end = Math.max(start, Math.min(end, text.length));
    if (start === end && !insert && !o.sel) return false;
    const before = { text, sel: Object.assign({}, sel) };
    setModel(text.slice(0, start) + insert + text.slice(end));
    fxMarks = shift(fxMarks, start, end, insert.length);
    sentMarks = shift(sentMarks, start, end, insert.length);
    wordMarks = shift(wordMarks, start, end, insert.length);
    const caret = start + insert.length;
    sel = o.sel || { start: caret, end: caret, backward: false };
    if (text !== before.text || o.sel) record(before, o.kind || 'edit', insert);
    render();
    call('onChange', { kind: o.kind || 'edit' });
    return true;
  }

  const canDelete = () => call('canDelete') !== false;

  function prevGrapheme(i) {
    if (i <= 0) return 0;
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const from = Math.max(0, i - 32);
      let last = from;
      for (const g of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text.slice(from, i))) last = from + g.index;
      return last;
    }
    return /[\uDC00-\uDFFF]/.test(text[i - 1]) ? i - 2 : i - 1;
  }
  function nextGrapheme(i) {
    if (i >= text.length) return text.length;
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const it = new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text.slice(i, i + 32))[Symbol.iterator]().next();
      return it.done ? i + 1 : i + it.value.segment.length;
    }
    return /[\uD800-\uDBFF]/.test(text[i]) ? i + 2 : i + 1;
  }

  function targetRange(e) {
    const rs = typeof e.getTargetRanges === 'function' ? e.getTargetRanges() : [];
    if (rs && rs.length) {
      const a = pointToIndex(rs[0].startContainer, rs[0].startOffset);
      const b = pointToIndex(rs[0].endContainer, rs[0].endOffset);
      if (a != null && b != null) return { start: Math.min(a, b), end: Math.max(a, b) };
    }
    return null;
  }

  // Backspace or Delete with nothing selected. Handles the cases the browser can't know about.
  function deleteAt(dir, e) {
    const at = sel.start;
    const li = lineOf(at);
    if (dir < 0 && at === starts[li]) {
      // At the top of an X post: backspace closes the window above, or folds this post into it.
      if (isSep(li - 1)) {
        const sepStart = starts[li - 1];
        const [a, b] = [starts[li], (() => { let k = li; while (k + 1 < lines.length && !isSep(k + 1)) k++; return lineEnd(k); })()];
        const blank = !/\S/.test(text.slice(a, b));
        if (blank) {
          const from = sepStart > 0 ? sepStart - 1 : 0;
          return change(from, b, '', { kind: 'delete', sel: { start: from, end: from, backward: false } }) || true;
        }
        const from = sepStart > 0 ? sepStart - 1 : sepStart;
        const to = sepStart > 0 ? lineEnd(li - 1) : starts[li];
        const caret = from + (sepStart > 0 ? 1 : 0);
        return change(from, to, '', { kind: 'delete', sel: { start: caret, end: caret, backward: false } }) || true;
      }
    }
    if (dir < 0) {
      // Just after a list or heading marker: backspace removes the marker.
      const blk = Inline.block(lines[li]);
      if (blk.prefix && blk.type !== 'hr' && blk.type !== 'opaque' && at === starts[li] + blk.prefix) {
        return change(starts[li], at, '', { kind: 'delete' });
      }
    }
    if (dir > 0 && at === lineEnd(li) && isSep(li + 1)) {
      return change(at, lineEnd(li + 1), '', { kind: 'delete', sel: { start: at, end: at, backward: false } }) || true;
    }
    const r = e && targetRange(e);
    if (r && r.end > r.start) return change(r.start, r.end, '', { kind: 'delete' });
    if (dir < 0) return change(prevGrapheme(at), at, '', { kind: 'delete' });
    return change(at, nextGrapheme(at), '', { kind: 'delete' });
  }

  function deleteBy(type, e) {
    if (sel.end > sel.start) return change(sel.start, sel.end, '', { kind: 'delete' });
    if (type === 'deleteContentBackward') return deleteAt(-1, e);
    if (type === 'deleteContentForward') return deleteAt(1, e);
    const r = targetRange(e);
    if (r && r.end > r.start) return change(r.start, r.end, '', { kind: 'delete' });
    const at = sel.start, li = lineOf(at);
    if (/Backward/.test(type)) {
      if (/Word/.test(type)) { const m = /\S*\s*$/.exec(text.slice(starts[li], at)); return change(at - (m[0].length || 1), at, '', { kind: 'delete' }); }
      return change(at === starts[li] ? Math.max(0, at - 1) : starts[li], at, '', { kind: 'delete' });
    }
    if (/Word/.test(type)) { const m = /^\s*\S*/.exec(text.slice(at, lineEnd(li))); return change(at, at + (m[0].length || 1), '', { kind: 'delete' }); }
    return change(at, at === lineEnd(li) ? at + 1 : lineEnd(li), '', { kind: 'delete' });
  }

  // Enter: a list keeps going; Enter on an empty item ends the list.
  function newline(soft) {
    const li = lineOf(sel.start);
    const blk = Inline.block(lines[li]);
    if (!soft && sel.start === sel.end && ['li', 'ol', 'todo', 'quote'].includes(blk.type)) {
      const rest = lines[li].slice(blk.prefix);
      if (!rest.trim() && sel.start === lineEnd(li)) return change(starts[li], lineEnd(li), '', { kind: 'enter' });
      let next = lines[li].slice(0, blk.prefix);
      if (blk.type === 'ol') next = next.replace(/\d+/, (n) => String(Number(n) + 1));
      if (blk.type === 'todo') next = '[ ] ';
      if (sel.start >= starts[li] + blk.prefix) return change(sel.start, sel.end, '\n' + next, { kind: 'enter' });
    }
    return change(sel.start, sel.end, '\n', { kind: 'enter' });
  }

  // ⌘B, ⌘I, ⌘⇧X: wrap the selection in markers, or unwrap it when it's already wrapped.
  function toggleWrap(mark) {
    const { start, end } = sel;
    const m = mark.length;
    const inside = text.slice(start - m, start) === mark && text.slice(end, end + m) === mark;
    const outside = text.slice(start, start + m) === mark && text.slice(end - m, end) === mark && end - start >= 2 * m;
    if (inside) {
      return change(start - m, end + m, text.slice(start, end), { kind: 'format', sel: { start: start - m, end: end - m, backward: false } });
    }
    if (outside) {
      const inner = text.slice(start + m, end - m);
      return change(start, end, inner, { kind: 'format', sel: { start, end: start + inner.length, backward: false } });
    }
    if (start === end) {
      return change(start, end, mark + mark, { kind: 'format', sel: { start: start + m, end: start + m, backward: false } });
    }
    // Keep spaces outside the markers.
    let a = start, b = end;
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    return change(a, b, mark + text.slice(a, b) + mark, { kind: 'format', sel: { start: a + m, end: b + m, backward: false } });
  }

  function setBlock(prefix) {
    const li = lineOf(sel.start);
    const blk = Inline.block(lines[li]);
    const old = blk.type === 'hr' || blk.type === 'opaque' ? 0 : blk.prefix;
    const cur = lines[li].slice(0, old);
    const next = cur === prefix ? '' : prefix;
    const d = next.length - old;
    return change(starts[li], starts[li] + old, next, {
      kind: 'format',
      sel: { start: Math.max(starts[li], sel.start + d), end: Math.max(starts[li], sel.end + d), backward: false }
    });
  }

  function insertLink() {
    const { start, end } = sel;
    const label = text.slice(start, end);
    const isUrl = /^https?:\/\/\S+$/.test(label);
    const insert = isUrl ? '[](' + label + ')' : '[' + label + '](https://)';
    const caret = isUrl ? start + 1 : start + label.length + 3 + 8;
    return change(start, end, insert, { kind: 'format', sel: { start: caret, end: caret, backward: false } });
  }

  function onBeforeInput(e) {
    if (e.defaultPrevented) return;
    const t = e.inputType || '';
    if (t === 'insertCompositionText' || t === 'deleteCompositionText' || t === 'insertFromComposition') return;
    e.preventDefault();
    if (readOnly) return;
    if (t === 'historyUndo') return undo();
    if (t === 'historyRedo') return redo();
    if (t === 'formatBold') return toggleWrap(WRAPS.bold);
    if (t === 'formatItalic') return toggleWrap(WRAPS.italic);
    if (t === 'formatStrikeThrough') return toggleWrap(WRAPS.strike);
    if (t.startsWith('delete')) {
      if (!canDelete()) { call('onBlocked'); return; }
      return deleteBy(t, e);
    }
    if (t === 'insertParagraph') return newline(false);
    if (t === 'insertLineBreak') return newline(true);
    let data = e.data;
    if (data == null && e.dataTransfer) data = fromTransfer(e.dataTransfer);
    if (data == null) return;
    data = String(data).replace(/\r\n?/g, '\n');
    const r = (t === 'insertReplacementText' || t === 'insertFromDrop' || sel.start === sel.end) ? targetRange(e) : null;
    const range = r || { start: sel.start, end: sel.end };
    if (range.end > range.start && !canDelete() && t !== 'insertText') { call('onBlocked'); return; }
    const kind = t === 'insertText' && data.length === 1 && range.start === range.end ? 'type' : 'edit';
    change(range.start, range.end, data, { kind });
  }

  function onKeyDown(e) {
    if (e.defaultPrevented || e.isComposing) return;
    const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    const key = String(e.key || '').toLowerCase();
    if (!mod) return;
    let done = true;
    if (key === 'z' && !e.shiftKey && !e.altKey) undo();
    else if ((key === 'z' && e.shiftKey) || (key === 'y' && e.ctrlKey && !e.metaKey)) redo();
    else if (readOnly) done = false;
    else if (key === 'b' && !e.altKey && !e.shiftKey) toggleWrap(WRAPS.bold);
    else if (key === 'i' && !e.altKey && !e.shiftKey) toggleWrap(WRAPS.italic);
    else if (key === 'x' && e.shiftKey && !e.altKey) toggleWrap(WRAPS.strike);
    else if (key === 'k' && !e.altKey && !e.shiftKey) insertLink();
    else if (e.altKey && /^Digit[0-3]$/.test(e.code)) setBlock(['', '# ', '## ', '### '][Number(e.code.slice(5))]);
    else if (e.shiftKey && e.code === 'Digit8' && !e.altKey) setBlock('- ');
    else if (e.shiftKey && e.code === 'Digit7' && !e.altKey) setBlock('1. ');
    else done = false;
    if (done) e.preventDefault();
  }

  /* ---------- Clipboard ---------- */

  function fromTransfer(dt) {
    if (!dt) return null;
    const html = dt.getData('text/html');
    if (html) {
      const md = htmlToMd(html);
      if (md != null && md.trim()) return md;
    }
    const plain = dt.getData('text/plain');
    return plain ? plain.replace(/\r\n?/g, '\n') : null;
  }

  const BLOCK_TAGS = /^(P|DIV|H[1-6]|LI|BLOCKQUOTE|PRE|TR|SECTION|ARTICLE|HEADER|FOOTER|UL|OL|TABLE|FIGURE|DT|DD)$/;

  // Rich text from another app → markdown-lite lines. Parsed in an inert document: nothing runs.
  function htmlToMd(html) {
    let doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (_) { return null; }
    const out = [];
    let runs = [];
    let prefix = '';
    const has = () => runs.some((r) => r.text.trim()) || prefix;
    const end = () => {
      const body = Inline.serialize(runs).replace(/^[ \t ]+|[ \t ]+$/g, '');
      out.push(prefix + body);
      runs = [];
      prefix = '';
    };
    function styleOf(el, st) {
      const s = Object.assign({}, st);
      const tag = el.tagName;
      const fw = el.style && el.style.fontWeight;
      if (tag === 'B' || tag === 'STRONG') s.b = true;
      if (fw) s.b = fw === 'bold' || fw === 'bolder' || Number(fw) >= 600;
      if (tag === 'I' || tag === 'EM' || (el.style && el.style.fontStyle === 'italic')) s.i = true;
      if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE' || /line-through/.test((el.style && (el.style.textDecoration || el.style.textDecorationLine)) || '')) s.s = true;
      if (tag === 'CODE' || tag === 'KBD') s.c = true;
      if (tag === 'A') {
        const href = el.getAttribute('href') || '';
        if (/^(https?:|mailto:)/i.test(href)) s.link = href;
      }
      return s;
    }
    function walk(node, st) {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) {
          const t = n.data.replace(/[\r\n\t ]+/g, ' ');
          if (t) runs.push(Object.assign({ text: t }, st));
          continue;
        }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName;
        if (/^(SCRIPT|STYLE|META|TITLE|NOSCRIPT|TEMPLATE|HEAD)$/.test(tag)) continue;
        if (tag === 'BR') { end(); continue; }
        if (tag === 'HR') { if (has()) end(); out.push('---'); continue; }
        const isBlock = BLOCK_TAGS.test(tag);
        if (isBlock && has()) end();
        if (/^H[1-6]$/.test(tag)) prefix = '#'.repeat(Math.min(3, Number(tag[1]))) + ' ';
        else if (tag === 'LI') {
          const list = n.parentElement;
          if (list && list.tagName === 'OL') {
            const items = [...list.children].filter((c) => c.tagName === 'LI');
            prefix = (Number(list.getAttribute('start')) || 1) + items.indexOf(n) + '. ';
          } else prefix = '- ';
        } else if (tag === 'BLOCKQUOTE') prefix = '> ';
        walk(n, styleOf(n, st));
        if (isBlock && has()) end();
      }
    }
    walk(doc.body, {});
    if (has()) end();
    while (out.length && !out[out.length - 1].trim()) out.pop();
    while (out.length && !out[0].trim()) out.shift();
    return out.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  function putClipboard(dt, slice) {
    const c = call('clipboard', slice) || { text: slice };
    dt.setData('text/plain', c.text);
    if (c.html) dt.setData('text/html', c.html);
  }

  /* ---------- Composition and anything else the browser typed itself ---------- */

  function readDom() {
    const ds = document.getSelection();
    const fn = ds && ds.rangeCount ? ds.focusNode : null;
    const fo = ds ? ds.focusOffset : 0;
    const out = [];
    let caret = -1, pos = 0;
    for (const n of root.childNodes) {
      let t;
      if (n.nodeType === 3) t = n.data;
      else if (n.nodeType === 1) t = n.textContent;
      else continue;
      if (caret < 0 && fn && (n === fn || n.contains(fn))) {
        const r = document.createRange();
        r.setStart(n, 0);
        try { r.setEnd(fn, fo); caret = pos + r.toString().length; } catch (_) { caret = pos; }
      }
      out.push(t);
      pos += t.length + 1;
    }
    return { text: out.length ? out.join('\n') : '', caret };
  }

  function reconcile() {
    clearTimeout(reconcileTimer);
    if (composing || !root) return;
    const got = readDom();
    rendered = []; // the browser touched the page: redraw it all
    if (got.text !== text) {
      const before = { text, sel: Object.assign({}, sel) };
      setModel(got.text);
      const c = got.caret >= 0 ? Math.min(got.caret, text.length) : sel.end;
      sel = { start: c, end: c, backward: false };
      record(before, 'ime', '');
      fxMarks = sentMarks = wordMarks = [];
      render();
      call('onChange', { kind: 'ime' });
    } else {
      render();
    }
  }

  /* ---------- Public ---------- */

  function focus() {
    if (!root) return;
    if (document.activeElement !== root) root.focus({ preventScroll: true });
    applySel();
  }

  function scrollToIndex(index, frac, smooth) {
    const rc = rectAt(index);
    if (!rc) return;
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const y = Math.max(0, window.scrollY + rc.lineTop + rc.lh / 2 - vh * frac);
    if (smooth && Math.abs(y - window.scrollY) > rc.lh * 1.5) window.scrollTo({ top: y, behavior: 'smooth' });
    else window.scrollTo(0, y);
  }

  // Plan for deleting a word or phrase cleanly: take one neighboring space, keep the sentence capitalized.
  function cutPlan(t, start, end, sentenceStart) {
    let s = start, e = end;
    if (t[e] === ',') e++;
    if (t[e] === ' ') e++;
    else if (t[s - 1] === ' ') s--;
    const next = t[e] || '';
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
    init(opts) {
      root = opts.root;
      surface = opts.surface;
      under = opts.under;
      aidsEl = opts.aids;
      hooks = opts.hooks || {};
      root.contentEditable = 'true';
      root.addEventListener('beforeinput', onBeforeInput);
      root.addEventListener('keydown', onKeyDown);
      root.addEventListener('input', (e) => {
        if (e.isComposing || composing) return;
        clearTimeout(reconcileTimer);
        reconcileTimer = setTimeout(reconcile, 0);
      });
      root.addEventListener('compositionstart', () => { composing = true; });
      root.addEventListener('compositionend', () => {
        composing = false;
        clearTimeout(reconcileTimer);
        reconcileTimer = setTimeout(reconcile, 0);
      });
      root.addEventListener('copy', (e) => {
        if (sel.end <= sel.start) return;
        e.preventDefault();
        putClipboard(e.clipboardData, text.slice(sel.start, sel.end));
      });
      root.addEventListener('cut', (e) => {
        if (sel.end <= sel.start) return;
        e.preventDefault();
        if (readOnly) return;
        putClipboard(e.clipboardData, text.slice(sel.start, sel.end));
        if (!canDelete()) { call('onBlocked'); return; }
        change(sel.start, sel.end, '', { kind: 'cut' });
      });
      root.addEventListener('paste', (e) => {
        e.preventDefault();
        if (readOnly) return;
        const data = fromTransfer(e.clipboardData);
        if (!data) return;
        if (sel.end > sel.start && !canDelete()) { call('onBlocked'); return; }
        change(sel.start, sel.end, data, { kind: 'paste' });
      });
      root.addEventListener('dragstart', (e) => e.preventDefault());
      root.addEventListener('drop', (e) => {
        e.preventDefault();
        if (readOnly) return;
        const data = fromTransfer(e.dataTransfer);
        const at = indexFromPoint(e.clientX, e.clientY);
        if (data && at != null) { root.focus({ preventScroll: true }); change(at, at, data, { kind: 'paste' }); }
      });
      root.addEventListener('mousedown', (e) => {
        const box = e.target.closest && e.target.closest('.pre-todo');
        if (!box || readOnly) return;
        e.preventDefault();
        const at = pointToIndex(box.firstChild || box, 0);
        if (at == null) return;
        const on = text[at + 1] !== ' ';
        const keep = Object.assign({}, sel);
        change(at + 1, at + 2, on ? ' ' : 'x', { kind: 'format', sel: keep });
      });
      root.addEventListener('focus', () => requestAnimationFrame(() => { if (document.activeElement === root && !readSel()) applySel(); }));
      document.addEventListener('selectionchange', onSelectionChange);
      window.addEventListener('resize', () => {
        cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(placeAids);
      });
      if (document.fonts) document.fonts.addEventListener('loadingdone', () => placeAids());
      setModel('');
      render();
    },
    setText(t, opts) {
      setModel(String(t || ''));
      const c = opts && opts.caret != null ? Math.min(opts.caret, text.length) : text.length;
      sel = { start: c, end: c, backward: false };
      fxMarks = sentMarks = wordMarks = [];
      if (!(opts && opts.keepHistory)) { history.undo.length = 0; history.redo.length = 0; }
      rendered = [];
      render();
    },
    // A change from elsewhere (Notion, another tab): keep the caret where it was.
    replaceText(t) {
      if (t === text) return;
      let p = 0;
      const max = Math.min(text.length, t.length);
      while (p < max && text.charCodeAt(p) === t.charCodeAt(p)) p++;
      const d = t.length - text.length;
      const move = (i) => (i <= p ? i : Math.max(0, Math.min(t.length, i + d)));
      const s = { start: move(sel.start), end: move(sel.end), backward: sel.backward };
      setModel(t);
      sel = s;
      history.undo.length = 0;
      history.redo.length = 0;
      fxMarks = sentMarks = wordMarks = [];
      render();
    },
    getText() { return text; },
    getSelection() { return { start: sel.start, end: sel.end }; },
    caretIndex() { return sel.end; },
    isComposing() { return composing; },
    setReadOnly(on) {
      readOnly = !!on;
      root.contentEditable = on ? 'false' : 'true';
    },
    setPlaceholder(s) { root.dataset.placeholder = s; },
    setThread(on) {
      if (thread === !!on) return;
      thread = !!on;
      root.classList.toggle('is-thread', thread);
      rendered = [];
      render();
    },
    setMarks(sent, word) { sentMarks = sent; wordMarks = word; },
    setFx(list) { fxMarks = list; },
    setAids(cfg) { aids = cfg || null; },
    setHidden(types) { for (const t of TYPES) root.classList.toggle('hide-' + t, types.includes(t)); },
    setActive(id) {
      for (const n of root.querySelectorAll('.is-active')) n.classList.remove('is-active');
      activeId = id || null;
      if (activeId) for (const n of root.querySelectorAll('[data-id="' + CSS.escape(activeId) + '"]')) n.classList.add('is-active');
    },
    render,
    placeAids,
    focus,
    rectAt,
    indexFromPoint,
    scrollToIndex,
    typewriterScroll() { scrollToIndex(sel.end, 0.45, true); },
    caretOnFirstLine() {
      if (sel.start !== sel.end || lineOf(sel.start) !== 0) return false;
      const rc = rectAt(sel.start);
      const first = root.children[0] && root.children[0].getBoundingClientRect();
      return !!rc && !!first && rc.lineTop < first.top + rc.lh * 0.6;
    },
    replaceRange(start, end, t) {
      focus();
      change(start, end, t, { kind: 'edit' });
      focus();
    },
    select(start, end) {
      sel = { start, end, backward: false };
      focus();
      scrollToIndex(start, 0.35);
    },
    setCaret(i) { sel = { start: i, end: i, backward: false }; focus(); },
    markRect(id) {
      const n = root.querySelector('[data-id="' + CSS.escape(id) + '"]');
      if (!n) return null;
      const rects = n.getClientRects();
      return rects.length ? rects[0] : null;
    },
    undo,
    redo,
    toggleWrap,
    htmlToMd,
    cutPlan,
    matchCase,
    buildLine
  };

  TDW.Editor = Editor;
})();
