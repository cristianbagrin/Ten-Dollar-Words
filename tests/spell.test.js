// Tests for the spellchecker, using the real dictionary. Run from the Claude folder:
//   node --test apps/ten-dollar-words/tests/spell.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Spell = require('../app/js/spell.js');

Spell.init(fs.readFileSync(path.join(__dirname, '../app/dict/en-us.txt'), 'utf8'));

test('known words', () => {
  assert.equal(Spell.known('broken'), true);
  assert.equal(Spell.known('Broken'), true);
  assert.equal(Spell.known('brokken'), false);
  assert.equal(Spell.known("don't"), true);
  assert.equal(Spell.known('don’t'), true);
  assert.equal(Spell.known('linkedin'), true);
});

test('suggestions put the likely fix first and keep the capital', () => {
  const cases = {
    brokken: 'broken', teh: 'the', recieve: 'receive', definately: 'definitely', wierd: 'weird',
    accomodate: 'accommodate', occured: 'occurred', seperate: 'separate', thier: 'their',
    becuase: 'because', Teh: 'The', Recieve: 'Receive'
  };
  for (const [typo, fix] of Object.entries(cases)) {
    assert.equal(Spell.suggest(typo)[0], fix, typo);
  }
  const s = Spell.suggest('brokken');
  assert.ok(s.length >= 1 && s.length <= 3);
  assert.deepEqual(Spell.suggest('xqzvbq'), []);
  assert.equal(Spell.suggest('alot')[0], 'a lot');
  assert.equal(Spell.suggest('infact')[0], 'in fact');
  assert.ok(Spell.suggest('wich').includes('which'));
});

test('personal dictionary', () => {
  assert.equal(Spell.known('bagrin'), false);
  Spell.addWord('Bagrin');
  assert.equal(Spell.known('Bagrin'), true);
  Spell.removeWord('bagrin');
  assert.equal(Spell.known('bagrin'), false);
  Spell.setPersonal(['Ghostwritey']);
  assert.equal(Spell.known('ghostwritey'), true);
  Spell.setPersonal([]);
});

test('never suggests words the dictionary marks as offensive', () => {
  const lines = fs.readFileSync(path.join(__dirname, '../app/dict/en-us.txt'), 'utf8').split('\n');
  const banned = lines.filter((l) => l.startsWith('!')).map((l) => l.slice(1));
  assert.ok(banned.length > 0);
  for (const w of banned.slice(0, 20)) {
    const typo = w.slice(0, -1) + (w.endsWith('z') ? 'y' : 'z');
    assert.ok(!Spell.suggest(typo).map((x) => x.toLowerCase()).includes(w), w);
  }
});

test('suggest is fast enough to run on click', () => {
  const t0 = Date.now();
  for (const w of ['brokken', 'teh', 'recieve', 'definately', 'wierd', 'accomodate', 'occured', 'seperate', 'thier', 'becuase',
    'embarass', 'goverment', 'publically', 'tommorow', 'untill', 'wich', 'beleive', 'freind', 'calender', 'existance']) {
    Spell.suggest(w);
  }
  assert.ok(Date.now() - t0 < 1500, 'took ' + (Date.now() - t0) + 'ms');
});
