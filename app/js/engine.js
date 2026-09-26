/* Readability engine. UMD: TDW.Engine in the browser, module.exports in Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./data.js'));
  else { root.TDW = root.TDW || {}; root.TDW.Engine = factory(root.TDW.Data); }
})(typeof self !== 'undefined' ? self : this, function (D) {
  'use strict';

  const CJK_G = /[\u3400-\u9fff\uf900-\ufaff]/g;
  const HAS_WORDCHAR = /[A-Za-z0-9\u00c0-\u024f]/;
  const LETTERS_G = /[A-Za-z0-9\u00c0-\u024f]/g;
  const WORD_RE = /[A-Za-z\u00c0-\u024f]+(?:['\u2019][A-Za-z\u00c0-\u024f]+)*/g;
  const TERM = /[.!?\u2026]+["'\u201d\u2019)\]]*(?=\s|$)/g;
  const TOKEN_CHAR = /[A-Za-z0-9.]/;
  // Notion blocks shown as \u27e6image\u27e7, and list / heading / quote / to-do markers. Masking swaps
  // them for spaces of the same length, so every offset stays valid.
  const OPAQUE_RE = /^\u27e6[^\n]*\u27e7[ \t]*$/gm;
  const SEPARATOR_RE = /^[ \t]*---[ \t]*$/gm; // thread separators (Notion dividers)
  const MARKER_RE = /^[ \t]*(?:[-*\u2022]|\d+[.)]|#{1,3}|>|\[[ xX]\])(?=[ \t])/gm;
  const blank = (m) => ' '.repeat(m.length);
  const mask = (t) => t.replace(OPAQUE_RE, blank).replace(SEPARATOR_RE, blank).replace(MARKER_RE, blank);
  const GAP_RE = /^[ \t\u00a0]+$/;
  const LINKISH = /:\/\/|www\.|@|#/;

  const normApos = (s) => s.replace(/\u2019/g, "'");
  const norm = (s) => normApos(s.toLowerCase()).replace(/\s+/g, ' ').trim();

  const ABBR = new Set(D.ABBREVIATIONS);
  const ADVERB_EXCEPTIONS = new Set(D.ADVERB_EXCEPTIONS);
  const BE_FORMS = new Set(D.BE_FORMS);
  const PASSIVE_SKIP = new Set(D.PASSIVE_SKIP);
  const IRREGULAR = new Set(D.IRREGULAR_PARTICIPLES);
  const ED_NOT = new Set(D.ED_NOT_PARTICIPLE);
  const ADJECTIVAL = new Set(D.ADJECTIVAL_PARTICIPLES);
  const INTENSIFIERS = new Set(D.INTENSIFIERS);
  const STRONGER = new Map(Object.entries(D.STRONGER));
  const PRIORITY = { spelling: 6, complex: 4, passive: 3, qualifier: 2, adverb: 1 };
  const PAIR_PRIORITY = 5;

  function phrasePattern(phrase) {
    return phrase.split(' ')
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['\u2019]"))
      .join('[ \\t\\u00a0]+');
  }

  // entries: [[variants joined by |, suggestion], ...] -> one case-insensitive regex, longest first
  function buildMatcher(entries) {
    const map = new Map();
    for (const [variants, suggestion] of entries) {
      for (const v of variants.split('|')) {
        const key = norm(v);
        if (key && !map.has(key)) map.set(key, suggestion);
      }
    }
    const keys = [...map.keys()].sort((a, b) => b.length - a.length);
    return { map, re: new RegExp('\\b(?:' + keys.map(phrasePattern).join('|') + ')\\b', 'gi') };
  }

  const COMPLEX = buildMatcher(D.COMPLEX);
  const QUALIFIER = buildMatcher(D.QUALIFIERS.map((q) => [q, '']));

  // Counts words in text that is already masked.
  function countRaw(text) {
    let n = 0;
    for (const chunk of text.split(/\s+/)) {
      if (!chunk) continue;
      const cjk = chunk.match(CJK_G);
      if (cjk) n += cjk.length;
      if (HAS_WORDCHAR.test(cjk ? chunk.replace(CJK_G, '') : chunk)) n++;
    }
    return n;
  }

  const countWords = (text) => countRaw(mask(String(text || '')));

  function isBoundary(line, m) {
    const end = m.index + m[0].length;
    const nm = /\S/.exec(line.slice(end));
    const next = nm ? nm[0] : '';
    if (next >= 'a' && next <= 'z') return false;
    if (m[0][0] === '.') {
      let k = m.index;
      while (k > 0 && TOKEN_CHAR.test(line[k - 1])) k--;
      const tok = line.slice(k, m.index);
      if (tok) {
        if (ABBR.has(tok.toLowerCase())) return false;
        if (/^[A-Z]$/.test(tok)) return false;
        if (/^[0-9]+$/.test(tok) && !/\S/.test(line.slice(0, k))) return false;
      }
    }
    return true;
  }

  function splitSentences(text) {
    text = String(text || '');
    const out = [];
    const push = (a, b) => {
      while (a < b && /\s/.test(text[a])) a++;
      while (b > a && /\s/.test(text[b - 1])) b--;
      if (b > a) out.push({ start: a, end: b });
    };
    let ls = 0;
    while (ls <= text.length) {
      let le = text.indexOf('\n', ls);
      if (le === -1) le = text.length;
      const line = text.slice(ls, le);
      let cur = 0;
      let m;
      TERM.lastIndex = 0;
      while ((m = TERM.exec(line))) {
        if (isBoundary(line, m)) {
          push(ls + cur, ls + m.index + m[0].length);
          cur = m.index + m[0].length;
        }
      }
      push(ls + cur, le);
      ls = le + 1;
    }
    return out;
  }

  const levelOf = (words, letters) => (words ? Math.round(4.71 * letters / words + 0.5 * words - 21.43) : 0);

  function classifySentence(words, letters) {
    if (words < 14) return 'normal';
    const level = levelOf(words, letters);
    if (level >= 14) return 'veryHard';
    if (level >= 10) return 'hard';
    return 'normal';
  }

  function gradeLabel(g) {
    if (g <= 9) return 'Good';
    if (g <= 12) return 'OK';
    return 'Hard';
  }

  function tokenize(str, offset) {
    const out = [];
    let m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(str))) {
      out.push({ start: offset + m.index, end: offset + m.index + m[0].length, lower: m[0].toLowerCase() });
    }
    return out;
  }

  function isParticiple(p) {
    if (ADJECTIVAL.has(p)) return false;
    if (IRREGULAR.has(p)) return true;
    return p.length >= 4 && p.endsWith('ed') && !ED_NOT.has(p);
  }

  const isSkippable = (w) => PASSIVE_SKIP.has(w) || (w.length >= 4 && w.endsWith('ly'));

  function collect(matcher, text, type, out) {
    let m;
    matcher.re.lastIndex = 0;
    while ((m = matcher.re.exec(text))) {
      const s = matcher.map.get(norm(m[0]));
      out.push({ type, pri: PRIORITY[type], start: m.index, end: m.index + m[0].length, suggestion: s === undefined ? '' : s });
    }
  }

  // Spelling candidates. firstOfSentence: token starts that open a sentence (capitals allowed there).
  function spelling(masked, toks, firstOfSentence, isKnown, out) {
    const chunks = [];
    let m;
    const CHUNK = /\S+/g;
    while ((m = CHUNK.exec(masked))) chunks.push({ start: m.index, end: m.index + m[0].length, linkish: LINKISH.test(m[0]) });
    let c = 0;
    for (const t of toks) {
      while (c < chunks.length && chunks[c].end <= t.start) c++;
      if (c < chunks.length && chunks[c].linkish) continue;
      const word = masked.slice(t.start, t.end);
      if (word.length === 1 || /[A-Z]/.test(word.slice(1))) continue;
      if (word[0] !== word[0].toLowerCase() && !firstOfSentence.has(t.start)) continue;
      const w = normApos(t.lower);
      if (isKnown(w) || (w.endsWith("'s") && isKnown(w.slice(0, -2))) || (w.endsWith("'") && isKnown(w.slice(0, -1)))) continue;
      out.push({ type: 'spelling', pri: PRIORITY.spelling, start: t.start, end: t.end });
    }
  }

  function analyze(text, opts) {
    text = String(text || '');
    const masked = mask(text);
    const isKnown = opts && typeof opts.isKnown === 'function' ? opts.isKnown : null;
    const sentenceList = [];
    const sentIssues = [];
    const cands = [];
    const firstOfSentence = new Set();
    let letters = 0;

    for (const r of splitSentences(masked)) {
      const slice = masked.slice(r.start, r.end);
      const w = countRaw(slice);
      const l = (slice.match(LETTERS_G) || []).length;
      const kind = classifySentence(w, l);
      letters += l;
      sentenceList.push({ start: r.start, end: r.end, words: w, letters: l, level: levelOf(w, l), kind });
      if (kind !== 'normal') sentIssues.push({ type: kind, start: r.start, end: r.end });

      const toks = tokenize(slice, r.start);
      if (toks.length) firstOfSentence.add(toks[0].start);
      for (let i = 0; i < toks.length; i++) {
        if (!BE_FORMS.has(normApos(toks[i].lower))) continue;
        let j = i + 1;
        while (j < toks.length && j < i + 3 && isSkippable(toks[j].lower)) j++;
        if (j < toks.length && isParticiple(toks[j].lower)) {
          cands.push({ type: 'passive', pri: PRIORITY.passive, start: toks[i].start, end: toks[j].end });
          i = j;
        }
      }
    }

    collect(COMPLEX, masked, 'complex', cands);
    collect(QUALIFIER, masked, 'qualifier', cands);
    const toks = tokenize(masked, 0);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.lower.length >= 4 && t.lower.endsWith('ly') && !ADVERB_EXCEPTIONS.has(t.lower)) {
        cands.push({ type: 'adverb', pri: PRIORITY.adverb, start: t.start, end: t.end });
      }
      const next = toks[i + 1];
      if (next && INTENSIFIERS.has(t.lower) && STRONGER.has(next.lower) && GAP_RE.test(masked.slice(t.end, next.start))) {
        cands.push({
          type: 'qualifier', pri: PAIR_PRIORITY, start: t.start, end: next.end,
          suggestion: STRONGER.get(next.lower), cut: { start: t.start, end: t.end }
        });
      }
    }
    if (isKnown) spelling(masked, toks, firstOfSentence, isKnown, cands);

    cands.sort((a, b) => b.pri - a.pri || a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const claimed = new Uint8Array(text.length);
    const kept = [];
    for (const c of cands) {
      let free = true;
      for (let k = c.start; k < c.end; k++) if (claimed[k]) { free = false; break; }
      if (!free) continue;
      claimed.fill(1, c.start, c.end);
      kept.push(c);
    }

    const issues = sentIssues.concat(kept).map((c) => {
      const issue = { id: c.type + ':' + c.start + ':' + c.end, type: c.type, start: c.start, end: c.end, text: text.slice(c.start, c.end) };
      if (c.suggestion !== undefined) issue.suggestion = c.suggestion;
      if (c.cut) issue.cut = c.cut;
      return issue;
    }).sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

    const counts = { spelling: 0, hard: 0, veryHard: 0, adverb: 0, passive: 0, complex: 0, qualifier: 0 };
    for (const i of issues) counts[i.type]++;

    const words = countRaw(masked);
    const sentences = sentenceList.length;
    const paragraphs = masked.split('\n').filter((line) => /\S/.test(line)).length;
    const grade = !sentences || !words ? 0
      : Math.max(0, Math.round(4.71 * letters / words + 0.5 * words / sentences - 21.43));

    return {
      words, letters, sentences, paragraphs, grade,
      readingTimeSec: Math.round(words / 238 * 60),
      sentenceList, issues, counts,
      targets: { adverb: Math.round(words / 100), passive: Math.round(sentences / 5) }
    };
  }

  return { countWords, splitSentences, classifySentence, gradeLabel, analyze };
});
