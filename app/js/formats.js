/* Post formats. A format only sets the line length (so line breaks land where they will when
   posted), a default budget, and the Edit-mode aids: the fold, the limit, and X threads. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};

  const SEE_MORE = 'Readers see everything before this point. The rest hides behind ';
  const FORMATS = {
    basic: { label: 'Basic', measure: null, budget: null },
    linkedin: { label: 'LinkedIn', measure: '52ch', budget: 2000, limit: 3000, fold: { chars: 140, lines: 3, label: '…see more', title: SEE_MORE + '“see more”.' } },
    x: { label: 'X', measure: '43ch', budget: 500, limit: 280, weighted: true, thread: true },
    instagram: { label: 'Instagram', measure: '52ch', budget: 1500, limit: 2200, fold: { chars: 125, lines: 2, label: '… more', title: SEE_MORE + '“… more”.' } },
    substack: { label: 'Substack', measure: '70ch', budget: 8000 }
  };
  const LIST = Object.keys(FORMATS).map((key) => Object.assign({ key }, FORMATS[key]));
  const get = (key) => LIST.find((f) => f.key === key) || LIST[0];
  const budgetOf = (f, settings) => f.budget || settings.defaultBudget;

  const X_URL = /https?:\/\/\S+|www\.\S+/gi;
  const xWeight = (c) => ((c <= 0x10FF || (c >= 0x2000 && c <= 0x200D) || (c >= 0x2010 && c <= 0x201F) || (c >= 0x2032 && c <= 0x2037)) ? 1 : 2);

  function xLength(text) {                 // URLs count 23; CJK, emoji and most non-Latin count 2
    let len = 0, last = 0, m;
    const w = (s) => { for (const ch of s) len += xWeight(ch.codePointAt(0)); };
    const re = new RegExp(X_URL.source, 'gi');
    while ((m = re.exec(text))) { w(text.slice(last, m.index)); len += 23; last = m.index + m[0].length; }
    w(text.slice(last));
    return len;
  }

  // Within [from, to): the first index where the running weighted length passes max, or -1.
  function xOverflowIndex(text, from, to, max) {
    const part = text.slice(from, to);
    let len = 0, last = 0, m;
    const walk = (a, b) => {
      for (let i = a; i < b;) {
        const c = part.codePointAt(i);
        len += xWeight(c);
        if (len > max) return from + i;
        i += c > 0xffff ? 2 : 1;
      }
      return -1;
    };
    const re = new RegExp(X_URL.source, 'gi');
    while ((m = re.exec(part))) {
      const hit = walk(last, m.index);
      if (hit >= 0) return hit;
      len += 23;
      if (len > max) return from + m.index;
      last = m.index + m[0].length;
    }
    return walk(last, part.length);
  }

  // Thread posts: lines that are just --- separate them. Each post runs from its first to its
  // last non-blank line; empty posts don't count. Returns [{ start, end }].
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

  TDW.Formats = { LIST, get, budgetOf, xLength, xOverflowIndex, posts };
})();
