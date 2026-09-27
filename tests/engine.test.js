// Acceptance tests for the readability engine. Run from the project folder:
//   node --test tests/engine.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../app/js/engine.js');

const issuesOf = (text, type) =>
  E.analyze(text).issues.filter((i) => i.type === type).map((i) => i.text);
const sentencesOf = (text) =>
  E.splitSentences(text).map((r) => text.slice(r.start, r.end));

test('countWords counts whitespace-separated chunks that contain a letter or digit', () => {
  assert.equal(E.countWords(''), 0);
  assert.equal(E.countWords('   \n  '), 0);
  assert.equal(E.countWords('Hello, world!'), 2);
  assert.equal(E.countWords("well-known don't 42 $10 café"), 5);
  assert.equal(E.countWords('e.g. this — that'), 3);
  assert.equal(E.countWords('one\ntwo\n\nthree'), 3);
  assert.equal(E.countWords('我爱你 ok'), 4); // each CJK character counts as a word
});

test('splitSentences finds sentence ranges', () => {
  assert.deepEqual(sentencesOf('Dr. Smith arrived. He sat down! Did he stay? Yes.'),
    ['Dr. Smith arrived.', 'He sat down!', 'Did he stay?', 'Yes.']);
  assert.deepEqual(sentencesOf('It costs 3.5 dollars. Fine'), ['It costs 3.5 dollars.', 'Fine']);
  assert.deepEqual(sentencesOf('We tried e.g. this one. Next we moved to the U.S. Then it rained.'),
    ['We tried e.g. this one.', 'Next we moved to the U.S.', 'Then it rained.']);
  assert.deepEqual(sentencesOf('First line\nSecond line.\n\n  Third one?  '),
    ['First line', 'Second line.', 'Third one?']);
  assert.deepEqual(sentencesOf('"Stop," she said. "Now!" He left.'),
    ['"Stop," she said.', '"Now!"', 'He left.']);
  assert.deepEqual(sentencesOf('1. Buy milk\n2. Call mom'), ['1. Buy milk', '2. Call mom']);
  assert.deepEqual(sentencesOf('Wait... what happened? Nothing.'), ['Wait... what happened?', 'Nothing.']);
  assert.deepEqual(sentencesOf('Hello world'), ['Hello world']);
  assert.deepEqual(sentencesOf(''), []);
});

test('classifySentence uses the per-sentence ARI thresholds', () => {
  assert.equal(E.classifySentence(13, 120), 'normal'); // under 14 words is never flagged
  assert.equal(E.classifySentence(14, 56), 'normal'); // level 4
  assert.equal(E.classifySentence(20, 92), 'hard'); // level 10
  assert.equal(E.classifySentence(30, 150), 'veryHard'); // level 17
});

test('gradeLabel', () => {
  assert.equal(E.gradeLabel(0), 'Good');
  assert.equal(E.gradeLabel(9), 'Good');
  assert.equal(E.gradeLabel(10), 'OK');
  assert.equal(E.gradeLabel(12), 'OK');
  assert.equal(E.gradeLabel(13), 'Hard');
  assert.equal(E.gradeLabel(20), 'Hard');
});

test('analyze on empty text', () => {
  const a = E.analyze('');
  assert.equal(a.words, 0);
  assert.equal(a.sentences, 0);
  assert.equal(a.paragraphs, 0);
  assert.equal(a.grade, 0);
  assert.deepEqual(a.issues, []);
  assert.deepEqual(a.sentenceList, []);
});

test('overall grade is the Automated Readability Index, rounded, never below 0', () => {
  const easy = E.analyze('The cat sat. The dog ran.');
  assert.equal(easy.words, 6);
  assert.equal(easy.sentences, 2);
  assert.equal(easy.paragraphs, 1);
  assert.equal(easy.grade, 0);
  // 61 letters, 5 words, 1 sentence: 4.71 * 12.2 + 0.5 * 5 - 21.43 = 38.53
  assert.equal(E.analyze('Organizations increasingly prioritize comprehensive documentation.').grade, 39);
});

test('hard and very hard sentences', () => {
  const long = 'Notwithstanding the considerable organizational complexities inherent in implementing comprehensive international regulatory frameworks, multinational corporations increasingly recognize that transparent communication strategies substantially enhance stakeholder confidence and long-term institutional legitimacy across diverse jurisdictions worldwide.';
  const a = E.analyze(long);
  assert.equal(a.sentenceList.length, 1);
  assert.equal(a.sentenceList[0].kind, 'veryHard');
  assert.equal(a.counts.veryHard, 1);
  assert.deepEqual(issuesOf(long, 'veryHard'), [long]);
  assert.equal(E.analyze('Short and sweet.').sentenceList[0].kind, 'normal');
  const medium = 'Most people write long sentences because they are afraid that short ones will make them look simple to readers.';
  assert.equal(E.analyze(medium).sentenceList[0].kind, 'hard'); // 19 words, 92 letters: level 11
});

