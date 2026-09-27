import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHandler, memoryKV, blobsKV } from '../netlify/lib/account-api.mjs';

const auth = () => crypto.randomBytes(32).toString('base64url');
const IV = crypto.randomBytes(12).toString('base64');
const CT = crypto.randomBytes(48).toString('base64');

function setup(kv) {
  kv = kv || memoryKV();
  const clock = { t: Date.UTC(2026, 8, 1) };
  const handle = createHandler({ kv, now: () => clock.t });
  async function call(action, body, cookie, headers) {
    const req = new Request('https://x.test/api/account/' + action, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'X-TDW': '1', 'Sec-Fetch-Site': 'same-origin' }, cookie ? { Cookie: cookie } : {}, headers || {}),
      body: body === undefined ? '{}' : JSON.stringify(body)
    });
    const res = await handle(req, action);
    const set = res.headers.get('set-cookie') || '';
    return { status: res.status, body: await res.json(), cookie: set.split(';')[0], setCookie: set };
  }
  return { kv, clock, call };
}

test('sign up, sign in, pull and push the encrypted document', async () => {
  const { call } = setup();
  const a = auth();
  const up = await call('signup', { email: ' Chris@Example.com ', auth: a });
  assert.equal(up.status, 200);
  assert.equal(up.body.email, 'chris@example.com');
  assert.match(up.setCookie, /HttpOnly/);
  assert.match(up.setCookie, /SameSite=Strict/);
  assert.match(up.setCookie, /Secure/);

  const empty = await call('pull', {}, up.cookie);
  assert.deepEqual([empty.status, empty.body.rev, empty.body.ct], [200, 0, undefined]);

  const pushed = await call('push', { base: 0, iv: IV, ct: CT }, up.cookie);
  assert.deepEqual([pushed.status, pushed.body.rev], [200, 1]);

  const other = await call('login', { email: 'chris@example.com', auth: a });
  assert.equal(other.status, 200);
  assert.equal(other.body.rev, 1);
  assert.equal(other.body.ct, CT);
  assert.notEqual(other.cookie, up.cookie);
  const pulled = await call('pull', {}, other.cookie);
  assert.deepEqual([pulled.body.rev, pulled.body.iv, pulled.body.ct], [1, IV, CT]);
});

test('a push from an older revision gets the current document back', async () => {
  const { call } = setup();
  const up = await call('signup', { email: 'a@b.co', auth: auth() });
  await call('push', { base: 0, iv: IV, ct: CT }, up.cookie);
  const stale = await call('push', { base: 0, iv: IV, ct: 'AAAA' }, up.cookie);
  assert.equal(stale.status, 409);
  assert.deepEqual([stale.body.error, stale.body.rev, stale.body.ct], ['conflict', 1, CT]);
  const ok = await call('push', { base: 1, iv: IV, ct: 'AAAA' }, up.cookie);
  assert.equal(ok.body.rev, 2);
});

test('one account per email', async () => {
  const { call } = setup();
  assert.equal((await call('signup', { email: 'a@b.co', auth: auth() })).status, 200);
  const again = await call('signup', { email: 'A@B.CO', auth: auth() });
  assert.deepEqual([again.status, again.body.error], [409, 'exists']);
  assert.equal((await call('signup', { email: 'not-an-email', auth: auth() })).body.error, 'bad_email');
});

test('wrong passwords are refused, and too many lock the account for 15 minutes', async () => {
  const { call, clock } = setup();
  const a = auth();
  await call('signup', { email: 'a@b.co', auth: a });
  const wrong = await call('login', { email: 'a@b.co', auth: auth() });
  assert.deepEqual([wrong.status, wrong.body.error], [401, 'wrong']);
  const nobody = await call('login', { email: 'nobody@b.co', auth: auth() });
  assert.deepEqual([nobody.status, nobody.body.error], [401, 'wrong']); // same answer: no way to tell who has an account
  for (let k = 0; k < 7; k++) await call('login', { email: 'a@b.co', auth: auth() });
  const locked = await call('login', { email: 'a@b.co', auth: a });
  assert.deepEqual([locked.status, locked.body.error], [429, 'locked']);
  clock.t += 15 * 60e3 + 1;
  assert.equal((await call('login', { email: 'a@b.co', auth: a })).status, 200);
});

