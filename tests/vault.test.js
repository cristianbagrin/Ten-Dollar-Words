const test = require('node:test');
const assert = require('node:assert/strict');
const Vault = require('../app/js/vault.js');

test('the same email and password give the same keys; either one changing gives new ones', async () => {
  const a = await Vault.deriveKeys(' Chris@Example.com', 'correct horse');
  const b = await Vault.deriveKeys('chris@example.com ', 'correct horse');
  assert.deepEqual(a, b);
  assert.match(a.auth, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.auth, a.key);
  assert.notEqual((await Vault.deriveKeys('chris@example.com', 'correct horsE')).auth, a.auth);
  assert.notEqual((await Vault.deriveKeys('chris2@example.com', 'correct horse')).key, a.key);
  // Composed and decomposed accents are the same password.
  assert.equal((await Vault.deriveKeys('a@b.co', 'café')).key, (await Vault.deriveKeys('a@b.co', 'café')).key);
});

test('sealed fields open with the right key and account, and only then', async () => {
  const { key } = await Vault.deriveKeys('a@b.co', 'pw one');
  const other = (await Vault.deriveKeys('a@b.co', 'pw two')).key;
  const fields = { 'ai.key': { v: 'AIza-secret', at: 5 }, 'set.skin': { v: 'night', at: 7 } };
  const doc = await Vault.seal(fields, key, 'user1');
  assert.ok(!doc.ct.includes('AIza'));
  assert.deepEqual(await Vault.open(doc, key, 'user1'), fields);
  await assert.rejects(Vault.open(doc, other, 'user1'), { code: 'locked' });
  await assert.rejects(Vault.open(doc, key, 'user2'), { code: 'locked' });
  const bytes = Vault.unb64(doc.ct);
  bytes[3] ^= 1;
  await assert.rejects(Vault.open({ iv: doc.iv, ct: Vault.b64(bytes) }, key, 'user1'), { code: 'locked' });
  assert.notEqual((await Vault.seal(fields, key, 'user1')).iv, doc.iv);
});

test('merging keeps the later change of each field, the same way on both sides', () => {
  const mac = { 'set.skin': { v: 'night', at: 10 }, 'ai.key': { v: 'k1', at: 3 }, 'dict.notion': { v: 'Notion', at: 4 } };
  const phone = { 'set.skin': { v: 'ditto', at: 8 }, 'ai.key': { v: 'k2', at: 9 }, 'dict.notion': { v: null, at: 6 }, 'set.volume': { v: 0.2, at: 1 } };
  const m = Vault.merge(mac, phone);
  assert.deepEqual(m, {
    'set.skin': { v: 'night', at: 10 }, 'ai.key': { v: 'k2', at: 9 }, 'dict.notion': { v: null, at: 6 }, 'set.volume': { v: 0.2, at: 1 }
  });
  assert.deepEqual(Vault.merge(phone, mac), m);
  const tieA = { x: { v: 'a', at: 1 } }, tieB = { x: { v: 'b', at: 1 } };
  assert.deepEqual(Vault.merge(tieA, tieB), Vault.merge(tieB, tieA));
  assert.equal(Vault.differs(m, phone), true);
  assert.equal(Vault.differs(m, Vault.merge(m, phone)), false);
});

test('values compare equal whatever order their keys are in', () => {
  assert.equal(Vault.same({ a: 1, b: { c: [1, 2], d: null } }, { b: { d: null, c: [1, 2] }, a: 1 }), true);
  assert.equal(Vault.same({ a: 1 }, { a: 2 }), false);
  assert.equal(Vault.same(null, undefined), true);
});
