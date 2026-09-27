// Expands the Hunspell en_US dictionary (SCOWL, see dict-src/LICENSE) into a flat word list
// for the app's spellchecker. Run from the project folder:
//   node tools/build-dict.mjs
// Output: app/dict/en-us.txt, one lowercase word per line; words Hunspell marks NOSUGGEST
// (slurs and the like) start with "!" so the app accepts them but never suggests them.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const aff = readFileSync(join(here, 'dict-src/index.aff'), 'utf8').split('\n');
const dic = readFileSync(join(here, 'dict-src/index.dic'), 'utf8').split('\n').slice(1);

const rules = {}; // flag -> { kind, cross, list: [{ strip, add, cond }] }
for (const line of aff) {
  const p = line.trim().split(/\s+/);
  if (p[0] !== 'PFX' && p[0] !== 'SFX') continue;
  const [kind, flag] = p;
  if (!rules[flag]) { rules[flag] = { kind, cross: p[2] === 'Y', list: [] }; continue; }
  const strip = p[2] === '0' ? '' : p[2];
  const add = p[3] === '0' ? '' : p[3].split('/')[0];
  const cond = p[4] || '.';
  rules[flag].list.push({
    strip, add,
    test: new RegExp(kind === 'SFX' ? cond + '$' : '^' + cond)
  });
}

function applyRule(word, rule, kind) {
  const out = [];
  for (const r of rule.list) {
    if (!r.test.test(word)) continue;
    if (kind === 'SFX') {
      if (r.strip && !word.endsWith(r.strip)) continue;
      out.push(word.slice(0, word.length - r.strip.length) + r.add);
    } else {
      if (r.strip && !word.startsWith(r.strip)) continue;
      out.push(r.add + word.slice(r.strip.length));
    }
  }
  return out;
}

const words = new Set();
const noSuggest = new Set();
for (const raw of dic) {
  const line = raw.trim();
  if (!line) continue;
  const slash = line.indexOf('/');
  const stem = slash === -1 ? line : line.slice(0, slash);
  const flags = slash === -1 ? '' : line.slice(slash + 1);
  if (flags.includes('c') || /^\d/.test(stem)) continue; // compound-only pieces and ordinals
  const forms = new Set([stem]);
  const sfx = [...flags].filter((f) => rules[f] && rules[f].kind === 'SFX');
  const pfx = [...flags].filter((f) => rules[f] && rules[f].kind === 'PFX');
  const suffixed = [];
  for (const f of sfx) for (const w of applyRule(stem, rules[f], 'SFX')) { forms.add(w); if (rules[f].cross) suffixed.push(w); }
  for (const f of pfx) {
    for (const w of applyRule(stem, rules[f], 'PFX')) forms.add(w);
    if (!rules[f].cross) continue;
    for (const s of suffixed) for (const w of applyRule(s, rules[f], 'PFX')) forms.add(w);
  }
  const target = flags.includes('!') ? noSuggest : words;
  for (const w of forms) target.add(w.toLowerCase().replace(/’/g, "'"));
}
for (const w of readFileSync(join(here, 'dict-src/extra-words.txt'), 'utf8').split('\n')) if (w.trim()) words.add(w.trim().toLowerCase());
for (const w of noSuggest) words.delete(w);

const lines = [...words].sort().concat([...noSuggest].sort().map((w) => '!' + w));
writeFileSync(join(here, '../app/dict/en-us.txt'), lines.join('\n') + '\n');
console.log('words:', words.size, 'nosuggest:', noSuggest.size);
