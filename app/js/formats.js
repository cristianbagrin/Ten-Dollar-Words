/* Post formats. A format sets the line length (so line breaks land roughly where they will when
   posted), a default budget, and the Edit-mode aids: the LinkedIn fold, the limit, and X threads.
   render() turns a draft into the text the platform will show: no markdown, and on LinkedIn and X
   bold and italics become Unicode letters, since those sites have no formatting of their own.
   UMD: TDW.Formats in the browser, module.exports in Node (foldIndex needs a DOM). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./inline.js'));
  else { root.TDW = root.TDW || {}; root.TDW.Formats = factory(root.TDW.Inline); }
})(typeof self !== 'undefined' ? self : this, function (Inline) {
  'use strict';

  // LinkedIn cuts a post at about 140 characters on a phone and 210 on a computer, or after
  // 3 lines, whichever comes first. Widths and type are the feed's own.
  const FOLDS = {
    phone: { label: 'phone', chars: 140, lines: 3, width: 343, size: 14, leading: 20 },
    desktop: { label: 'desktop', chars: 210, lines: 3, width: 520, size: 14, leading: 20 }
  };
  const FORMATS = {
    basic: { label: 'Basic', measure: null, budget: null },
    linkedin: { label: 'LinkedIn', measure: '52ch', budget: 2000, limit: 3000, social: true, fold: true },
    x: { label: 'X', measure: '43ch', budget: 500, limit: 280, social: true, thread: true },
    substack: { label: 'Substack', measure: '70ch', budget: 8000 }
  };
  const LIST = Object.keys(FORMATS).map((key) => Object.assign({ key }, FORMATS[key]));
  const get = (key) => LIST.find((f) => f.key === key) || LIST[0];
  const budgetOf = (f, settings) => f.budget || settings.defaultBudget;

  /* ---------- What the platform shows ---------- */

  const MATH = {
    [Inline.B]: { upper: 0x1D5D4, lower: 0x1D5EE, digit: 0x1D7EC },
    [Inline.I]: { upper: 0x1D608, lower: 0x1D622, digit: 0 },
    [Inline.B | Inline.I]: { upper: 0x1D63C, lower: 0x1D656, digit: 0x1D7EC }
  };
  function styled(ch, style) {
    const t = MATH[style];
    if (!t) return ch;
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) return String.fromCodePoint(t.upper + c - 65);
    if (c >= 97 && c <= 122) return String.fromCodePoint(t.lower + c - 97);
    if (c >= 48 && c <= 57 && t.digit) return String.fromCodePoint(t.digit + c - 48);
    return ch;
  }

  // Returns { text, map }: map[k] is the draft index behind shown character k, and
  // map[text.length] is the end. Basic and Substack show the draft as written.
  function render(src, fmt) {
    const f = typeof fmt === 'string' ? get(fmt) : fmt;
    const text = String(src || '');
    if (!f || !f.social) {
      const map = new Int32Array(text.length + 1);
      for (let k = 0; k <= text.length; k++) map[k] = k;
      return { text, map };
    }
    let out = '';
    const map = [];
    const emit = (s, at) => { out += s; for (let k = 0; k < s.length; k++) map.push(at); };
    let ls = 0;
    const lines = text.split('\n');
    lines.forEach((line, li) => {
      const b = Inline.block(line);
      const last = li === lines.length - 1;
      if (b.type === 'opaque') { ls += line.length + 1; return; } // images and such aren't text
      let from = 0, base = 0;
      if (b.type === 'h1' || b.type === 'h2' || b.type === 'h3') { from = b.prefix; base = Inline.B; }
      else if (b.type === 'quote') from = b.prefix;
      else if (b.type === 'todo') { emit(b.checked ? '☑ ' : '☐ ', ls); from = b.prefix; }
      else if (b.type === 'hr') { emit(line, ls); from = line.length; }
      const { flags, links } = b.type === 'hr' ? { flags: [], links: [] } : Inline.parse(line, from);
      for (let k = from; k < line.length; k++) {
        const fl = flags[k] || 0;
        if (fl & Inline.MD) {
          const lk = links.find((x) => x.end === k);
          if (lk && line.slice(lk.start, lk.end) !== lk.url) emit(' (' + lk.url + ')', ls + k);
          continue;
        }
        const ch = line[k];
        const st = (fl | base) & (Inline.B | Inline.I);
        if (st && /[A-Za-z0-9]/.test(ch)) emit(styled(ch, st), ls + k);
        else emit(ch, ls + k);
        if (fl & Inline.S && !/\s/.test(ch)) emit('̶', ls + k);
      }
      if (!last) emit('\n', ls + line.length);
      ls += line.length + 1;
    });
    // The platforms trim the post.
    let a = 0, z = out.length;
    while (a < z && /\s/.test(out[a])) a++;
    while (z > a && /\s/.test(out[z - 1])) z--;
    const m = new Int32Array(z - a + 1);
    for (let k = a; k < z; k++) m[k - a] = map[k];
    m[z - a] = z < out.length ? map[z] : text.length;
    return { text: out.slice(a, z), map: m };
  }

  /* ---------- Rich text for the clipboard (Basic, Substack) ---------- */

  const escH = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inlineHTML(line, from) {
    const { flags, links } = Inline.parse(line, from);
    const STYLE = Inline.B | Inline.I | Inline.S | Inline.C;
    let out = '';
    let k = from;
    while (k < line.length) {
      if (flags[k] & Inline.MD) { k++; continue; }
      const st = flags[k] & STYLE;
      const lk = links.find((l) => k >= l.start && k < l.end) || null;
      let j = k, t = '';
      while (j < line.length && (flags[j] & Inline.MD || ((flags[j] & STYLE) === st && (links.find((l) => j >= l.start && j < l.end) || null) === lk))) {
        if (!(flags[j] & Inline.MD)) t += line[j];
        j++;
        if (lk && j >= lk.end) break;
      }
      let h = escH(t);
      if (st & Inline.C) h = '<code>' + h + '</code>';
      if (st & Inline.I) h = '<em>' + h + '</em>';
      if (st & Inline.B) h = '<strong>' + h + '</strong>';
      if (st & Inline.S) h = '<s>' + h + '</s>';
      if (lk && /^(https?:|mailto:)/i.test(lk.url)) h = '<a href="' + escH(lk.url) + '">' + h + '</a>';
      out += h;
      k = j;
    }
    return out;
  }

  function toHTML(md) {
    const out = [];
    let list = null;
    const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
    for (const line of String(md || '').split('\n')) {
      const b = Inline.block(line);
      if (b.type === 'li' || b.type === 'ol' || b.type === 'todo') {
        const tag = b.type === 'ol' ? 'ol' : 'ul';
        if (list !== tag) { closeList(); out.push('<' + tag + '>'); list = tag; }
        out.push('<li>' + (b.type === 'todo' ? (b.checked ? '☑ ' : '☐ ') : '') + inlineHTML(line, b.prefix) + '</li>');
        continue;
      }
      closeList();
      if (b.type === 'opaque' || !line.trim()) continue;
      if (b.type === 'hr') out.push('<hr>');
      else if (b.type === 'h1' || b.type === 'h2' || b.type === 'h3') out.push('<' + b.type + '>' + inlineHTML(line, b.prefix) + '</' + b.type + '>');
      else if (b.type === 'quote') out.push('<blockquote>' + inlineHTML(line, b.prefix) + '</blockquote>');
      else out.push('<p>' + inlineHTML(line, 0) + '</p>');
    }
    closeList();
    return out.join('');
  }

  /* ---------- X character counting (twitter-text v3) ---------- */

  const TLD = 'com|org|net|io|co|ai|app|dev|me|ly|so|gg|tv|xyz|us|uk|ca|de|fr|es|it|nl|au|in|jp|cn|tw|hk|sg|edu|gov|info|biz|news|blog|page|link|site';
  const X_URL = new RegExp('https?:\\/\\/[^\\s]+|www\\.[^\\s]+|\\b[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.(?:' + TLD + ')\\b(?:\\/[^\\s]*)?', 'gi');
  const TRAIL = /[.,!?:;)'"\]]+$/;
  const PICTO = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
  const light = (c) => c <= 0x10FF || (c >= 0x2000 && c <= 0x200D) || (c >= 0x2010 && c <= 0x201F) || (c >= 0x2032 && c <= 0x2037);
  const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;

  // [{ index, weight }] per grapheme: an emoji of any length counts 2, like X counts it.
  function graphemes(s) {
    const out = [];
    if (segmenter) {
      for (const g of segmenter.segment(s)) {
        let w;
        if (PICTO.test(g.segment)) w = 2;
        else { w = 0; for (const ch of g.segment) w += light(ch.codePointAt(0)) ? 1 : 2; }
        out.push({ index: g.index, len: g.segment.length, weight: w });
      }
    } else {
      for (let i = 0; i < s.length;) {
        const c = s.codePointAt(i);
        const len = c > 0xffff ? 2 : 1;
        out.push({ index: i, len, weight: light(c) ? 1 : 2 });
        i += len;
      }
    }
    return out;
  }

  function urls(s) {
    const out = [];
    const re = new RegExp(X_URL.source, 'gi');
    let m;
    while ((m = re.exec(s))) {
      const u = m[0].replace(TRAIL, '');
      if (u) out.push({ start: m.index, end: m.index + u.length });
    }
    return out;
  }

  // Walk the text as X counts it; stop at the first index where the count passes max.
  function walk(s, max) {
    const us = urls(s);
    let len = 0, u = 0;
    for (const g of graphemes(s)) {
      while (u < us.length && us[u].end <= g.index) u++;
      const inUrl = u < us.length && us[u].start <= g.index;
      if (inUrl) {
        if (g.index === us[u].start) { len += 23; if (len > max) return { len, at: g.index }; }
        continue;
      }
      len += g.weight;
      if (len > max) return { len, at: g.index };
    }
    return { len, at: -1 };
  }

  const xLength = (s) => walk(String(s || '').normalize('NFC'), Infinity).len;
  // Within [from, to): the first index where the count passes max, or -1.
  function xOverflowIndex(text, from, to, max) {
    const r = walk(text.slice(from, to), max);
    return r.at < 0 ? -1 : from + r.at;
  }

  /* ---------- Threads ---------- */

  // Lines that are just --- separate posts. Each post runs from its first to its last
  // non-blank line; empty posts don't count. Returns [{ start, end }].
  const SEPARATOR = /^[ \t]*---[ \t]*$/;
  function posts(text) {
    const out = [];
    let first = -1, last = -1, ls = 0;
    const close = () => { if (first >= 0) out.push({ start: first, end: last }); first = last = -1; };
    for (;;) {
      let le = text.indexOf('\n', ls);
      if (le < 0) le = text.length;
      const line = text.slice(ls, le);
      if (SEPARATOR.test(line)) close();
      else if (/\S/.test(line)) { if (first < 0) first = ls; last = le; }
      if (le >= text.length) break;
      ls = le + 1;
    }
    close();
    return out;
  }

  // One post as X will count it: { length, over } where over is the draft index where it
  // passes the limit, or -1.
  function xPost(text, start, end, limit) {
    const r = render(text.slice(start, end), 'x');
    const length = walk(r.text, Infinity).len;
    const w = length > limit ? walk(r.text, limit) : { at: -1 };
    return { length, over: w.at < 0 ? -1 : start + r.map[w.at] };
  }

  /* ---------- The LinkedIn fold (browser only) ---------- */

  let probe = null;
  const SUFFIX = '…see more';
  function lineCount(s, cfg) {
    probe.textContent = s + SUFFIX;
    return Math.round(probe.offsetHeight / cfg.leading);
  }

  // Index in the shown text where LinkedIn cuts it, or -1 when the whole post shows.
  function foldIndex(shown, cfg) {
    if (typeof document === 'undefined') return -1;
    if (!probe) {
      probe = document.createElement('div');
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none;' +
        'white-space:pre-wrap;overflow-wrap:break-word;word-break:normal;padding:0;margin:0;border:0;' +
        'font-family:-apple-system,system-ui,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-weight:400;letter-spacing:0;';
      document.body.append(probe);
    }
    probe.style.width = cfg.width + 'px';
    probe.style.fontSize = cfg.size + 'px';
    probe.style.lineHeight = cfg.leading + 'px';
    probe.textContent = shown;
    if (shown.length <= cfg.chars && Math.round(probe.offsetHeight / cfg.leading) <= cfg.lines) return -1;
    let hi = Math.min(shown.length, cfg.chars);
    if (hi < shown.length && /\S/.test(shown[hi])) {
      let k = hi;
      while (k > 0 && /\S/.test(shown[k - 1])) k--;
      if (k > 0) hi = k;
    }
    let lo = 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineCount(shown.slice(0, mid).replace(/\s+$/, ''), cfg) <= cfg.lines) lo = mid;
      else hi = mid - 1;
    }
    let k = lo;
    if (k > 0 && k < shown.length && /\S/.test(shown[k]) && /\S/.test(shown[k - 1])) {
      let j = k;
      while (j > 0 && /\S/.test(shown[j - 1])) j--;
      if (j > 0) k = j; // LinkedIn cuts between words
    }
    while (k > 0 && /\s/.test(shown[k - 1])) k--;
    return k;
  }

  return { LIST, FOLDS, get, budgetOf, render, toHTML, xLength, xOverflowIndex, xPost, posts, foldIndex, SEPARATOR };
});