test('adverbs', () => {
  assert.deepEqual(issuesOf('He ran quickly.', 'adverb'), ['quickly']);
  assert.deepEqual(issuesOf('She is only a family friend, and early too.', 'adverb'), []);
  assert.deepEqual(issuesOf('Fly away.', 'adverb'), []);
  assert.deepEqual(issuesOf('SLOWLY, he turned.', 'adverb'), ['SLOWLY']);
});

test('passive voice', () => {
  assert.deepEqual(issuesOf('The report was written by the team.', 'passive'), ['was written']);
  assert.deepEqual(issuesOf('The cake was baked yesterday.', 'passive'), ['was baked']);
  assert.deepEqual(issuesOf('The house is being built.', 'passive'), ['is being built']);
  assert.deepEqual(issuesOf('He has been fired.', 'passive'), ['been fired']);
  assert.deepEqual(issuesOf("The mistakes weren't noticed.", 'passive'), ["weren't noticed"]);
  assert.deepEqual(issuesOf('The mistakes weren’t noticed.', 'passive'), ['weren’t noticed']);
  assert.deepEqual(issuesOf('I am tired of this.', 'passive'), []);
  assert.deepEqual(issuesOf('We are supposed to go.', 'passive'), []);
  assert.deepEqual(issuesOf('This is indeed true.', 'passive'), []);
});

test('complex words and phrases', () => {
  const a = E.analyze('We need to utilize the tools in order to win.');
  const c = a.issues.filter((i) => i.type === 'complex');
  assert.deepEqual(c.map((i) => i.text), ['utilize', 'in order to']);
  assert.equal(c[0].suggestion, 'use');
  assert.equal(c[1].suggestion, 'to');
  assert.deepEqual(issuesOf('In order to win, train.', 'complex'), ['In order to']);
  assert.deepEqual(issuesOf('He utilized it.', 'complex'), ['utilized']);
  assert.deepEqual(issuesOf('The order to win came.', 'complex'), []);
  assert.deepEqual(issuesOf('This is a game-changer for us.', 'complex'), ['game-changer']);
  assert.deepEqual(issuesOf('In today’s world, we win.', 'complex'), ['In today’s world']);
  const cut = E.analyze('It is important to note that we won.').issues.filter((i) => i.type === 'complex');
  assert.deepEqual(cut.map((i) => i.text), ['It is important to note that']);
  assert.equal(cut[0].suggestion, ''); // empty suggestion means "cut it"
});

test('qualifiers', () => {
  assert.deepEqual(issuesOf('I think this works.', 'qualifier'), ['I think']);
  assert.deepEqual(issuesOf('It was very good and just fine.', 'qualifier'), ['very good', 'just']);
  assert.deepEqual(issuesOf('I don’t think so.', 'qualifier'), ['I don’t think']);
  assert.deepEqual(issuesOf('Justice matters.', 'qualifier'), []);
  const q = E.analyze('I think so.').issues.find((i) => i.type === 'qualifier');
  assert.equal(q.suggestion, '');
});

test('overlaps resolve by priority: spelling > intensifier > complex > passive > qualifier > adverb', () => {
  assert.deepEqual(issuesOf('It is really good.', 'qualifier'), ['really good']);
  assert.deepEqual(issuesOf('It is really good.', 'adverb'), []);
  assert.deepEqual(issuesOf('Frequently, we win.', 'complex'), ['Frequently']);
  assert.deepEqual(issuesOf('Frequently, we win.', 'adverb'), []);
  assert.deepEqual(issuesOf('The ball was quickly thrown.', 'passive'), ['was quickly thrown']);
  assert.deepEqual(issuesOf('The ball was quickly thrown.', 'adverb'), []);
  assert.deepEqual(issuesOf('The app was just released.', 'passive'), ['was just released']);
  assert.deepEqual(issuesOf('The app was just released.', 'qualifier'), []);
  assert.deepEqual(issuesOf('It is very unique.', 'complex'), ['very unique']);
  assert.deepEqual(issuesOf('It is very unique.', 'qualifier'), []);
});

test('every issue range matches its text, and word-level issues never overlap', () => {
  const t = 'The report was written by the team in order to utilize data. I think it is really, very good.\nHe ran quickly!';
  const a = E.analyze(t);
  assert.ok(a.issues.length >= 6);
  for (const i of a.issues) assert.equal(t.slice(i.start, i.end), i.text);
  const w = a.issues.filter((i) => i.type !== 'hard' && i.type !== 'veryHard');
  for (let k = 1; k < w.length; k++) assert.ok(w[k].start >= w[k - 1].end, 'overlap at ' + w[k].text);
});

