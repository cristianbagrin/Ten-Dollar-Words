// Tests for post formats: what each platform shows, and X's character count.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../app/js/formats.js');

test('formats: Instagram is gone, unknown keys fall back to Basic', () => {
  assert.deepEqual(F.LIST.map((f) => f.key), ['basic', 'linkedin', 'x', 'substack']);
  assert.equal(F.get('instagram').key, 'basic');
});

test('Basic and Substack show the draft as written', () => {
  const r = F.render('# Hi **there**', 'substack');
  assert.equal(r.text, '# Hi **there**');
  assert.equal(r.map[3], 3);
});

test('LinkedIn shows bold and italics as Unicode letters, without markdown', () => {
  const r = F.render('A **bold** and *soft* line\n# Head 1', 'linkedin');
  assert.equal(r.text, 'A 𝗯𝗼𝗹𝗱 and 𝘴𝘰𝘧𝘵 line\n𝗛𝗲𝗮𝗱 𝟭');
  // Every shown character maps back to its draft character.
  const i = r.text.indexOf('and');
  assert.equal(r.map[i], 'A **bold** '.length);
  assert.equal(r.map[r.text.length], 'A **bold** and *soft* line\n# Head 1'.length);
});

test('LinkedIn trims, drops Notion-only blocks, keeps links readable', () => {
  const r = F.render('\n\nHello\n⟦image⟧\nSee [my site](https://a.co)\n\n', 'linkedin');
  assert.equal(r.text, 'Hello\nSee my site (https://a.co)');
  assert.equal(r.map[0], 2);
});

test('X counts like X: emoji 2, URLs 23, CJK 2', () => {
  assert.equal(F.xLength('hello'), 5);
  assert.equal(F.xLength('👍'), 2);
  assert.equal(F.xLength('👨‍👩‍👧‍👦'), 2);
  assert.equal(F.xLength('🇺🇸'), 2);
  assert.equal(F.xLength('中文'), 4);
  assert.equal(F.xLength('see https://example.com/a/very/long/path?x=1'), 4 + 23);
  assert.equal(F.xLength('see example.com.'), 4 + 23 + 1);
  assert.equal(F.xLength('“quotes” — dash'), 15);
});

test('X overflow points at the draft character that passes 280', () => {
  const text = 'a'.repeat(300);
  assert.equal(F.xOverflowIndex(text, 0, text.length, 280), 280);
  const bold = '**' + 'b'.repeat(150) + '**'; // 150 bold letters count 300 on X
  const p = F.xPost(bold, 0, bold.length, 280);
  assert.equal(p.length, 300);
  assert.equal(p.over, 2 + 140);
});

test('threads split on --- lines', () => {
  const t = 'One\n---\n\nTwo\n  ---  \n\n---\nThree';
  assert.deepEqual(F.posts(t).map((p) => t.slice(p.start, p.end)), ['One', 'Two', 'Three']);
});

test('copying from Basic keeps headings, lists, bold and safe links', () => {
  assert.equal(F.toHTML('# Title\nA **b** [x](https://a.co) [y](javascript:void)\n- one\n- two\n\n> q <script>'),
    '<h1>Title</h1><p>A <strong>b</strong> <a href="https://a.co">x</a> y</p><ul><li>one</li><li>two</li></ul><blockquote>q &lt;script&gt;</blockquote>');
});
