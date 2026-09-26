// Tests for the markdown-lite line parser.
const test = require('node:test');
const assert = require('node:assert/strict');
const Inline = require('../app/js/inline.js');
const E = require('../app/js/engine.js');

// Render flags as a compact string: syntax becomes '', styled text gets tags.
function show(line) {
  const { flags } = Inline.parse(line, Inline.block(line).prefix);
  let out = '', cur = '';
  const tag = (f) => (f & Inline.B ? 'b' : '') + (f & Inline.I ? 'i' : '') + (f & Inline.S ? 's' : '') + (f & Inline.C ? 'c' : '') + (f & Inline.L ? 'l' : '');
  for (let k = Inline.block(line).prefix; k < line.length; k++) {
    if (flags[k] & Inline.MD) continue;
    const t = tag(flags[k]);
    if (t !== cur) { if (cur) out += '</>'; if (t) out += '<' + t + '>'; cur = t; }
    out += line[k];
  }
  return out + (cur ? '</>' : '');
}

test('block markers', () => {
  assert.deepEqual(Inline.block('# Hi'), { type: 'h1', prefix: 2 });
  assert.deepEqual(Inline.block('### Hi'), { type: 'h3', prefix: 4 });
  assert.deepEqual(Inline.block('- a'), { type: 'li', prefix: 2 });
  assert.deepEqual(Inline.block('12. a'), { type: 'ol', prefix: 4 });
  assert.deepEqual(Inline.block('[x] done'), { type: 'todo', prefix: 4, checked: true });
  assert.deepEqual(Inline.block('> q'), { type: 'quote', prefix: 2 });
  assert.equal(Inline.block(' --- ').type, 'hr');
  assert.equal(Inline.block('⟦image⟧').type, 'opaque');
  assert.equal(Inline.block('#tag').type, 'p');
  assert.equal(Inline.block('*not a bullet*').type, 'p');
});

test('bold, italic, strike, code, links', () => {
  assert.equal(show('a **b** c'), 'a <b>b</> c');
  assert.equal(show('a *b* _c_'), 'a <i>b</> <i>c</>');
  assert.equal(show('***both***'), '<bi>both</>');
  assert.equal(show('**bold *and it* bold**'), '<b>bold </><bi>and it</><b> bold</>');
  assert.equal(show('~~gone~~ `x*y*`'), '<s>gone</> <c>x*y*</>');
  assert.equal(show('see [the **site**](https://a.co/x) now'), 'see <l>the </><bl>site</> now');
  assert.equal(show('# A **big** one'), 'A <b>big</> one');
});

test('stray markers stay text', () => {
  assert.equal(show('5 * 3 * 2'), '5 * 3 * 2');
  assert.equal(show('snake_case_name'), 'snake_case_name');
  assert.equal(show('**unclosed'), '**unclosed');
  assert.equal(show('a ** b ** c'), 'a ** b ** c');
  assert.equal(show('~single~'), '~single~');
  assert.equal(show('[not a link] (x)'), '[not a link] (x)');
  assert.equal(show('it`s'), 'it`s');
});

test('plain strips syntax', () => {
  assert.equal(Inline.plain('## The **real** _hook_'), 'The real hook');
  assert.equal(Inline.plain('[site](https://a.co)'), 'site');
  assert.equal(Inline.plain('---'), '');
});

test('engine ignores formatting syntax', () => {
  assert.equal(E.countWords('**Bold** move'), 2);
  assert.equal(E.countWords('[three word label](https://example.com/a-b-c)'), 3);
  const a = E.analyze('It was **done.** Then it ended.');
  assert.equal(a.sentences, 2);
  assert.equal(E.analyze('She **quickly** ran').counts.adverb, 1);
});