test('issues are sorted by start and ids are unique', () => {
  const a = E.analyze('I think the report was written quickly in order to impress.');
  const ids = a.issues.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  for (let k = 1; k < a.issues.length; k++) assert.ok(a.issues[k].start >= a.issues[k - 1].start);
});

test('counts, targets and reading time', () => {
  const a = E.analyze('He ran quickly. She spoke softly. The cake was eaten.\nThey left.');
  assert.equal(a.words, 12);
  assert.equal(a.sentences, 4);
  assert.equal(a.paragraphs, 2);
  assert.equal(a.counts.adverb, 2);
  assert.equal(a.counts.passive, 1);
  assert.equal(a.targets.adverb, 0); // Math.round(words / 100)
  assert.equal(a.targets.passive, 1); // Math.round(sentences / 5)
  assert.equal(a.readingTimeSec, 3); // Math.round(words / 238 * 60)
});

test('paragraphs are non-empty lines', () => {
  const a = E.analyze('One.\n\nTwo.\nThree.');
  assert.equal(a.paragraphs, 3);
  assert.equal(a.sentences, 3);
});

test('fast on long text', () => {
  const para = 'The report was written by the team in order to utilize every possible word, and it really shows. ';
  const text = (para.repeat(8) + '\n').repeat(40); // about 5,700 words
  const t0 = Date.now();
  E.analyze(text);
  const ms = Date.now() - t0;
  assert.ok(ms < 400, 'analyze took ' + ms + 'ms');
});

test('intensifier + adjective suggests one strong word', () => {
  const text = 'I am very tired.';
  const q = E.analyze(text).issues.find((i) => i.type === 'qualifier');
  assert.equal(q.text, 'very tired');
  assert.equal(q.suggestion, 'exhausted, drained, weary');
  assert.equal(text.slice(q.cut.start, q.cut.end), 'very');
  assert.deepEqual(issuesOf('We were so happy.', 'qualifier'), ['so happy']);
  assert.deepEqual(issuesOf('It was really something.', 'qualifier'), ['really']);
  assert.deepEqual(issuesOf('Very, good.', 'qualifier'), ['Very']);
  assert.deepEqual(issuesOf('He ran very quickly.', 'qualifier'), ['very']);
  assert.deepEqual(issuesOf('He ran very quickly.', 'adverb'), ['quickly']);
  assert.deepEqual(issuesOf('He was very tired.', 'passive'), []);
});

test('spelling: flags unknown words through the isKnown hook, skipping names, acronyms and links', () => {
  const known = new Set(['this', 'is', 'we', 'met', 'at', 'and', 'the', 'end', 'team', 'plan', 'i', "don't", 'know', 'teams']);
  const isKnown = (w) => known.has(w);
  const t = 'This is brokken. We met Jonathan at LinkedIn and NASA. Teh end @handle #tag https://example.com/foo';
  const a = E.analyze(t, { isKnown });
  assert.deepEqual(a.issues.filter((i) => i.type === 'spelling').map((i) => i.text), ['brokken', 'Teh']);
  assert.equal(a.counts.spelling, 2);
  assert.deepEqual(E.analyze("The team's plan. I don’t know the teams' plan.", { isKnown }).issues.filter((i) => i.type === 'spelling'), []);
  assert.deepEqual(E.analyze('This is brokken.').issues.filter((i) => i.type === 'spelling'), [], 'no hook, no spelling');
});

test('countWords and analyze skip list markers and ⟦Notion block⟧ lines', () => {
  assert.equal(E.countWords('- item one\n1. item two\n# Heading\n[ ] task\n> quoted'), 7);
  assert.equal(E.countWords('Hello there\n⟦image⟧\n⟦callout: Big idea⟧'), 2);
  const a = E.analyze('Hello there.\n⟦image⟧');
  assert.equal(a.words, 2);
  assert.equal(a.sentences, 1);
  assert.equal(a.paragraphs, 1);
  assert.deepEqual(E.analyze('- He ran quickly.').issues.map((i) => i.text), ['quickly']);
});

test('thread separators are not text', () => {
  assert.equal(E.countWords('a\n---\nb'), 2);
  const a = E.analyze('One.\n---\nTwo.');
  assert.equal(a.sentences, 2);
  assert.equal(a.paragraphs, 2);
  assert.equal(a.words, 2);
});

test('countWords on long text matches a full analysis', () => {
  const text = Array.from({ length: 300 }, (_, i) => (i % 7 === 0 ? '# Head ' : i % 5 === 0 ? '- item **bold** ' : '') + 'word '.repeat(i % 13) + (i % 11 === 0 ? '⟦image⟧' : '中文 [a b](https://x.y)')).join('\n');
  assert.equal(E.countWords(text), E.analyze(text).words);
  assert.equal(E.countWords(text + '\nmore words'), E.analyze(text + '\nmore words').words);
});
