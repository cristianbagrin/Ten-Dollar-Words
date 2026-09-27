// Tests for the Notion block <-> draft line mapping. Run from the project folder:
//   node --test tests/notion-map.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../app/js/notion-map.js');

const ANN = { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' };
const t = (content, ann, url) => ({
  type: 'text', text: { content, link: url ? { url } : null },
  annotations: Object.assign({}, ANN, ann || {}), plain_text: content, href: url || null
});
const mention = (id, title) => ({
  type: 'mention', mention: { type: 'page', page: { id } },
  annotations: Object.assign({}, ANN), plain_text: title, href: 'https://www.notion.so/' + id
});
const block = (id, type, rich, extra) => ({ object: 'block', id, type, has_children: false, [type]: Object.assign({ rich_text: rich || [] }, extra || {}) });
const para = (id, ...rich) => block(id, 'paragraph', rich);
const plainOut = (rich) => rich.map((r) => (r.type === 'text' ? r.text.content : '[' + r.type + ']')).join('');

function fakeApi() {
  const calls = [];
  let n = 0;
  return {
    calls,
    update: async (id, payload) => { calls.push(['update', id, payload.type]); },
    remove: async (id) => { calls.push(['remove', id]); },
    append: async (pageId, children, afterId) => {
      calls.push(['append', afterId, children.map((c) => c.type)]);
      return children.map(() => ({ id: 'new' + (++n) }));
    }
  };
}

const base = () => M.blocksToEntries([
  para('a', t('Hello world')),
  para('b', t('Second para')),
  { object: 'block', id: 'c', type: 'image', has_children: false, image: { type: 'external', external: { url: 'https://x/y.png' } } },
  para('d', t('Third'))
]);

test('blocksToEntries turns blocks into lines', () => {
  const entries = M.blocksToEntries([
    para('a', t('Hello '), t('world', { bold: true })),
    block('b', 'heading_2', [t('Title')]),
    block('c', 'bulleted_list_item', [t('one')]),
    block('d', 'numbered_list_item', [t('first')]),
    block('e', 'numbered_list_item', [t('second')]),
    block('f', 'to_do', [t('task')], { checked: true }),
    { object: 'block', id: 'g', type: 'divider', divider: {} },
    { object: 'block', id: 'h', type: 'image', image: { type: 'external', external: { url: 'https://x/y.png' } } },
    block('i', 'callout', [t('Big idea')]),
    para('j'),
    block('k', 'quote', [t('Line one\nline two')]),
    block('l', 'numbered_list_item', [t('again')])
  ]);
  assert.deepEqual(entries.map((e) => e.line), [
    'Hello **world**', '## Title', '- one', '1. first', '2. second', '[x] task', '---',
    '⟦image⟧', '⟦callout: Big idea⟧', '', '> Line one line two', '1. again'
  ]);
  assert.equal(entries[7].opaque, true);
  assert.equal(entries[0].opaque, false);
  assert.equal(M.entriesToText(entries.slice(0, 2)), 'Hello **world**\n## Title');
});

test('lineToSpec reads line prefixes', () => {
  assert.deepEqual(M.lineToSpec('# A'), { type: 'heading_1', text: 'A' });
  assert.deepEqual(M.lineToSpec('## B'), { type: 'heading_2', text: 'B' });
  assert.deepEqual(M.lineToSpec('### C'), { type: 'heading_3', text: 'C' });
  assert.deepEqual(M.lineToSpec('- x'), { type: 'bulleted_list_item', text: 'x' });
  assert.deepEqual(M.lineToSpec('* y'), { type: 'bulleted_list_item', text: 'y' });
  assert.deepEqual(M.lineToSpec('3. z'), { type: 'numbered_list_item', text: 'z' });
  assert.deepEqual(M.lineToSpec('> q'), { type: 'quote', text: 'q' });
  assert.deepEqual(M.lineToSpec('[ ] t'), { type: 'to_do', text: 't', checked: false });
  assert.deepEqual(M.lineToSpec('[x] t'), { type: 'to_do', text: 't', checked: true });
  assert.deepEqual(M.lineToSpec('---'), { type: 'divider', text: '' });
  assert.deepEqual(M.lineToSpec('#no space'), { type: 'paragraph', text: '#no space' });
  assert.deepEqual(M.lineToSpec(''), { type: 'paragraph', text: '' });
});

test('spliceRich keeps mentions and bold text the user did not touch', () => {
  const old = [t('Read '), mention('p1', 'My post'), t(' today, it is '), t('great', { bold: true }), t('.')];
  const out = M.spliceRich(old, 'Read My post now, it is **great**.');
  assert.equal(out.length, 5);
  assert.equal(out[0].text.content, 'Read ');
  assert.equal(out[1].type, 'mention');
  assert.equal(out[1].mention.page.id, 'p1');
  assert.equal(out[2].text.content, ' now, it is ');
  assert.equal(out[3].text.content, 'great');
  assert.equal(out[3].annotations.bold, true);
  assert.equal(out[4].text.content, '.');
  assert.equal(out[1].plain_text, undefined, 'write format drops read-only fields');
});

test('spliceRich: the markdown decides bold and links; color carries on', () => {
  const bold = M.spliceRich([t('Hello '), t('world', { bold: true })], 'Hello **worlds**');
  assert.deepEqual(bold.map((r) => [r.text.content, !!(r.annotations && r.annotations.bold)]), [['Hello ', false], ['worlds', true]]);
  const unbold = M.spliceRich([t('Hello '), t('world', { bold: true })], 'Hello world');
  assert.deepEqual(unbold.map((r) => r.text.content), ['Hello world']);
  const red = M.spliceRich([t('Warn', { color: 'red' })], 'Warning');
  assert.deepEqual(red.map((r) => [r.text.content, r.annotations.color]), [['Warning', 'red']]);
  const link = M.spliceRich([t('see '), t('this', null, 'https://e.com')], 'see [this](https://e.com) now');
  assert.equal(link.length, 3);
  assert.equal(link[1].text.link.url, 'https://e.com');
  assert.equal(link[2].text.content, ' now');
  assert.equal(link[2].text.link, null);
});

test('spliceRich keeps soft line breaks outside the edit', () => {
  const out = M.spliceRich([t('Line one\nline two')], 'Line one line three');
  assert.equal(out.length, 1);
  assert.equal(out[0].text.content, 'Line one\nline three');
});

test('rich text becomes markdown and back', () => {
  const rich = [t('A '), t('bold', { bold: true }), t(' and '), t('slanted ', { italic: true }), t('link', null, 'https://a.co'),
    t(' '), t('gone', { strikethrough: true }), t(' '), t('x()', { code: true })];
  const md = M.richToMd(rich);
  assert.equal(md, 'A **bold** and *slanted* [link](https://a.co) ~~gone~~ `x()`');
  const back = M.richFromMd(md);
  assert.equal(M.richToMd(back), md);
  const b = back.find((r) => r.text.content === 'bold');
  assert.equal(b.annotations.bold, true);
  assert.equal(back.find((r) => r.text.content === 'link').text.link.url, 'https://a.co');
  assert.equal(back.find((r) => r.text.content === 'A ').annotations, undefined, 'plain text sends no annotations');
});

test('planOps compares meaning, not how the markdown is written', () => {
  const entries = M.blocksToEntries([para('a', t('one '), t('two', { bold: true }), t(' three', { italic: true }))]);
  assert.deepEqual(M.planOps(entries, ['one __two__ _three_'.replace(/__/g, '**')]).map((o) => o.op), ['keep']);
  assert.deepEqual(M.planOps(entries, ['one two _three_']).map((o) => o.op), ['update']);
});

test('long text is split into 2,000-character pieces', () => {
  const out = M.spliceRich([], 'a'.repeat(4500));
  assert.deepEqual(out.map((r) => r.text.content.length), [2000, 2000, 500]);
  assert.deepEqual(M.richFromText(''), []);
});

test('planOps: editing one paragraph updates only that block', () => {
  const ops = M.planOps(base(), ['Hello world', 'Second paragraph', '⟦image⟧', 'Third']);
  assert.deepEqual(ops.map((o) => o.op), ['keep', 'update', 'keep', 'keep']);
});

test('planOps: insert, delete, type change', () => {
  assert.deepEqual(M.planOps(base(), ['Hello world', 'New one', 'Second para', '⟦image⟧', 'Third']).map((o) => o.op),
    ['keep', 'insert', 'keep', 'keep', 'keep']);
  assert.deepEqual(M.planOps(base(), ['Hello world', '⟦image⟧', 'Third']).map((o) => o.op),
    ['keep', 'delete', 'keep', 'keep']);
  assert.deepEqual(M.planOps(base(), ['# Hello world', 'Second para', '⟦image⟧', 'Third']).map((o) => o.op),
    ['replace', 'keep', 'keep', 'keep']);
});

test('planOps protects opaque blocks from accidental edits', () => {
  const touched = M.planOps(base(), ['Hello world', 'Second para', '⟦image⟧x', 'Third']);
  assert.deepEqual(touched.map((o) => o.op), ['keep', 'keep', 'keep', 'keep']);
  assert.equal(touched[2].stale, true);
  const replaced = M.planOps(base(), ['Hello world', 'Second para', 'A caption', 'Third']);
  assert.deepEqual(replaced.map((o) => o.op), ['keep', 'keep', 'replace', 'keep']);
});

test('planOps ignores list renumbering', () => {
  const entries = M.blocksToEntries([block('x', 'numbered_list_item', [t('x')]), block('y', 'numbered_list_item', [t('y')])]);
  assert.deepEqual(M.planOps(entries, ['1. x', '1. y']).map((o) => o.op), ['keep', 'keep']);
});

test('applyOps sends the fewest calls and anchors inserts correctly', async () => {
  const api = fakeApi();
  const lines = ['Hello world', 'New one', 'Also new', 'Second para', '⟦image⟧', 'Third'];
  const entries = base();
  const next = await M.applyOps('page', entries, lines, M.planOps(entries, lines), api);
  assert.deepEqual(api.calls, [['append', 'a', ['paragraph', 'paragraph']]]);
  assert.deepEqual(next.map((e) => e.id), ['a', 'new1', 'new2', 'b', 'c', 'd']);
  assert.deepEqual(next.map((e) => e.line), lines);
});

test('applyOps: insert at the top, update, replace, delete', async () => {
  const api = fakeApi();
  const lines = ['Top', '# Hello world', 'Second para!', 'Third'];
  const entries = base();
  const next = await M.applyOps('page', entries, lines, M.planOps(entries, lines), api);
  assert.deepEqual(api.calls, [
    ['remove', 'a'],
    ['append', null, ['paragraph', 'heading_1']],
    ['update', 'b', 'paragraph'],
    ['remove', 'c']
  ]);
  assert.deepEqual(next.map((e) => e.line), lines);
});

test('applyOps never turns marker lines into text, and batches 100 blocks per call', async () => {
  const api = fakeApi();
  const lines = Array.from({ length: 250 }, (_, i) => 'Line ' + i).concat(['⟦video⟧']);
  const next = await M.applyOps('page', [], lines, M.planOps([], lines), api);
  assert.deepEqual(api.calls.map((c) => [c[0], c[1], c[2].length]), [
    ['append', null, 100], ['append', 'new100', 100], ['append', 'new200', 50]
  ]);
  assert.equal(next.length, 250);
});

test('a stale marker keeps the block untouched', async () => {
  const api = fakeApi();
  const lines = ['Hello world', 'Second para', '⟦image⟧ oops', 'Third'];
  const entries = base();
  const next = await M.applyOps('page', entries, lines, M.planOps(entries, lines), api);
  assert.deepEqual(api.calls, []);
  assert.equal(next[2].line, '⟦image⟧');
});

test('properties convert both ways', () => {
  assert.equal(M.propFromNotion({ type: 'status', status: { name: 'Draft 2' } }), 'Draft 2');
  assert.equal(M.propFromNotion({ type: 'select', select: null }), null);
  assert.equal(M.propFromNotion({ type: 'date', date: { start: '2026-09-26', end: null } }), '2026-09-26');
  assert.equal(M.propFromNotion({ type: 'title', title: [t('Why I never use backspace')] }), 'Why I never use backspace');
  assert.deepEqual(M.propToNotion('status', 'Draft 2'), { status: { name: 'Draft 2' } });
  assert.equal(M.propToNotion('status', null), null);
  assert.deepEqual(M.propToNotion('select', ''), { select: null });
  assert.deepEqual(M.propToNotion('date', '2026-09-26'), { date: { start: '2026-09-26' } });
  assert.deepEqual(M.propToNotion('title', 'Hi'), { title: [{ type: 'text', text: { content: 'Hi', link: null } }] });
  assert.equal(M.propToNotion('formula', 'x'), null);
});

// Simulated Notion page: applies the same calls Notion would and checks every anchor exists.
function simPage(entries) {
  const state = entries.map((e) => Object.assign({}, e));
  let n = 0;
  return {
    state,
    update: async (id, payload) => {
      const i = state.findIndex((b) => b.id === id);
      assert.ok(i >= 0, 'update of missing block ' + id);
      assert.equal(state[i].type, payload.type, 'type cannot change in an update');
      const body = payload[payload.type];
      state[i] = Object.assign({}, state[i], { rich: body.rich_text, checked: !!body.checked });
    },
    remove: async (id) => {
      const i = state.findIndex((b) => b.id === id);
      assert.ok(i >= 0, 'remove of missing block ' + id);
      state.splice(i, 1);
    },
    append: async (pageId, children, afterId) => {
      const at = afterId == null ? 0 : state.findIndex((b) => b.id === afterId) + 1;
      assert.ok(afterId == null || at > 0, 'anchor missing ' + afterId);
      assert.ok(children.length <= 100);
      const created = children.map((c) => ({
        id: 'n' + (++n), type: c.type, rich: c.type === 'divider' ? [] : c[c.type].rich_text,
        checked: c.type === 'to_do' ? !!c.to_do.checked : false, opaque: false
      }));
      state.splice(at, 0, ...created);
      return created;
    }
  };
}
const asBlocks = (state) => state.map((s) => (s.opaque
  ? { id: s.id, type: 'image', image: { type: 'external', external: { url: 'u' } } }
  : s.type === 'divider' ? { id: s.id, type: 'divider', divider: {} }
    : { id: s.id, type: s.type, [s.type]: { rich_text: s.rich, checked: s.checked } }));
const norm = (line) => line.replace(/^\d+[.)] /, 'N. ').replace(/^\* /, '- ');

