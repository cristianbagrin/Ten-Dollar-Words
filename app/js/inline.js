/* Markdown-lite for one line of a draft: the block marker at the start (# , - , 1. , > , [ ] )
   and inline **bold**, *italic* or _italic_, ~~strike~~, `code` and [links](url).
   Markers stay in the text; parse() flags which characters are syntax and how the rest is
   styled. UMD: TDW.Inline in the browser, module.exports in Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.TDW = root.TDW || {}; root.TDW.Inline = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MD = 1, B = 2, I = 4, S = 8, C = 16, L = 32;

  const BLOCKS = [
    [/^### /, 'h3'], [/^## /, 'h2'], [/^# /, 'h1'],
    [/^[-*•] /, 'li'], [/^\d+[.)] /, 'ol'], [/^> /, 'quote'], [/^\[[ xX]\] /, 'todo']
  ];
  const SEPARATOR = /^[ \t]*---[ \t]*$/;
  const OPAQUE = /^⟦[^\n]*⟧$/;

  // { type: p|h1|h2|h3|li|ol|quote|todo|hr|opaque, prefix: length of the marker, checked? }
  function block(line) {
    if (SEPARATOR.test(line)) return { type: 'hr', prefix: line.length };
    if (OPAQUE.test(line)) return { type: 'opaque', prefix: line.length };
    for (const [re, type] of BLOCKS) {
      const m = re.exec(line);
      if (m) return type === 'todo' ? { type, prefix: m[0].length, checked: m[0][1] !== ' ' } : { type, prefix: m[0].length };
    }
    return { type: 'p', prefix: 0 };
  }

  const ESCAPABLE = /[!-/:-@[-`{-~]/;
  const isSpace = (c) => c === undefined || /\s/.test(c);
  const isPunct = (c) => c !== undefined && /[\p{P}\p{S}]/u.test(c);

  // flags: one byte per UTF-16 unit of the line. links: [{ start, end, url }] over the label.
  function parse(line, from) {
    const s = String(line);
    const n = s.length;
    const f = new Uint8Array(n);
    const busy = new Uint8Array(n);
    const links = [];
    let i = from || 0;

    // One pass, left to right: a backslash before punctuation makes that character plain text
    // (\* is a star), and code spans hold no syntax at all, backslashes included.
    for (let k = i; k < n; k++) {
      if (s[k] === '\\' && k + 1 < n && ESCAPABLE.test(s[k + 1])) { f[k] = MD; busy[k] = busy[k + 1] = 1; k++; continue; }
      if (s[k] !== '`') continue;
      const j = s.indexOf('`', k + 1);
      if (j < 0) continue;
      if (j > k + 1) {
        f[k] = f[j] = MD;
        busy[k] = busy[j] = 1;
        for (let x = k + 1; x < j; x++) { f[x] = C; busy[x] = 1; }
      }
      k = j;
    }

    // The label may hold escaped brackets and code; the address may hold one level of (parens).
    const LINK = /\[((?:\\.|`[^`\n]*`|[^[\]\n\\])+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g;
    LINK.lastIndex = i;
    let m;
    while ((m = LINK.exec(s))) {
      const a = m.index, labelEnd = a + 1 + m[1].length, b = a + m[0].length;
      let clash = busy[a];
      for (let x = labelEnd; x < b && !clash; x++) clash = busy[x];
      if (clash) { LINK.lastIndex = a + 1; continue; }
      f[a] = MD; busy[a] = 1;
      for (let x = labelEnd; x < b; x++) { f[x] = MD; busy[x] = 1; }
      for (let x = a + 1; x < labelEnd; x++) f[x] |= L;
      links.push({ start: a + 1, end: labelEnd, url: m[2] });
    }

    // Delimiter runs of * _ ~, matched roughly the way CommonMark does it. Literal * and ~ are
    // always escaped when the app writes a line, so for them only spaces decide: "**Hello.**World"
    // stays bold, where CommonMark would show the stars.
    const runs = [];
    while (i < n) {
      const ch = s[i];
      if ((ch !== '*' && ch !== '_' && ch !== '~') || busy[i]) { i++; continue; }
      let j = i;
      while (j < n && s[j] === ch && !busy[j]) j++;
      const prev = s[i - 1], next = s[j];
      let open = !isSpace(next), close = !isSpace(prev);
      if (ch === '_') {
        const left = open && (!isPunct(next) || isSpace(prev) || isPunct(prev));
        const right = close && (!isPunct(prev) || isSpace(next) || isPunct(next));
        open = left && (!right || isPunct(prev));
        close = right && (!left || isPunct(next));
      }
      if (ch !== '~' || j - i >= 2) runs.push({ ch, lo: i, hi: j, open, close });
      i = j;
    }

    const stack = [];
    for (const r of runs) {
      if (r.close) {
        for (let k = stack.length - 1; k >= 0 && r.hi > r.lo; k--) {
          const o = stack[k];
          if (o.ch !== r.ch || o.hi <= o.lo) continue;
          let use;
          if (r.ch === '~') {
            if (o.hi - o.lo < 2 || r.hi - r.lo < 2) continue;
            use = 2;
          } else {
            use = o.hi - o.lo >= 2 && r.hi - r.lo >= 2 ? 2 : 1;
          }
          const oa = o.hi - use, ca = r.lo;
          for (let x = oa; x < o.hi; x++) f[x] = MD;
          for (let x = ca; x < ca + use; x++) f[x] = MD;
          const bit = r.ch === '~' ? S : use === 2 ? B : I;
          for (let x = o.hi; x < ca; x++) f[x] |= bit;
          o.hi -= use;
          r.lo += use;
          stack.length = o.hi > o.lo ? k + 1 : k;
          k = stack.length;
        }
      }
      if (r.open && r.hi > r.lo) stack.push(r);
    }
    return { flags: f, links };
  }

  // The line as a reader sees it: no block marker, no inline syntax.
  function plain(line) {
    const b = block(line);
    if (b.type === 'hr' || b.type === 'opaque') return '';
    const { flags } = parse(line, b.prefix);
    let out = '';
    for (let k = b.prefix; k < line.length; k++) if (!(flags[k] & MD)) out += line[k];
    return out;
  }

  // Characters that would read as syntax get a backslash. snake_case stays as it is.
  function escapeText(t) {
    return t.replace(/[\\*`[\]~]/g, '\\$&').replace(/_/g, (u, k, all) =>
      /[A-Za-z0-9]/.test(all[k - 1] || '') && /[A-Za-z0-9]/.test(all[k + 1] || '') ? u : '\\_');
  }

  // A paragraph whose text starts like a block marker (# , - , 1. , > , [ ] , ---) gets a backslash
  // so it stays a paragraph.
  function escapeLineStart(md) {
    if (/^\d+[.)] /.test(md)) return md.replace(/^(\d+)/, '$1\\'); // 1\. stays a paragraph
    return /^(#{1,3} |[-*+] |> |\[[ xX]\] |[ \t]*---[ \t]*$)/.test(md) ? '\\' + md : md;
  }

  // A link address as the parser can read it back: spaces and unbalanced parentheses get
  // percent-encoded, which leaves the address the same to a browser.
  function linkTarget(url) {
    const u = String(url);
    if (/^(?:[^()\s]|\([^()\s]*\))+$/.test(u)) return u;
    return u.replace(/\s/g, (c) => encodeURIComponent(c)).replace(/\(/g, '%28').replace(/\)/g, '%29');
  }

  // Styled runs → markdown. runs: [{ text, b, i, s, c, link }]. Spaces at a run's edges move
  // outside its markers, since "** bold **" isn't bold.
  function serialize(runs) {
    const same = (x, y) => !!x.b === !!y.b && !!x.i === !!y.i && !!x.s === !!y.s && !!x.c === !!y.c && (x.link || null) === (y.link || null);
    const merged = [];
    for (const r of runs) {
      if (!r || !r.text) continue;
      const last = merged[merged.length - 1];
      if (last && same(last, r)) last.text += r.text;
      else merged.push(Object.assign({}, r));
    }
    let out = '';
    for (const r of merged) {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(r.text);
      let t = r.c ? m[2].replace(/`/g, '\u02cb') : escapeText(m[2]);
      if (!t || (!r.b && !r.i && !r.s && !r.c && !r.link)) { out += r.c ? r.text : escapeText(r.text); continue; }
      if (r.c) t = '`' + t + '`';
      if (r.b && r.i) t = '***' + t + '***';
      else if (r.b) t = '**' + t + '**';
      else if (r.i) t = '*' + t + '*';
      if (r.s) t = '~~' + t + '~~';
      if (r.link) t = '[' + t + '](' + linkTarget(r.link) + ')';
      out += m[1] + t + m[3];
    }
    return out;
  }

  return { MD, B, I, S, C, L, block, parse, plain, serialize, escapeText, escapeLineStart };
});
