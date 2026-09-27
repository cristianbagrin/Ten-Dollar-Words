/* Spellchecker: a word list (app/dict/en-us.txt, built from SCOWL) plus a personal
   dictionary. Suggestions rank one-edit fixes by how people actually mistype: swapped
   letters, doubled letters and neighboring keys cost less than other edits. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.TDW = root.TDW || {}; root.TDW.Spell = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ALPHABET = "abcdefghijklmnopqrstuvwxyz'";
  let words = new Set();
  let noSuggest = new Set();
  let personal = new Set();
  let ready = false;

  const norm = (w) => String(w).toLowerCase().replace(/’/g, "'");

  // QWERTY positions, with the usual row stagger.
  const KEY_POS = {};
  ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'].forEach((row, y) => {
    for (let x = 0; x < row.length; x++) KEY_POS[row[x]] = [x + y * 0.4, y];
  });
  function adjacent(a, b) {
    const p = KEY_POS[a], q = KEY_POS[b];
    if (!p || !q) return false;
    return Math.abs(p[1] - q[1]) <= 1 && Math.abs(p[0] - q[0]) <= 1.1;
  }

  function init(text) {
    words = new Set();
    noSuggest = new Set();
    for (const line of String(text).split('\n')) {
      if (!line) continue;
      if (line[0] === '!') noSuggest.add(line.slice(1));
      else words.add(line);
    }
    ready = true;
  }

  async function load(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Could not load the dictionary (' + res.status + ')');
    init(await res.text());
  }

  function known(w) {
    const x = norm(w);
    return words.has(x) || noSuggest.has(x) || personal.has(x);
  }

  // Every string one edit away from w, with what that edit costs.
  function edits1(w) {
    const out = new Map();
    const add = (c, cost) => { if (c !== w && (!out.has(c) || out.get(c) > cost)) out.set(c, cost); };
    for (let i = 0; i <= w.length; i++) {
      const L = w.slice(0, i), R = w.slice(i);
      if (R) add(L + R.slice(1), R[0] === R[1] || (i > 0 && w[i - 1] === R[0]) ? 0.7 : 1);
      if (R.length > 1 && R[0] !== R[1]) add(L + R[1] + R[0] + R.slice(2), 0.8);
      for (const ch of ALPHABET) {
        if (R && ch !== R[0]) add(L + ch + R.slice(1), adjacent(R[0], ch) ? 0.9 : 1);
        add(L + ch + R, ch === "'" ? 0.6 : ch === R[0] || ch === L[L.length - 1] ? 0.7 : 0.9); // a dropped letter is the commonest slip
      }
    }
    return out;
  }

  const suggestible = (c) => words.has(c) || personal.has(c);

  // The list has no word frequencies, so everyday words get a nudge when fixes tie.
  const COMMON = new Set(('the be to of and a in that have i it for not on with he as you do at this but his by from ' +
    'they we say her she or an will my one all would there their what so up out if about who get which go me when ' +
    'make can like time no just him know take people into year your good some could them see other than then now ' +
    'look only come its over think also back after use two how our work first well way even new want because any ' +
    'these give day most us is are was were been has had did said very much more many where why should through ' +
    'before being those same while each still too own both between never under might must great little world life ' +
    'write writing word words post posts read email business client clients money week today thing things ' +
    'something nothing everything really always often maybe every around again another without part place point ' +
    'help show tell feel find keep start try call ask need seem turn leave put mean become let begin believe friend ' +
    'receive until tomorrow because different probably definitely separate necessary lot bit fact other anyway').split(' '));

  // "alot" -> "a lot", "infact" -> "in fact". Both halves must be real words, not fragments.
  function splits(w) {
    const out = [];
    const okPart = (p) => COMMON.has(p) || p.length >= 3;
    for (let i = 1; i < w.length; i++) {
      const L = w.slice(0, i), R = w.slice(i);
      if (okPart(L) && okPart(R) && words.has(L) && words.has(R)) out.push([L + ' ' + R, COMMON.has(L) && COMMON.has(R)]);
    }
    return out;
  }

  function matchCase(original, word) {
    if (/^i('|$)/.test(word)) word = 'I' + word.slice(1);
    if (original.length > 1 && original === original.toUpperCase()) return word.toUpperCase();
    if (original[0] && original[0] !== original[0].toLowerCase()) return word[0].toUpperCase() + word.slice(1);
    return word;
  }

  function suggest(word, max) {
    const limit = max || 3;
    const w = norm(word);
    if (!w || w.length > 30) return [];
    const scored = new Map();
    const one = edits1(w);
    for (const [c, cost] of one) if (suggestible(c)) scored.set(c, cost);
    // "alot" -> "a lot" beats everything; a split into rarer words ("wet her") loses to a real one-edit fix.
    if (w.length >= 4) for (const [s, common] of splits(w)) scored.set(s, common ? 0.6 : 1.15);
    if (!scored.size && w.length <= 14) {
      for (const [c1, cost1] of one) {
        for (const [c2, cost2] of edits1(c1)) {
          if (!suggestible(c2)) continue;
          const cost = cost1 + cost2;
          if (!scored.has(c2) || scored.get(c2) > cost) scored.set(c2, cost);
        }
      }
    }
    const swapped = (c) => c[0] === w[1] && c[1] === w[0]; // "hte": the first two letters traded places
    const rank = (c) => scored.get(c) + (c[0] !== w[0] && !swapped(c) ? 0.5 : 0) + 0.05 * Math.abs(c.length - w.length) -
      (COMMON.has(c) ? 0.25 : 0);
    return [...scored.keys()]
      .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, limit)
      .map((c) => matchCase(String(word), c));
  }

  return {
    init, load, known, suggest,
    isReady: () => ready,
    addWord: (w) => { personal.add(norm(w)); },
    removeWord: (w) => { personal.delete(norm(w)); },
    setPersonal: (list) => { personal = new Set((list || []).map(norm)); }
  };
});
