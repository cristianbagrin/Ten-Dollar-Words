/* The editor: a contenteditable with one <div class="ln"> per line of the draft.
   The draft is stored as markdown-lite text (see inline.js), but the page shows only what a
   reader sees: no ** or # markers, just bold words and headings, like Notion. Every edit is
   made on the visible characters and their styles, then the changed lines are written back
   as markdown and redrawn. IME composition (Chinese, Japanese…) is the one case where the
   browser types into the page; the model catches up when composition ends.
   Positions: the public API speaks markdown offsets (what Engine and the app use); inside,
   the caret and selection are visible offsets. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};
  const Inline = TDW.Inline;
  const { MD, B, I, S, C, L } = Inline;
  const STYLE = B | I | S | C;
  const TYPES = ['spelling', 'hard', 'veryHard', 'complex', 'passive', 'adverb', 'qualifier'];
  const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  const PREFIX = { p: '', h1: '# ', h2: '## ', h3: '### ', li: '- ', quote: '> ' };
  const PLACEHOLDER = { h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', li: 'List', ol: 'List', todo: 'To-do', quote: 'Quote' };
  const LISTY = new Set(['li', 'ol', 'todo', 'quote']);

  let root = null;       // the contenteditable
  let surface = null;    // positioned parent of root, under and aids
  let under = null;      // behind the text: X post windows
  let aidsEl = null;     // above the text: fold ticks and labels, post footers
  let hooks = {};

  let text = '';         // markdown
  let lines = [''];      // markdown lines
  let starts = [0];      // markdown offset of each line
  let P = [];            // parsed lines
  let vstarts = [0];     // visible offset of each line
  let sel = { start: 0, end: 0, backward: false }; // visible offsets
  let pending = null;    // style for the next typed text, after ⌘B with nothing selected
  let rendered = [];
  let composing = false;
  let readOnly = false;
  let thread = false;
  let aids = null;       // { folds: [{ index, label, title }], post: (start, end) => { words, length, limit }, addPost }
  let fxMarks = [];
  let sentMarks = [];
  let wordMarks = [];
  let activeId = null;
  let resizeRaf = 0;
  let reconcileTimer = 0;
  const history = { undo: [], redo: [] };

  /* ---------- Lines: markdown <-> what shows ---------- */

  const cache = new Map();
  // { blk: { type, checked, num }, chars: [{ ch, f, link }], vis, map: markdown column of each visible char, content }
  function parseLine(md) {
    let p = cache.get(md);
    if (p) return p;
    const b = Inline.block(md);
    const blk = { type: b.type };
    if (b.type === 'todo') blk.checked = b.checked;
    if (b.type === 'ol') blk.num = parseInt(md, 10) || 1;
    const chars = [];
    const map = [];
    if (b.type === 'opaque') {
      for (let k = 0; k < md.length; k++) { chars.push({ ch: md[k], f: 0, link: null }); map.push(k); }
    } else if (b.type !== 'hr') {
      const { flags, links } = Inline.parse(md, b.prefix);
      for (let k = b.prefix; k < md.length; k++) {
        const fl = flags[k];
        if (fl & MD) continue;
        let link = null;
        if (fl & L) { const lk = links.find((x) => k >= x.start && k < x.end); link = lk ? lk.url : null; }
        chars.push({ ch: md[k], f: fl & STYLE, link });
        map.push(k);
      }
    }
    p = { blk, chars, vis: chars.map((c) => c.ch).join(''), map, content: b.type === 'hr' ? md.length : b.type === 'opaque' ? 0 : b.prefix };
    if (cache.size > 4000) cache.clear();
    cache.set(md, p);
    return p;
  }

  function serializeLine(o) {
    const t = o.blk.type;
    if (t === 'hr') return '---';
    if (t === 'opaque') return o.chars.map((c) => c.ch).join('');
    const runs = o.chars.map((c) => ({ text: c.ch, b: !!(c.f & B), i: !!(c.f & I), s: !!(c.f & S), c: !!(c.f & C), link: c.link }));
    let body = Inline.serialize(runs);
    if (t === 'p') body = Inline.escapeLineStart(body);
    const prefix = t === 'ol' ? (o.blk.num || 1) + '. ' : t === 'todo' ? (o.blk.checked ? '[x] ' : '[ ] ') : PREFIX[t] || '';
    return prefix + body;
  }

  function setModel(t) {
    text = t;
    lines = t.split('\n');
    starts = new Array(lines.length);
    vstarts = new Array(lines.length);
    P = new Array(lines.length);
    let p = 0, v = 0;
    for (let i = 0; i < lines.length; i++) {
      starts[i] = p;
      vstarts[i] = v;
      P[i] = parseLine(lines[i]);
      p += lines[i].length + 1;
      v += P[i].vis.length + 1;
    }
  }

  const vlength = () => vstarts[lines.length - 1] + P[lines.length - 1].vis.length;
  const lineEnd = (i) => starts[i] + lines[i].length;
  const isSep = (i) => thread && i >= 0 && i < lines.length && P[i].blk.type === 'hr';

  function search(arr, x) { // last index with arr[i] <= x
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (arr[mid] <= x) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  const lineOf = (m) => search(starts, m);
  const vLineOf = (v) => search(vstarts, v);

  // Visible characters in line i that come before markdown column c.
  function colOf(i, c) {
    const map = P[i].map;
    let lo = 0, hi = map.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (map[mid] < c) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function mdToVis(m) {
    const x = Math.max(0, Math.min(m, text.length));
    const i = lineOf(x);
    return vstarts[i] + colOf(i, x - starts[i]);
  }
  // Just after the visible character before v (so opening markers come along).
  function visToMd(v) {
    const i = vLineOf(Math.max(0, Math.min(v, vlength())));
    const k = v - vstarts[i];
    return starts[i] + (k > 0 ? P[i].map[k - 1] + 1 : P[i].content);
  }
  // Just before the visible character at v (so closing markers come along).
  function visToMdEnd(v) {
    const i = vLineOf(Math.max(0, Math.min(v, vlength())));
    const k = v - vstarts[i];
    return starts[i] + (k < P[i].map.length ? P[i].map[k] : lines[i].length);
  }

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

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  const esc = (s) => (/[&<>"]/.test(s) ? s.replace(/[&<>"]/g, (c) => ESC[c]) : s);

  // layers: outer to inner, each a sorted list of non-overlapping { start, end, open, close }.
  function buildLine(s, layers, markers) {
    const cuts = new Set([0, s.length]);
    for (const Ls of layers) for (const r of Ls) { cuts.add(r.start); cuts.add(r.end); }
    for (const m of markers) cuts.add(m.index);
    const pts = [...cuts].filter((p) => p >= 0 && p <= s.length).sort((a, b) => a - b);
    const idx = layers.map(() => 0);
    const open = layers.map(() => null);
    let out = '';
    const closeFrom = (d) => { for (let k = layers.length - 1; k >= d; k--) if (open[k]) { out += open[k].close; open[k] = null; } };
    for (let p = 0; p < pts.length; p++) {
      const a = pts[p], b = p + 1 < pts.length ? pts[p + 1] : a;
      const want = layers.map((Ls, d) => {
        if (b <= a) return null;
        let i = idx[d];
        while (i < Ls.length && Ls[i].end <= a) i++;
        idx[d] = i;
        return i < Ls.length && Ls[i].start <= a && a < Ls[i].end ? Ls[i] : null;
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

  // Marks by line, in one pass, so drawing a line only looks at its own marks.
  const NONE = [];
  function byLineOf(list) {
    const out = new Map();
    for (const m of list) {
      if (m.end <= m.start) continue;
      for (let i = lineOf(Math.max(0, m.start)); i < lines.length && starts[i] < m.end; i++) {
        const at = out.get(i);
        if (at) at.push(m); else out.set(i, [m]);
      }
    }
    return out;
  }

  // Markdown-offset marks → this line's visible columns.
  function clip(list, i) {
    const ls = starts[i], le = lineEnd(i);
    const out = [];
    for (const m of list) {
      if (m.end <= ls || m.start >= le || m.end <= m.start) continue;
      const a = colOf(i, Math.max(m.start, ls) - ls), b = colOf(i, Math.min(m.end, le) - ls);
      if (b > a) out.push({ start: a, end: b, m });
    }
    return out;
  }
  const isActive = (m) => !!m.id && m.id === activeId;
  const OPEN = [
    (m) => '<span class="fx fx-' + m.type + '">',
    (m) => '<span class="hs hs-' + m.type + (isActive(m) ? ' is-active' : '') + '" data-id="' + esc(m.id) + '">',
    (m) => '<mark class="hl hl-' + m.type + (isActive(m) ? ' is-active' : '') + '" data-id="' + esc(m.id) + '">'
  ];
  const CLOSE = ['</span>', '</span>', '</mark>'];

  function styleRuns(p) {
    const out = [];
    const key = (c) => c.f + '|' + (c.link || '');
    for (let a = 0; a < p.chars.length;) {
      let b = a + 1;
      while (b < p.chars.length && key(p.chars[b]) === key(p.chars[a])) b++;
      const c = p.chars[a];
      const cls = [c.f & B ? 'b' : '', c.f & I ? 'i' : '', c.f & S ? 's' : '', c.f & C ? 'c' : '', c.link ? 'lk' : ''].filter(Boolean).join(' ');
      if (cls) out.push({ start: a, end: b, open: '<span class="' + cls + '"' + (c.link ? ' title="' + esc(c.link) + '"' : '') + '>', close: '</span>' });
      a = b;
    }
    return out;
  }

  function lineAttrs(i, olNum) {
    const p = P[i];
    const t = p.blk.type;
    const a = { cls: 'ln ln-' + t, n: '', ph: '' };
    if (t === 'todo' && p.blk.checked) a.cls += ' is-done';
    if (t === 'ol') a.n = String(olNum) + '.';
    if (!p.vis && PLACEHOLDER[t]) { a.cls += ' is-blank'; a.ph = PLACEHOLDER[t]; }
    if (!p.vis && t === 'p') a.cls += ' ln-empty';
    if (thread) {
      if (t === 'hr') a.cls = 'ln sep';
      else {
        if (i === 0 || isSep(i - 1)) a.cls += ' post-first';
        if (i === lines.length - 1 || isSep(i + 1)) a.cls += ' post-last';
      }
    }
    return a;
  }

  // A line's HTML depends only on its markdown and the marks on it, so it is kept and reused:
  // typing redraws one line, not the whole draft.
  const htmlMemo = new Map();
  function lineHTML(i, markers, fx, sm, wm) {
    const p = P[i];
    if (p.blk.type === 'hr') return '<br>';
    const layers = [clip(fx, i), clip(sm, i), clip(wm, i)];
    const plain = !markers.length && !layers[0].length && !layers[1].length && !layers[2].length;
    if (plain && p.html !== undefined) return p.html;
    let key = '';
    if (!plain) {
      key = lines[i] + '\u0001';
      for (const m of markers) key += m.index + m.html;
      for (const Ls of layers) {
        key += '\u0001';
        for (const r of Ls) key += r.start + ',' + r.end + ',' + r.m.type + ',' + (r.m.id || '') + (isActive(r.m) ? '!' : '') + ';';
      }
      const hit = htmlMemo.get(key);
      if (hit !== undefined) return hit;
    }
    layers.forEach((Ls, d) => { for (const r of Ls) { r.open = OPEN[d](r.m); r.close = CLOSE[d]; } });
    layers.push(styleRuns(p));
    let html = buildLine(p.vis, layers, markers);
    if (!p.vis.length) html += '<br>';
    if (plain) p.html = html;
    else {
      if (htmlMemo.size > 3000) htmlMemo.clear();
      htmlMemo.set(key, html);
    }
    return html;
  }

  let drawn = null; // what the last render drew from: the same inputs draw the same page
  function render() {
    if (!root) return;
    if (composing) return;
    const folds = aids && aids.folds;
    const d = drawn;
    if (d && d.text === text && d.fx === fxMarks && d.sm === sentMarks && d.wm === wordMarks && d.folds === folds &&
      d.active === activeId && d.thread === thread && d.rendered === rendered && root.childNodes.length === rendered.length) {
      placeAids();
      return;
    }
    const byLine = new Map();
    for (const f of (aids && aids.folds) || []) {
      if (f.index < 0 || f.index > text.length) continue;
      const i = lineOf(f.index);
      if (!byLine.has(i)) byLine.set(i, []);
      byLine.get(i).push({ index: colOf(i, f.index - starts[i]), html: '<span class="mk mk-fold" data-fold="' + f.label + '"></span>' });
    }
    const fx = byLineOf(fxMarks), sm = byLineOf(sentMarks), wm = byLineOf(wordMarks);
    const n = lines.length;
    const items = new Array(n);
    let ol = 0;
    for (let i = 0; i < n; i++) {
      ol = P[i].blk.type === 'ol' ? ol + 1 : 0;
      const a = lineAttrs(i, ol);
      a.html = lineHTML(i, byLine.get(i) || NONE, fx.get(i) || NONE, sm.get(i) || NONE, wm.get(i) || NONE);
      items[i] = a;
    }
    const touched = commit(items);
    drawn = { text, fx: fxMarks, sm: sentMarks, wm: wordMarks, folds, active: activeId, thread, rendered };
    root.classList.toggle('is-empty', text === '');
    if (touched && document.activeElement === root) applySel();
    placeAids();
  }

  function paint(node, a) {
    if (node.className !== a.cls) node.className = a.cls;
    if (a.n) node.dataset.n = a.n; else delete node.dataset.n;
    if (a.ph) node.dataset.ph = a.ph; else delete node.dataset.ph;
    node.innerHTML = a.html;
  }

  // Reused HTML strings are the same objects, so comparing them is cheap.
  const sameItem = (x, y) => x.html === y.html && x.cls === y.cls && x.n === y.n && x.ph === y.ph;

  function commit(items) {
    const kids = root.children;
    const valid = kids.length === rendered.length && root.childNodes.length === kids.length;
    if (!valid) {
      root.replaceChildren(...items.map((a) => { const d = document.createElement('div'); paint(d, a); return d; }));
      rendered = items;
      return true;
    }
    let a = 0;
    while (a < items.length && a < rendered.length && sameItem(items[a], rendered[a])) a++;
    let z = 0;
    while (z < items.length - a && z < rendered.length - a && sameItem(items[items.length - 1 - z], rendered[rendered.length - 1 - z])) z++;
    const oldCount = rendered.length - a - z, newCount = items.length - a - z;
    if (!oldCount && !newCount) return false;
    const common = Math.min(oldCount, newCount);
    for (let k = 0; k < common; k++) paint(kids[a + k], items[a + k]);
    if (newCount > oldCount) {
      const ref = kids[a + oldCount] || null;
      const frag = document.createDocumentFragment();
      for (let k = oldCount; k < newCount; k++) { const d = document.createElement('div'); paint(d, items[a + k]); frag.append(d); }
      root.insertBefore(frag, ref);
    } else {
      for (let k = oldCount - 1; k >= newCount; k--) kids[a + k].remove();
    }
    rendered = items;
    return true;
  }

  /* ---------- Page positions <-> visible offsets ---------- */

  function lineEl(node) {
    let el = node;
    while (el && el.parentNode !== root) el = el.parentNode;
    return el && el.parentNode === root ? el : null;
  }

  function pointToIndex(node, offset) {
    if (!node) return null;
    if (node === root) return offset >= lines.length ? vlength() : vstarts[offset];
    const el = lineEl(node);
    if (!el) return null;
    const li = Array.prototype.indexOf.call(root.children, el);
    if (li < 0 || li >= lines.length) return null;
    const r = document.createRange();
    r.setStart(el, 0);
    try { r.setEnd(node, offset); } catch (_) { return null; }
    return vstarts[li] + Math.min(r.toString().length, P[li].vis.length);
  }

  function indexToPoint(v) {
    const li = vLineOf(Math.max(0, Math.min(v, vlength())));
    const el = root.children[li];
    if (!el) return { node: root, offset: 0 };
    let col = v - vstarts[li];
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

  let expectSel = null; // the selection an edit just set; anything else is the user moving
  function onSelectionChange() {
    if (composing || document.activeElement !== root) return;
    const s = readSel();
    if (!s) return;
    const prev = sel;
    sel = s;
    if (pending && !(expectSel && expectSel.start === s.start && expectSel.end === s.end)) pending = null;
    // The caret never rests on a thread separator: step over it the way it was going.
    if (thread && s.start === s.end && isSep(vLineOf(s.start))) {
      const li = vLineOf(s.start);
      const down = prev.end <= s.start;
      const to = down && li + 1 < lines.length ? vstarts[li + 1] : li > 0 ? vstarts[li - 1] + P[li - 1].vis.length : vstarts[Math.min(li + 1, lines.length - 1)];
      sel = { start: to, end: to, backward: false };
      applySel();
    }
    if (prev.start !== sel.start || prev.end !== sel.end) call('onSelect');
  }

  function rectAtVis(v) {
    if (!root || !root.children.length) return null;
    const li = vLineOf(Math.max(0, Math.min(v, vlength())));
    const el = root.children[li];
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 24;
    const p = indexToPoint(v);
    let rc = null;
    if (p.node.nodeType === 3) {
      const r = document.createRange();
      r.setStart(p.node, p.offset);
      r.collapse(true);
      const list = r.getClientRects();
      rc = list.length ? list[0] : null;
      if ((!rc || !rc.height) && p.node.data.length) {
        const k = p.offset < p.node.data.length ? p.offset : p.offset - 1;
        r.setStart(p.node, k);
        r.setEnd(p.node, k + 1);
        const c = r.getClientRects();
        const cr = c.length ? c[c.length - 1] : null;
        if (cr) rc = { left: p.offset < p.node.data.length ? cr.left : cr.right, top: cr.top, height: cr.height };
      }
    }
    if (!rc || !rc.height) {
      const top = box.top + (parseFloat(cs.paddingTop) || 0);
      return { left: box.left + (parseFloat(cs.paddingLeft) || 0), top, height: lh, lineTop: top, lh };
    }
    return { left: rc.left, top: rc.top, height: rc.height, lineTop: rc.top - (lh - rc.height) / 2, lh };
  }

  function visFromPoint(x, y) {
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
    const folds = [...root.querySelectorAll('.mk-fold')];
    const tick = pooled('tick', aidsEl, () => Object.assign(document.createElement('span'), { className: 'fold-tick' }));
    const label = pooled('label', aidsEl, () => Object.assign(document.createElement('span'), { className: 'fold-label margin-aid' }));
    const byY = new Map();
    let lhFold = 24;
    folds.forEach((mk, i) => {
      const f = aids.folds.find((x) => x.label === mk.dataset.fold);
      const el = lineEl(mk);
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 24;
      lhFold = lh;
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
      l.textContent = list.length === 1 ? list[0].label : 'see more';
      l.title = list.map((f) => f.title).join('\n');
      l.style.cssText = 'top:' + top + 'px;height:' + lhFold + 'px';
    }
    hideFrom('label', li);

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
      // Phones have no ⌘↩: the last post gets a button for the next one.
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'post-add';
      add.textContent = '+ New post';
      add.hidden = true;
      add.addEventListener('mousedown', (e) => e.preventDefault());
      add.addEventListener('click', () => Editor.addPost());
      const meta = document.createElement('span');
      meta.className = 'post-meta';
      f.append(num, add, meta);
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
      f.children[1].hidden = !(aids && aids.addPost) || readOnly || k !== segs.length - 1;
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
    pending = null;
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

  /* ---------- Changing the model ---------- */

  function call(name, arg) { return typeof hooks[name] === 'function' ? hooks[name](arg) : undefined; }

  // Replace markdown [start, end) with insert. selAfter: a visible selection, or a function of the
  // new model that returns one.
  function applyMd(start, end, insert, selAfter, kind, typed) {
    const before = { text, sel: Object.assign({}, sel) };
    setModel(text.slice(0, start) + insert + text.slice(end));
    fxMarks = shift(fxMarks, start, end, insert.length);
    sentMarks = shift(sentMarks, start, end, insert.length);
    wordMarks = shift(wordMarks, start, end, insert.length);
    const s = typeof selAfter === 'function' ? selAfter() : selAfter;
    sel = s ? { start: s.start, end: s.end, backward: false } : sel;
    if (thread) fillEmptyPosts();
    expectSel = { start: sel.start, end: sel.end };
    if (text !== before.text) record(before, kind || 'edit', typed || insert);
    render();
    call('onChange', { kind: kind || 'edit' });
  }

  // X: every separator opens a window, so two in a row (or one at the end) get an empty
  // line after them. The selection moves with the text.
  function fillEmptyPosts() {
    const at = [];
    for (let i = 0; i < lines.length; i++) {
      if (P[i].blk.type === 'hr' && (i + 1 >= lines.length || P[i + 1].blk.type === 'hr')) at.push(lineEnd(i));
    }
    if (!at.length) return;
    const a = visToMd(sel.start), b = visToMd(sel.end);
    const moved = (m) => m + at.filter((p) => p < m).length;
    let t = '', last = 0;
    for (const p of at) { t += text.slice(last, p) + '\n'; last = p; }
    setModel(t + text.slice(last));
    sel = { start: mdToVis(moved(a)), end: mdToVis(moved(b)), backward: false };
  }

  // Replace lines a..b with line objects ({ blk, chars } or { md }). caret: { line, col } in the
  // new model, or { sel } to keep a visible selection.
  function commitLines(a, b, objs, caret, kind, typed) {
    for (const o of objs) if (o.blk && o.blk.type === 'hr' && o.chars && o.chars.length) o.blk = { type: 'p' };
    const mds = objs.map((o) => (o.md != null ? o.md : serializeLine(o)));
    let start, end, ins;
    if (mds.length) { start = starts[a]; end = lineEnd(b); ins = mds.join('\n'); }
    else if (b + 1 < lines.length) { start = starts[a]; end = starts[b + 1]; ins = ''; }
    else if (a > 0) { start = lineEnd(a - 1); end = lineEnd(b); ins = ''; }
    else { start = 0; end = text.length; ins = ''; }
    applyMd(start, end, ins, () => {
      if (caret.sel) return caret.sel;
      const li = Math.max(0, Math.min(caret.line, lines.length - 1));
      const v = vstarts[li] + Math.max(0, Math.min(caret.col, P[li].vis.length));
      return { start: v, end: v };
    }, kind, typed);
  }

  const charsOf = (s, style) => String(s).split('').map((u) => ({ ch: u, f: style.f, link: style.link }));

  // Style for text typed at visible offset v: the character before it (never a link unless
  // inside one), or what ⌘B/⌘I chose.
  function styleAt(v) {
    if (pending) return pending;
    const i = vLineOf(v), k = v - vstarts[i];
    const cs = P[i].chars;
    const left = k > 0 ? cs[k - 1] : null, right = k < cs.length ? cs[k] : null;
    const src = left || right;
    return { f: src ? src.f : 0, link: left && right && left.link && left.link === right.link ? left.link : null };
  }

  // The heart of editing: replace visible [a, b) with pieces. pieces[0].chars go in at a; each
  // later piece is a new line ({ blk, chars }); the last one gets the rest of line b.
  function editVis(a, b, pieces, kind, typed, firstBlk) {
    a = Math.max(0, Math.min(a, vlength()));
    b = Math.max(a, Math.min(b, vlength()));
    const ia = vLineOf(a), ib = vLineOf(b);
    const ka = a - vstarts[ia], kb = b - vstarts[ib];
    const la = P[ia], lb = P[ib];
    const head = la.chars.slice(0, ka), tail = lb.chars.slice(kb);
    let blkA = la.blk;
    if (firstBlk && !head.length && !tail.length && la.blk.type === 'p') blkA = firstBlk;
    let out, col;
    if (pieces.length === 1) {
      out = [{ blk: blkA, chars: head.concat(pieces[0].chars, tail) }];
      col = head.length + pieces[0].chars.length;
    } else {
      out = [{ blk: blkA, chars: head.concat(pieces[0].chars) }];
      for (let k = 1; k < pieces.length - 1; k++) out.push(pieces[k]);
      const last = pieces[pieces.length - 1];
      out.push({ blk: last.blk, chars: last.chars.concat(tail) });
      col = last.chars.length;
    }
    commitLines(ia, ib, out, { line: ia + out.length - 1, col }, kind, typed);
  }

  // Markdown text (typed, pasted, dropped) → pieces for editVis.
  function piecesOf(md, style) {
    const ls = String(md).replace(/\r\n?/g, '\n').split('\n');
    if (ls.length === 1) {
      const p = parseLine(ls[0]);
      if (p.blk.type === 'p' && !/[\\*_~`[]/.test(ls[0])) return { pieces: [{ chars: charsOf(ls[0], style) }] };
      return { pieces: [{ chars: p.chars.map((c) => Object.assign({}, c)) }], firstBlk: p.blk.type !== 'p' ? p.blk : null };
    }
    const ps = ls.map(parseLine);
    return {
      pieces: ps.map((p, k) => (k === 0 ? { chars: p.chars.slice() } : { blk: Object.assign({}, p.blk), chars: p.chars.slice() })),
      firstBlk: ps[0].blk.type !== 'p' ? ps[0].blk : null
    };
  }

  function insertText(data, kind) {
    if (data == null) return;
    const s = String(data).replace(/\r\n?/g, '\n');
    const typedOne = kind === 'type';
    const style = sel.end > sel.start ? (() => { const i = vLineOf(sel.start), k = sel.start - vstarts[i]; const c = P[i].chars[k]; return pending || (c ? { f: c.f, link: c.link } : styleAt(sel.start)); })() : styleAt(sel.start);
    if (!s.includes('\n') && (typedOne || !/[\\*_~`[]/.test(s))) {
      editVis(sel.start, sel.end, [{ chars: charsOf(s, style) }], kind, s);
      if (typedOne) autoformat(s);
      return;
    }
    const { pieces, firstBlk } = piecesOf(s, style);
    editVis(sel.start, sel.end, pieces, kind || 'paste', s, firstBlk);
  }

  /* ---------- Typing shortcuts, like Notion ---------- */

  // Hyphens typed so far on a line of dashes. iPhones turn -- into — as you type, so — counts two.
  const dashes = (s) => (/^[-–—]+$/.test(s) ? [...s].reduce((n, c) => n + (c === '-' ? 1 : 2), 0) : 0);

  function autoformat(ch) {
    if (sel.start !== sel.end) return;
    const i = vLineOf(sel.start), k = sel.start - vstarts[i];
    const p = P[i];
    // Markers typed into bold or italic text still count (they took the style of their neighbors).
    const plain = (a, b) => p.chars.slice(a, b).every((c) => !(c.f & C) && !c.link);
    if (ch === ' ' && p.blk.type !== 'p' && p.vis === ' ' && k === 1) {
      commitLines(i, i, [{ blk: p.blk, chars: [] }], { line: i, col: 0 }, 'format'); // "[]" then a space: the box already took it
      return;
    }
    if (p.blk.type === 'p') {
      const pre = p.vis.slice(0, k);
      let blk = null;
      if (ch === ' ' && plain(0, k)) {
        let m;
        if ((m = /^(#{1,3}) $/.exec(pre))) blk = { type: 'h' + m[1].length };
        else if (/^[-*+•] $/.test(pre)) blk = { type: 'li' };
        else if ((m = /^(\d+)[.)] $/.exec(pre))) blk = { type: 'ol', num: Number(m[1]) };
        else if (/^> $/.test(pre)) blk = { type: 'quote' };
        else if (/^\[ ?\] $/.test(pre)) blk = { type: 'todo', checked: false };
        else if (/^\[[xX]\] $/.test(pre)) blk = { type: 'todo', checked: true };
      } else if (ch === ']' && /^\[ ?\]$/.test(pre) && plain(0, k)) {
        blk = { type: 'todo', checked: false };
      } else if (ch === '-' && k === p.vis.length && dashes(p.vis) >= 3 && plain(0, k)) {
        commitLines(i, i, [{ blk: { type: 'hr' }, chars: [] }, { blk: { type: 'p' }, chars: [] }], { line: i + 1, col: 0 }, 'format');
        return;
      }
      if (blk) {
        commitLines(i, i, [{ blk, chars: p.chars.slice(k) }], { line: i, col: 0 }, 'format');
        return;
      }
    }
    const rules = {
      '*': [['**', B], ['*', I]],
      '_': [['__', B], ['_', I]],
      '~': [['~~', S], ['~', S]],
      '`': [['`', C]]
    }[ch];
    if (!rules) return;
    for (const [mark, bit] of rules) if (wrapTyped(i, k, mark, bit)) return;
  }

  // "**word**" just typed: bold the word and drop the stars.
  function wrapTyped(i, k, mark, bit) {
    const p = P[i];
    const m = mark.length;
    const vis = p.vis;
    const cs = p.chars;
    const ch = mark[0];
    const lit = (a, b) => cs.slice(a, b).every((c) => !(c.f & C) || bit === C);
    const close = k - m;
    if (close < 1 || vis.slice(close, k) !== mark || vis[close - 1] === ch || /\s/.test(vis[close - 1])) return false;
    if (!lit(close, k)) return false;
    for (let o = close - 1; o >= 0; o--) {
      if (vis.slice(o, o + m) !== mark) continue;
      const inner = o + m;
      if (inner >= close) continue;
      if (vis[o - 1] === ch || vis[inner] === ch || /\s/.test(vis[inner])) continue;
      if (o > 0 && /[A-Za-z0-9]/.test(vis[o - 1])) continue;
      if (!lit(o, inner)) continue;
      const content = cs.slice(inner, close).map((c) => ({ ch: c.ch, f: bit === C ? C : c.f | bit, link: c.link }));
      const next = cs.slice(0, o).concat(content, cs.slice(k));
      const was = content.length ? content[content.length - 1].f : 0;
      commitLines(i, i, [{ blk: p.blk, chars: next }], { line: i, col: o + content.length }, 'format');
      pending = { f: bit === C ? 0 : was & ~bit, link: null };
      return true;
    }
    return false;
  }

  /* ---------- Deleting ---------- */

  function prevGrapheme(v) {
    const i = vLineOf(v), k = v - vstarts[i];
    const s = P[i].vis.slice(Math.max(0, k - 32), k);
    if (typeof Intl !== 'undefined' && Intl.Segmenter && s) {
      let last = 0;
      for (const g of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)) last = g.index;
      return v - (s.length - last);
    }
    return /[\uDC00-\uDFFF]/.test(s[s.length - 1]) ? v - 2 : v - 1;
  }
  function nextGrapheme(v) {
    const i = vLineOf(v), k = v - vstarts[i];
    const s = P[i].vis.slice(k, k + 32);
    if (typeof Intl !== 'undefined' && Intl.Segmenter && s) {
      const it = new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)[Symbol.iterator]().next();
      return v + (it.done ? 1 : it.value.segment.length);
    }
    return /[\uD800-\uDBFF]/.test(s[0]) ? v + 2 : v + 1;
  }

  function targetRange(e) {
    const rs = e && typeof e.getTargetRanges === 'function' ? e.getTargetRanges() : [];
    if (rs && rs.length) {
      const a = pointToIndex(rs[0].startContainer, rs[0].startOffset);
      const b = pointToIndex(rs[0].endContainer, rs[0].endOffset);
      if (a != null && b != null) return { start: Math.min(a, b), end: Math.max(a, b) };
    }
    return null;
  }

  const lastLineOfPost = (i) => { let k = i; while (k + 1 < lines.length && !isSep(k + 1)) k++; return k; };

  function backspace(e) {
    if (sel.end > sel.start) return editVis(sel.start, sel.end, [{ chars: [] }], 'delete');
    const v = sel.start, i = vLineOf(v), k = v - vstarts[i];
    const p = P[i];
    if (k > 0) {
      const r = targetRange(e);
      if (r && r.end > r.start && r.end <= v && vLineOf(r.start) === i) return editVis(r.start, r.end, [{ chars: [] }], 'delete');
      return editVis(prevGrapheme(v), v, [{ chars: [] }], 'delete');
    }
    // At the start of a line.
    const t = p.blk.type;
    if (t !== 'p' && t !== 'hr' && t !== 'opaque') {
      return commitLines(i, i, [{ blk: { type: 'p' }, chars: p.chars }], { line: i, col: 0 }, 'delete'); // a list item or heading becomes text
    }
    if (i === 0) return;
    if (isSep(i - 1)) {
      // The top of an X post: an empty post goes away; otherwise it joins the post above.
      const end = lastLineOfPost(i);
      let blank = true;
      for (let x = i; x <= end; x++) if (P[x].vis.trim()) blank = false;
      if (blank) {
        const prev = i - 2;
        if (prev < 0) return commitLines(i - 1, end, [{ blk: { type: 'p' }, chars: [] }], { line: 0, col: 0 }, 'delete');
        return commitLines(i - 1, end, [], { line: prev, col: P[prev].vis.length }, 'delete');
      }
      // The post above is empty: it goes, and this one moves up.
      let top = i - 2;
      while (top >= 0 && !isSep(top)) top--;
      let above = true;
      for (let x = top + 1; x <= i - 2; x++) if (P[x].vis.trim()) above = false;
      if (above && i - 2 >= top + 1) return commitLines(top + 1, i - 1, [], { line: top + 1, col: 0 }, 'delete');
      return commitLines(i - 1, i - 1, [], { line: i - 1, col: 0 }, 'delete');
    }
    const q = P[i - 1];
    if (t === 'hr') return commitLines(i, i, [], { line: i - 1, col: q.vis.length }, 'delete');
    if (q.blk.type === 'hr') return commitLines(i - 1, i - 1, [], { line: i - 1, col: 0 }, 'delete');
    if (q.blk.type === 'opaque') {
      if (!p.vis) return commitLines(i, i, [], { line: i - 1, col: q.vis.length }, 'delete');
      return;
    }
    return commitLines(i - 1, i, [{ blk: q.blk, chars: q.chars.concat(p.chars) }], { line: i - 1, col: q.chars.length }, 'delete');
  }

  function forwardDelete(e) {
    if (sel.end > sel.start) return editVis(sel.start, sel.end, [{ chars: [] }], 'delete');
    const v = sel.start, i = vLineOf(v), k = v - vstarts[i];
    const p = P[i];
    if (k < p.vis.length) {
      const r = targetRange(e);
      if (r && r.end > r.start && r.start >= v && vLineOf(r.end) === i) return editVis(r.start, r.end, [{ chars: [] }], 'delete');
      return editVis(v, nextGrapheme(v), [{ chars: [] }], 'delete');
    }
    if (p.blk.type === 'hr') return commitLines(i, i, [], { line: i, col: 0 }, 'delete');
    if (i + 1 >= lines.length) return;
    const n = P[i + 1];
    if (isSep(i + 1) || n.blk.type === 'hr') return commitLines(i + 1, i + 1, [], { line: i, col: k }, 'delete');
    if (n.blk.type === 'opaque' || p.blk.type === 'opaque') return;
    return commitLines(i, i + 1, [{ blk: p.blk, chars: p.chars.concat(n.chars) }], { line: i, col: k }, 'delete');
  }

  function deleteBy(type, e) {
    if (type === 'deleteContentBackward') return backspace(e);
    if (type === 'deleteContentForward') return forwardDelete(e);
    if (sel.end > sel.start) return editVis(sel.start, sel.end, [{ chars: [] }], 'delete');
    const r = targetRange(e);
    if (r && r.end > r.start) return editVis(r.start, r.end, [{ chars: [] }], 'delete');
    return /Backward/.test(type) ? backspace(e) : forwardDelete(e);
  }

  /* ---------- Enter ---------- */

  function continuation(blk) {
    if (blk.type === 'li') return { type: 'li' };
    if (blk.type === 'ol') return { type: 'ol', num: (blk.num || 1) + 1 };
    if (blk.type === 'todo') return { type: 'todo', checked: false };
    if (blk.type === 'quote') return { type: 'quote' };
    return { type: 'p' };
  }

  function newline(soft) {
    const i = vLineOf(sel.start), k = sel.start - vstarts[i];
    const p = P[i];
    if (sel.start === sel.end) {
      if (!soft && LISTY.has(p.blk.type) && !p.vis) {
        return commitLines(i, i, [{ blk: { type: 'p' }, chars: [] }], { line: i, col: 0 }, 'enter'); // Enter on an empty item ends the list
      }
      if (k === 0 && p.vis && p.blk.type !== 'opaque') {
        return commitLines(i, i, [{ blk: { type: 'p' }, chars: [] }, { blk: p.blk, chars: p.chars }], { line: i + 1, col: 0 }, 'enter');
      }
    }
    editVis(sel.start, sel.end, [{ chars: [] }, { blk: soft ? { type: 'p' } : continuation(p.blk), chars: [] }], 'enter', '\n');
  }

  /* ---------- Formatting commands ---------- */

  function linesInSel() {
    const a = vLineOf(sel.start);
    let b = vLineOf(sel.end);
    if (b > a && sel.end === vstarts[b]) b--; // a selection ending at a line start doesn't take that line
    return [a, b];
  }

  // ⌘B, ⌘I, strike, code: on the selection, or on what you type next.
  function toggleStyle(bit) {
    if (sel.start === sel.end) {
      const cur = styleAt(sel.start);
      pending = { f: bit === C ? cur.f ^ C : cur.f ^ bit, link: null };
      expectSel = { start: sel.start, end: sel.end };
      call('onFormat', pending);
      return;
    }
    const [a, b] = [vLineOf(sel.start), vLineOf(sel.end)];
    let all = true;
    for (let i = a; i <= b; i++) {
      const from = i === a ? sel.start - vstarts[i] : 0, to = i === b ? sel.end - vstarts[i] : P[i].vis.length;
      for (let k = from; k < to; k++) if (/\S/.test(P[i].chars[k].ch) && !(P[i].chars[k].f & bit)) all = false;
    }
    const objs = [];
    for (let i = a; i <= b; i++) {
      const from = i === a ? sel.start - vstarts[i] : 0, to = i === b ? sel.end - vstarts[i] : P[i].vis.length;
      objs.push({ blk: P[i].blk, chars: P[i].chars.map((c, k) => (k >= from && k < to ? { ch: c.ch, f: all ? c.f & ~bit : (bit === C ? C : c.f | bit), link: c.link } : c)) });
    }
    const keep = { start: sel.start, end: sel.end };
    commitLines(a, b, objs, { sel: keep }, 'format');
  }

  // ⌘⌥1–3 headings, lists, to-dos: on every line of the selection; again turns it back to text.
  function setBlock(type) {
    const [a, b] = linesInSel();
    let all = true;
    for (let i = a; i <= b; i++) if (P[i].blk.type !== type) all = false;
    const objs = [];
    let num = 0;
    for (let i = a; i <= b; i++) {
      const p = P[i];
      if (p.blk.type === 'hr' || p.blk.type === 'opaque') { objs.push({ md: lines[i] }); continue; }
      const blk = all || type === 'p' ? { type: 'p' } : type === 'ol' ? { type: 'ol', num: ++num } : type === 'todo' ? { type: 'todo', checked: false } : { type };
      objs.push({ blk, chars: p.chars });
    }
    const keep = { start: sel.start, end: sel.end };
    commitLines(a, b, objs, { sel: keep }, 'format');
  }

  function toggleTodo(i) {
    const p = P[i];
    if (p.blk.type !== 'todo') return;
    const keep = { start: sel.start, end: sel.end };
    commitLines(i, i, [{ blk: { type: 'todo', checked: !p.blk.checked }, chars: p.chars }], { sel: keep }, 'format');
  }

  // ⌘K: link the selection. An empty address removes the link.
  function linkPrompt() {
    let { start, end } = sel;
    if (start === end) {
      const i = vLineOf(start), k = start - vstarts[i];
      const c = P[i].chars[k] || P[i].chars[k - 1];
      if (!c || !c.link) return;
      let a = k, b = k;
      while (a > 0 && P[i].chars[a - 1].link === c.link) a--;
      while (b < P[i].chars.length && P[i].chars[b].link === c.link) b++;
      start = vstarts[i] + a;
      end = vstarts[i] + b;
    }
    // A triple-click selects a paragraph up to the start of the next line; leave that line out.
    let i0 = vLineOf(start), i1 = vLineOf(end);
    if (i1 > i0 && end === vstarts[i1]) { i1--; end = vstarts[i1] + P[i1].vis.length; }
    const from = start - vstarts[i0];
    const current = P[i0].chars[from] && P[i0].chars[from].link;
    const label = i0 === i1 ? P[i0].chars.slice(from, end - vstarts[i0]).map((c) => c.ch).join('') : '';
    const apply = (url) => {
      const u = String(url || '').trim();
      const link = !u ? null : /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : 'https://' + u;
      const objs = [];
      for (let i = i0; i <= i1; i++) {
        const a = i === i0 ? start - vstarts[i] : 0, b = i === i1 ? end - vstarts[i] : P[i].vis.length;
        if (P[i].blk.type === 'hr' || P[i].blk.type === 'opaque') { objs.push({ md: lines[i] }); continue; }
        objs.push({ blk: P[i].blk, chars: P[i].chars.map((c, k) => (k >= a && k < b ? { ch: c.ch, f: c.f, link } : c)) });
      }
      commitLines(i0, i1, objs, { sel: { start, end } }, 'format');
      focus();
    };
    if (/^https?:\/\/\S+$/.test(label) && !current) { apply(label); return; }
    const rc = rectAtVis(start);
    if (!rc || !TDW.UI || !TDW.UI.menu) return;
    const anchor = {
      getBoundingClientRect: () => ({ left: rc.left, top: rc.lineTop, bottom: rc.lineTop + rc.lh, right: rc.left }),
      closest: () => null, contains: () => false, focus: () => focus(), isConnected: true
    };
    const input = TDW.UI.el('input', { type: 'text', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', class: 'menu-input', placeholder: 'Paste a link', 'aria-label': 'Link', value: current || '' });
    const form = TDW.UI.el('form', { class: 'menu-form' }, input,
      TDW.UI.el('div', { class: 'row-end' },
        current ? TDW.UI.el('button', { type: 'button', class: 'btn-quiet btn-sm', text: 'Remove', onclick: () => { TDW.UI.closeMenu(); apply(''); } }) : null,
        TDW.UI.el('button', { type: 'submit', class: 'btn btn-sm', text: 'Link' })));
    form.noValidate = true;
    form.addEventListener('submit', (ev) => { ev.preventDefault(); const u = input.value; TDW.UI.closeMenu(); apply(u); });
    TDW.UI.menu(anchor, [], () => false, form);
    input.focus();
  }

  /* ---------- Events ---------- */

  // The browser reports selection changes a moment late; read the live one before acting.
  function syncSel() {
    if (composing || document.activeElement !== root) return;
    const s = readSel();
    if (s && (s.start !== sel.start || s.end !== sel.end)) {
      if (pending && !(expectSel && expectSel.start === s.start && expectSel.end === s.end)) pending = null;
      sel = s;
    }
  }

  function onBeforeInput(e) {
    if (e.defaultPrevented) return;
    syncSel();
    const t = e.inputType || '';
    if (t === 'insertCompositionText' || t === 'deleteCompositionText' || t === 'insertFromComposition') return;
    e.preventDefault();
    if (readOnly) return;
    if (t === 'historyUndo') return undo();
    if (t === 'historyRedo') return redo();
    if (t === 'formatBold') return toggleStyle(B);
    if (t === 'formatItalic') return toggleStyle(I);
    if (t === 'formatStrikeThrough') return toggleStyle(S);
    if (t.startsWith('delete')) {
      if (call('canDelete') === false) { call('onBlocked'); return; }
      return deleteBy(t, e);
    }
    // Typing over a selection deletes it, so No backspace blocks that too.
    const replaces = () => sel.end > sel.start && call('canDelete') === false;
    if (t === 'insertParagraph' || t === 'insertLineBreak') {
      if (replaces()) { call('onBlocked'); return; }
      return newline(t === 'insertLineBreak');
    }
    let data = e.data;
    if (data == null && e.dataTransfer) data = fromTransfer(e.dataTransfer);
    if (data == null) return;
    if (t === 'insertReplacementText' || (sel.start === sel.end && t !== 'insertText')) {
      const r = targetRange(e);
      if (r) sel = { start: r.start, end: r.end, backward: false };
    }
    if (replaces()) { call('onBlocked'); return; }
    const one = t === 'insertText' && [...String(data)].length === 1 && sel.start === sel.end;
    insertText(data, one ? 'type' : 'edit');
  }

  function onKeyDown(e) {
    if (e.defaultPrevented || e.isComposing) return;
    const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!mod) return;
    syncSel();
    const key = String(e.key || '').toLowerCase();
    const code = e.code || '';
    let done = true;
    if (key === 'z' && !e.shiftKey && !e.altKey) undo();
    else if ((key === 'z' && e.shiftKey) || (key === 'y' && !IS_MAC)) redo();
    else if (readOnly) done = false;
    else if (key === 'b' && !e.altKey && !e.shiftKey) toggleStyle(B);
    else if (key === 'i' && !e.altKey && !e.shiftKey) toggleStyle(I);
    else if (e.shiftKey && !e.altKey && (key === 's' || key === 'x')) toggleStyle(S);
    else if (key === 'k' && !e.altKey && !e.shiftKey) linkPrompt();
    else if (e.altKey && !e.shiftKey && /^Digit[1-3]$/.test(code)) setBlock('h' + code.slice(5));
    else if (e.altKey && !e.shiftKey && code === 'Digit0') setBlock('p');
    else if (e.shiftKey && code === 'Digit7') setBlock('ol');
    else if (e.shiftKey && code === 'Digit8') setBlock('li');
    else if (e.shiftKey && code === 'Digit9') setBlock('todo');
    else if (key === 'enter' && e.shiftKey) { const i = vLineOf(sel.start); toggleTodo(i); }
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
      let body = Inline.serialize(runs).replace(/^[ \t ]+|[ \t ]+$/g, '');
      if (!prefix) body = Inline.escapeLineStart(body);
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
        if (tag === 'INPUT' && n.type === 'checkbox') { prefix = n.checked ? '[x] ' : '[ ] '; continue; }
        const isBlock = BLOCK_TAGS.test(tag);
        // A block inside a list item (Google Docs puts a <p> in every <li>) continues its line.
        if (isBlock && runs.some((r) => r.text.trim())) end();
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

  // The markdown for a visible range (so copying keeps bold, headings and lists).
  function mdOfVis(a, b) {
    const ia = vLineOf(a), ib = vLineOf(b);
    const out = [];
    for (let i = ia; i <= ib; i++) {
      const p = P[i];
      const from = i === ia ? a - vstarts[i] : 0, to = i === ib ? b - vstarts[i] : p.vis.length;
      if (from === 0 && to === p.vis.length) { out.push(lines[i]); continue; }
      out.push(serializeLine({ blk: from === 0 ? p.blk : { type: 'p' }, chars: p.chars.slice(from, to) }));
    }
    return out.join('\n');
  }

  function putClipboard(dt, md) {
    const c = call('clipboard', md) || { text: md };
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
    return { lines: out.length ? out : [''], caret };
  }

  function reconcile() {
    clearTimeout(reconcileTimer);
    if (composing || !root) return;
    const got = readDom();
    const cur = P.map((p) => p.vis);
    rendered = []; // the browser touched the page: redraw it all
    const changed = [];
    if (got.lines.length === cur.length) {
      for (let i = 0; i < cur.length; i++) if (got.lines[i] !== cur[i]) changed.push(i);
    }
    const caret = got.caret >= 0 ? got.caret : sel.end;
    if (got.lines.length === cur.length && !changed.length) { render(); return; }
    if (got.lines.length !== cur.length) {
      // Rare: the browser split or joined lines. Take its text as plain lines.
      const objs = got.lines.map((t) => ({ blk: { type: 'p' }, chars: charsOf(t, { f: 0, link: null }) }));
      commitLines(0, lines.length - 1, objs, { sel: { start: caret, end: caret } }, 'ime');
      return;
    }
    const a = changed[0], b = changed[changed.length - 1];
    const objs = [];
    for (let i = a; i <= b; i++) {
      const p = P[i];
      const nv = got.lines[i];
      if (nv === p.vis) { objs.push({ md: lines[i] }); continue; }
      let s = 0;
      while (s < nv.length && s < p.vis.length && nv[s] === p.vis[s]) s++;
      let e = 0;
      while (e < nv.length - s && e < p.vis.length - s && nv[nv.length - 1 - e] === p.vis[p.vis.length - 1 - e]) e++;
      const src = p.chars[s - 1] || p.chars[s] || { f: 0 };
      const mid = charsOf(nv.slice(s, nv.length - e), { f: src.f, link: null });
      objs.push({ blk: p.blk.type === 'hr' ? { type: 'p' } : p.blk, chars: p.chars.slice(0, s).concat(mid, p.chars.slice(p.vis.length - e)) });
    }
    commitLines(a, b, objs, { sel: { start: caret, end: caret } }, 'ime');
  }

  /* ---------- Public ---------- */

  function focus() {
    if (!root) return;
    if (document.activeElement !== root) root.focus({ preventScroll: true });
    applySel();
  }

  function scrollToVis(v, frac, smooth) {
    const rc = rectAtVis(v);
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
        syncSel();
        if (sel.end <= sel.start) return;
        e.preventDefault();
        putClipboard(e.clipboardData, mdOfVis(sel.start, sel.end));
      });
      root.addEventListener('cut', (e) => {
        syncSel();
        if (sel.end <= sel.start) return;
        e.preventDefault();
        if (readOnly) return;
        putClipboard(e.clipboardData, mdOfVis(sel.start, sel.end));
        if (call('canDelete') === false) { call('onBlocked'); return; }
        editVis(sel.start, sel.end, [{ chars: [] }], 'cut');
      });
      root.addEventListener('paste', (e) => {
        e.preventDefault();
        syncSel();
        if (readOnly) return;
        const data = fromTransfer(e.clipboardData);
        if (!data) return;
        if (sel.end > sel.start && call('canDelete') === false) { call('onBlocked'); return; }
        insertText(data, 'paste');
      });
      root.addEventListener('dragstart', (e) => e.preventDefault());
      root.addEventListener('drop', (e) => {
        e.preventDefault();
        if (readOnly) return;
        const data = fromTransfer(e.dataTransfer);
        const at = visFromPoint(e.clientX, e.clientY);
        if (data && at != null) {
          root.focus({ preventScroll: true });
          sel = { start: at, end: at, backward: false };
          insertText(data, 'paste');
        }
      });
      // A to-do's box sits in the line's left padding: clicking there ticks it.
      root.addEventListener('mousedown', (e) => {
        const el = e.target.closest && e.target.closest('.ln-todo');
        if (!el || readOnly || el.parentNode !== root) return;
        const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0;
        if (e.clientX > el.getBoundingClientRect().left + pad) return;
        e.preventDefault();
        toggleTodo(Array.prototype.indexOf.call(root.children, el));
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
      const v = opts && opts.caret != null ? mdToVis(opts.caret) : vlength();
      sel = { start: v, end: v, backward: false };
      pending = null;
      fxMarks = sentMarks = wordMarks = [];
      if (!(opts && opts.keepHistory)) { history.undo.length = 0; history.redo.length = 0; }
      rendered = [];
      render();
    },
    // A change from elsewhere (Notion, another tab): keep the caret where it was.
    replaceText(t) {
      if (t === text) return;
      const s = visToMd(sel.start), e = visToMd(sel.end);
      let p = 0;
      const max = Math.min(text.length, t.length);
      while (p < max && text.charCodeAt(p) === t.charCodeAt(p)) p++;
      const d = t.length - text.length;
      const move = (i) => (i <= p ? i : Math.max(0, Math.min(t.length, i + d)));
      setModel(t);
      sel = { start: mdToVis(move(s)), end: mdToVis(move(e)), backward: false };
      history.undo.length = 0;
      history.redo.length = 0;
      fxMarks = sentMarks = wordMarks = [];
      render();
    },
    getText() { return text; },
    // Markdown offsets. start sits after any opening markers' left edge, end after closing ones.
    getSelection() { return { start: visToMd(sel.start), end: sel.end > sel.start ? visToMdEnd(sel.end) : visToMd(sel.end) }; },
    caretIndex() { return visToMd(sel.end); },
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
    setFx(list) { if (list.length || fxMarks.length) fxMarks = list; },
    setAids(cfg) {
      // Unchanged folds keep their array, so an unchanged page isn't redrawn.
      const old = aids && aids.folds, next = cfg && cfg.folds;
      if (old && next && old.length === next.length && next.every((f, k) => f.index === old[k].index && f.label === old[k].label)) cfg.folds = old;
      aids = cfg || null;
    },
    setHidden(types) { for (const t of TYPES) root.classList.toggle('hide-' + t, types.includes(t)); },
    setActive(id) {
      for (const n of root.querySelectorAll('.is-active')) n.classList.remove('is-active');
      activeId = id || null;
      if (activeId) for (const n of root.querySelectorAll('[data-id="' + CSS.escape(activeId) + '"]')) n.classList.add('is-active');
    },
    render,
    placeAids,
    focus,
    rectAt(m) { return rectAtVis(mdToVis(m)); },
    indexFromPoint(x, y) { const v = visFromPoint(x, y); return v == null ? null : visToMd(v); },
    scrollToIndex(m, frac, smooth) { scrollToVis(mdToVis(m), frac, smooth); },
    typewriterScroll() { scrollToVis(sel.end, 0.45, true); },
    // A plain-text replacement of markdown [start, end); the new text takes the style of what it replaces.
    replaceRange(start, end, t) {
      focus();
      sel = { start: mdToVis(start), end: mdToVis(end), backward: false };
      pending = null;
      insertText(t, 'edit');
      focus();
    },
    // Delete markdown [start, end) the way a writer would: one neighboring space goes with it,
    // and the sentence stays capitalized. Works on what shows, so hidden markers don't get in the way.
    cut(start, end, sentenceStart) {
      const vt = P.map((p) => p.vis).join('\n');
      const plan = cutPlan(vt, mdToVis(start), mdToVis(end), sentenceStart >= 0 ? mdToVis(sentenceStart) : -1);
      focus();
      sel = { start: plan.start, end: plan.end, backward: false };
      pending = null;
      if (plan.replacement) insertText(plan.replacement, 'edit');
      else editVis(plan.start, plan.end, [{ chars: [] }], 'edit');
      focus();
    },
    // A new post after the last one, with the caret in it. An empty last post just gets the caret.
    addPost() {
      if (readOnly || !thread) return;
      const i = lines.length - 1;
      if (!P[i].vis && i > 0 && isSep(i - 1)) {
        sel = { start: vstarts[i], end: vstarts[i], backward: false };
      } else {
        commitLines(i, i, [{ md: lines[i] }, { blk: { type: 'hr' }, chars: [] }, { blk: { type: 'p' }, chars: [] }], { line: i + 2, col: 0 }, 'enter');
      }
      focus();
      scrollToVis(sel.end, 0.45, true);
    },
    insertSeparator() {
      if (sel.end > sel.start) {
        if (call('canDelete') === false) { call('onBlocked'); return; }
        editVis(sel.start, sel.end, [{ chars: [] }], 'delete');
      }
      const i = vLineOf(sel.start), k = sel.start - vstarts[i];
      const p = P[i];
      if (!p.vis) return commitLines(i, i, [{ blk: { type: 'hr' }, chars: [] }, { blk: { type: 'p' }, chars: [] }], { line: i + 1, col: 0 }, 'enter');
      commitLines(i, i, [{ blk: p.blk, chars: p.chars.slice(0, k) }, { blk: { type: 'hr' }, chars: [] }, { blk: { type: 'p' }, chars: p.chars.slice(k) }], { line: i + 2, col: 0 }, 'enter');
    },
    select(start, end) {
      sel = { start: mdToVis(start), end: mdToVis(end), backward: false };
      focus();
      scrollToVis(sel.start, 0.35);
    },
    setCaret(m) { const v = mdToVis(m); sel = { start: v, end: v, backward: false }; focus(); },
    selectAllVisible() { sel = { start: 0, end: vlength(), backward: false }; focus(); },
    visibleText() { return P.map((p) => p.vis).join('\n'); },
    markRect(id) {
      const n = root.querySelector('[data-id="' + CSS.escape(id) + '"]');
      if (!n) return null;
      const rects = n.getClientRects();
      return rects.length ? rects[0] : null;
    },
    undo,
    redo,
    toggleStyle(name) { toggleStyle({ bold: B, italic: I, strike: S, code: C }[name]); },
    setBlock,
    htmlToMd,
    cutPlan,
    matchCase,
    buildLine
  };

  TDW.Editor = Editor;
})();