test('calls need the header, POST, a session, and a same-origin page', async () => {
  const { call } = setup();
  const up = await call('signup', { email: 'a@b.co', auth: auth() });
  assert.equal((await call('pull', {}, up.cookie, { 'X-TDW': '' })).status, 403);
  assert.equal((await call('pull', {}, up.cookie, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await call('pull', {})).status, 401);
  assert.equal((await call('pull', {}, 'tdw_session=' + '0'.repeat(32) + '.' + 'x'.repeat(43))).status, 401);
  assert.equal((await call('nope', {}, up.cookie)).status, 404);
  assert.equal((await call('constructor', {}, up.cookie)).status, 404);
  assert.equal((await call('push', { base: 0, iv: 'short', ct: CT }, up.cookie)).status, 400);
});

test('signing out ends that session only', async () => {
  const { call } = setup();
  const a = auth();
  const one = await call('signup', { email: 'a@b.co', auth: a });
  const two = await call('login', { email: 'a@b.co', auth: a });
  const out = await call('logout', {}, one.cookie);
  assert.match(out.setCookie, /Max-Age=0/);
  assert.equal((await call('pull', {}, one.cookie)).status, 401);
  assert.equal((await call('pull', {}, two.cookie)).status, 200);
});

test('sessions last a year from the last visit', async () => {
  const { call, clock } = setup();
  const up = await call('signup', { email: 'a@b.co', auth: auth() });
  clock.t += 300 * 86400e3;
  const seen = await call('pull', {}, up.cookie);
  assert.equal(seen.status, 200);
  assert.match(seen.setCookie, /Max-Age=31536000/); // moved forward
  clock.t += 300 * 86400e3;
  assert.equal((await call('pull', {}, up.cookie)).status, 200);
  clock.t += 366 * 86400e3;
  assert.equal((await call('pull', {}, up.cookie)).status, 401);
});

test('changing the password re-encrypts the document and signs other devices out', async () => {
  const { call } = setup();
  const a = auth(), b = auth();
  const one = await call('signup', { email: 'a@b.co', auth: a });
  const two = await call('login', { email: 'a@b.co', auth: a });
  await call('push', { base: 0, iv: IV, ct: CT }, one.cookie);
  const wrong = await call('password', { auth: b, newAuth: b, base: 1, iv: IV, ct: 'BBBB' }, one.cookie);
  assert.equal(wrong.status, 401);
  const stale = await call('password', { auth: a, newAuth: b, base: 0, iv: IV, ct: 'BBBB' }, one.cookie);
  assert.equal(stale.status, 409);
  const ok = await call('password', { auth: a, newAuth: b, base: 1, iv: IV, ct: 'BBBB' }, one.cookie);
  assert.deepEqual([ok.status, ok.body.rev], [200, 2]);
  assert.equal((await call('pull', {}, one.cookie)).body.ct, 'BBBB');
  assert.equal((await call('pull', {}, two.cookie)).status, 401);
  assert.equal((await call('login', { email: 'a@b.co', auth: a })).status, 401);
  assert.equal((await call('login', { email: 'a@b.co', auth: b })).status, 200);
});

test('deleting the account removes everything and frees the email', async () => {
  const { call, kv } = setup();
  const a = auth();
  const one = await call('signup', { email: 'a@b.co', auth: a });
  await call('login', { email: 'a@b.co', auth: a });
  await call('push', { base: 0, iv: IV, ct: CT }, one.cookie);
  assert.equal((await call('delete', { auth: auth() }, one.cookie)).status, 401);
  assert.equal((await call('delete', { auth: a }, one.cookie)).status, 200);
  assert.equal(kv.dump().size, 0);
  assert.equal((await call('signup', { email: 'a@b.co', auth: auth() })).status, 200);
});

test('an email left claimed by a signup that never finished can sign up again', async () => {
  const { call, kv } = setup();
  const up = await call('signup', { email: 'a@b.co', auth: auth() });
  await kv.del('user/' + up.body.userId);
  assert.equal((await call('signup', { email: 'a@b.co', auth: auth() })).status, 200);
});

// Needs `npm install` (for @netlify/blobs); skipped without it.
test('the same flows on Netlify Blobs (the local Blobs server)', async (t) => {
  const blobs = await Promise.all([import('@netlify/blobs/server'), import('@netlify/blobs')]).catch(() => null);
  if (!blobs) { t.skip('run npm install first'); return; }
  const [{ BlobsServer }, { getStore }] = blobs;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdw-blobs-'));
  const server = new BlobsServer({ directory: dir, token: 'tok', port: 0 });
  const { port } = await server.start();
  try {
    const url = 'http://localhost:' + port;
    const store = getStore({ name: 'accounts', siteID: 'site', token: 'tok', edgeURL: url, uncachedEdgeURL: url, consistency: 'strong' });
    const { call } = setup(blobsKV(store));
    const a = auth(), b = auth();
    const one = await call('signup', { email: 'a@b.co', auth: a });
    assert.equal(one.status, 200);
    assert.equal((await call('signup', { email: 'a@b.co', auth: a })).status, 409);
    assert.equal((await call('push', { base: 0, iv: IV, ct: CT }, one.cookie)).body.rev, 1);
    const stale = await call('push', { base: 0, iv: IV, ct: 'AAAA' }, one.cookie);
    assert.deepEqual([stale.status, stale.body.ct], [409, CT]);
    const two = await call('login', { email: 'a@b.co', auth: a });
    assert.equal((await call('password', { auth: a, newAuth: b, base: 1, iv: IV, ct: 'BBBB' }, one.cookie)).body.rev, 2);
    assert.equal((await call('pull', {}, two.cookie)).status, 401);
    assert.equal((await call('delete', { auth: b }, one.cookie)).status, 200);
    assert.deepEqual((await store.list()).blobs, []);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