test('random edit sessions always leave Notion equal to the draft', async () => {
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const words = ['cut', 'the', 'word', 'costs', 'ten', 'dollars', 'draft', 'short', 'clear', 'post'];
  const styled = (w) => pick([w, w, w, w, '**' + w + '**', '*' + w + '*', '~~' + w + '~~', '[' + w + '](https://x.co/' + w + ')']);
  const sentence = () => Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => styled(pick(words))).join(' ');
  const randomLine = () => pick(['', '# ', '## ', '- ', '1. ', '> ', '[ ] ', '[x] ', '', '', '']) + sentence();

  for (let trial = 0; trial < 300; trial++) {
    const blocks = [];
    const count = Math.floor(rnd() * 12);
    for (let k = 0; k < count; k++) {
      if (rnd() < 0.15) blocks.push({ id: 'b' + k, type: 'image', image: { type: 'external', external: { url: 'u' } } });
      else if (rnd() < 0.05) blocks.push({ id: 'b' + k, type: 'divider', divider: {} });
      else {
        const spec = M.lineToSpec(rnd() < 0.2 ? '' : randomLine());
        blocks.push({ id: 'b' + k, type: spec.type, [spec.type]: { rich_text: M.richFromMd(spec.text).map((r) => Object.assign(r, { plain_text: r.text.content })), checked: !!spec.checked } });
      }
    }
    const entries = M.blocksToEntries(blocks);
    const lines = entries.map((e) => e.line);
    const edits = 1 + Math.floor(rnd() * 5);
    for (let e = 0; e < edits; e++) {
      const r = rnd();
      const i = Math.floor(rnd() * (lines.length + 1));
      if (r < 0.3 || !lines.length) lines.splice(i, 0, randomLine());
      else if (r < 0.5) lines.splice(Math.min(i, lines.length - 1), 1);
      else if (r < 0.8) { const k = Math.min(i, lines.length - 1); if (!M.looksOpaque(lines[k])) lines[k] = lines[k] + ' ' + pick(words); }
      else { const k = Math.min(i, lines.length - 1); if (!M.looksOpaque(lines[k])) lines[k] = randomLine(); }
    }
    const page = simPage(entries);
    const next = await M.applyOps('page', entries, lines, M.planOps(entries, lines), page);
    const finalLines = M.blocksToEntries(asBlocks(page.state)).map((x) => norm(x.line));
    assert.deepEqual(finalLines, lines.map(norm), 'trial ' + trial);
    assert.deepEqual(next.map((x) => x.id), page.state.map((x) => x.id), 'cache matches Notion, trial ' + trial);
  }
});

test('sameContent ignores list numbers and markdown spelling, not real changes', () => {
  const entries = M.blocksToEntries([
    block('a', 'numbered_list_item', [t('one')]), block('b', 'numbered_list_item', [t('two')]), para('c', t('bold', { bold: true }))
  ]);
  assert.equal(M.sameContent(entries, ['1. one', '3. two', '__bold__']), true);
  assert.equal(M.sameContent(entries, ['1. one', '2. two', 'bold']), false);
  assert.equal(M.sameContent(entries, ['1. one', '2. two']), false);
});
