/* Accounts. The server never sees a password or a key. The browser turns the password into two
   keys: it sends one to prove who you are (kept here only as a scrypt hash) and keeps the other to
   encrypt your data. What an account holds is one encrypted document, with a revision number so
   two devices can't overwrite each other's changes.

   Records in the key-value store:
     email/<sha256 of the email>        { userId }
     user/<userId>                      { id, email, salt, hash, createdAt, doc: { rev, iv, ct, at } }
     session/<userId>/<sha256 of token> { created, seen, expires }
     fail/<sha256 of the email>         { n, since }   wrong passwords, for the lockout

   Every call is a POST to /api/account/<action> with a JSON body and an X-TDW header. */
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

const COOKIE = 'tdw_session';
const SESSION_MS = 365 * 86400e3;
const SEEN_MS = 86400e3;          // how often a session's expiry moves forward
const LOCK_AFTER = 8;             // wrong passwords in a row before the lockout
const LOCK_MS = 15 * 60e3;
const MAX_BODY = 1024 * 1024;
const MAX_DOC = 700 * 1024;       // characters of ciphertext
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUTH_RE = /^[A-Za-z0-9_-]{43}$/;     // 32 bytes, base64url
const IV_RE = /^[A-Za-z0-9+/]{16}$/;       // 12 bytes, base64
const CT_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const ID_RE = /^[0-9a-f]{32}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const b64url = (buf) => buf.toString('base64url');

export const normEmail = (e) => String(e || '').trim().toLowerCase();

async function hashAuth(auth, salt) {
  return (await scrypt(Buffer.from(auth, 'base64url'), salt, 32, SCRYPT)).toString('base64');
}

async function checkAuth(user, auth) {
  const want = Buffer.from(user.hash, 'base64');
  const got = Buffer.from(await hashAuth(auth, Buffer.from(user.salt, 'base64')), 'base64');
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function json(status, body, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, headers || {})
  });
}
const fail = (status, error, message, extra) => json(status, Object.assign({ error, message }, extra || {}));

const docOut = (doc) => (doc && doc.ct ? { rev: doc.rev, iv: doc.iv, ct: doc.ct } : { rev: doc ? doc.rev : 0 });

// A Netlify Blobs store as the small key-value interface the handler uses.
export function blobsKV(store) {
  return {
    async get(key) {
      const r = await store.getWithMetadata(key, { type: 'json' });
      if (!r) return null;
      let etag = r.etag;
      if (!etag) { // Netlify's local Blobs server leaves the ETag off reads; a listing has it
        const { blobs } = await store.list({ prefix: key });
        const hit = blobs.find((b) => b.key === key);
        etag = hit && hit.etag;
      }
      return { data: r.data, etag };
    },
    async put(key, value, cond) {
      if (cond && 'etag' in cond && !cond.etag) return false; // never turn a checked write into a blind one
      const opts = cond && cond.etag ? { onlyIfMatch: cond.etag } : cond && cond.isNew ? { onlyIfNew: true } : undefined;
      const r = await store.setJSON(key, value, opts);
      return !r || r.modified !== false;
    },
    del: (key) => store.delete(key),
    async keys(prefix) {
      const { blobs } = await store.list({ prefix });
      return blobs.map((b) => b.key);
    }
  };
}

// In memory, for tests and the local dev server. Same answers as blobsKV.
export function memoryKV() {
  const m = new Map();
  let n = 0;
  return {
    async get(key) { return m.has(key) ? { data: JSON.parse(m.get(key).v), etag: m.get(key).etag } : null; },
    async put(key, value, cond) {
      const cur = m.get(key);
      if (cond && cond.isNew && cur) return false;
      if (cond && cond.etag && (!cur || cur.etag !== cond.etag)) return false;
      m.set(key, { v: JSON.stringify(value), etag: '"' + (++n) + '"' });
      return true;
    },
    async del(key) { m.delete(key); },
    async keys(prefix) { return [...m.keys()].filter((k) => k.startsWith(prefix)); },
    dump: () => m
  };
}

export function createHandler(opts) {
  const kv = opts.kv;
  const now = opts.now || Date.now;
  const secure = opts.secure !== false;

  function cookie(value, maxAge) {
    return COOKIE + '=' + value + '; Path=/api; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(maxAge / 1000) + (secure ? '; Secure' : '');
  }

  function readCookie(req) {
    const raw = req.headers.get('cookie') || '';
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return '';
  }

  async function newSession(userId) {
    const token = b64url(crypto.randomBytes(32));
    const t = now();
    await kv.put('session/' + userId + '/' + sha(token), { created: t, seen: t, expires: t + SESSION_MS });
    return cookie(userId + '.' + token, SESSION_MS);
  }

  // The signed-in account, or null. refresh: a Set-Cookie value when the session was extended.
  async function session(req) {
    const [userId, token] = readCookie(req).split('.');
    if (!ID_RE.test(userId || '') || !TOKEN_RE.test(token || '')) return null;
    const key = 'session/' + userId + '/' + sha(token);
    const s = await kv.get(key);
    const t = now();
    if (!s || !s.data || s.data.expires < t) {
      if (s) await kv.del(key);
      return null;
    }
    const user = await kv.get('user/' + userId);
    if (!user || !user.data) { await kv.del(key); return null; }
    let refresh = null;
    if (t - s.data.seen > SEEN_MS) {
      await kv.put(key, { created: s.data.created, seen: t, expires: t + SESSION_MS });
      refresh = cookie(userId + '.' + token, SESSION_MS);
    }
    return { userId, key, user, refresh };
  }

  async function dropSessions(userId, keep) {
    for (const k of await kv.keys('session/' + userId + '/')) if (k !== keep) await kv.del(k);
  }

  async function lockedOut(emailKey) {
    const f = await kv.get('fail/' + emailKey);
    return !!(f && f.data && f.data.n >= LOCK_AFTER && now() - f.data.since < LOCK_MS);
  }

  async function noteFailure(emailKey) {
    const f = await kv.get('fail/' + emailKey);
    const t = now();
    const fresh = !f || !f.data || t - f.data.since >= LOCK_MS;
    await kv.put('fail/' + emailKey, { n: fresh ? 1 : f.data.n + 1, since: fresh ? t : f.data.since });
  }

  // The password check shared by login, password change and delete. Returns an error Response or null.
  async function verify(user, auth) {
    const emailKey = sha(user.data.email);
    if (await lockedOut(emailKey)) return fail(429, 'locked', 'Too many wrong passwords. Try again in 15 minutes.');
    if (!AUTH_RE.test(String(auth || '')) || !(await checkAuth(user.data, auth))) {
      await noteFailure(emailKey);
      return fail(401, 'wrong', 'Wrong email or password.');
    }
    await kv.del('fail/' + emailKey);
    return null;
  }

  // Write the account's document if its revision is still `base`. Returns the new revision, or
  // null when another device got there first.
  async function writeDoc(user, base, iv, ct, patch) {
    const cur = user.data.doc || { rev: 0 };
    if (cur.rev !== base) return null;
    const next = Object.assign({}, user.data, patch || {}, { doc: { rev: base + 1, iv, ct, at: now() } });
    return (await kv.put('user/' + user.data.id, next, { etag: user.etag })) ? base + 1 : null;
  }

  function checkDoc(body) {
    const { base, iv, ct } = body;
    if (!Number.isInteger(base) || base < 0 || !IV_RE.test(String(iv || '')) || typeof ct !== 'string' || !CT_RE.test(ct)) {
      return fail(400, 'bad_request', 'That request is missing something.');
    }
    if (ct.length > MAX_DOC) return fail(413, 'too_big', 'Your settings are too large to save.');
    return null;
  }

  async function conflict(userId) {
    const fresh = await kv.get('user/' + userId);
    return fail(409, 'conflict', 'Changed on another device.', docOut(fresh && fresh.data && fresh.data.doc));
  }

  const actions = {
    async signup(body) {
      const email = normEmail(body.email);
      if (email.length > 254 || !EMAIL_RE.test(email)) return fail(400, 'bad_email', 'That email address looks wrong.');
      if (!AUTH_RE.test(String(body.auth || ''))) return fail(400, 'bad_request', 'That request is missing something.');
      const emailKey = sha(email);
      const userId = crypto.randomBytes(16).toString('hex');
      let claimed = await kv.put('email/' + emailKey, { userId }, { isNew: true });
      if (!claimed) {
        // An index left behind by a signup that never finished can be taken over.
        const idx = await kv.get('email/' + emailKey);
        const owner = idx && idx.data && (await kv.get('user/' + idx.data.userId));
        if (!idx || (owner && owner.data)) return fail(409, 'exists', 'There is already an account with that email. Sign in instead.');
        claimed = await kv.put('email/' + emailKey, { userId }, { etag: idx.etag });
        if (!claimed) return fail(409, 'exists', 'There is already an account with that email. Sign in instead.');
      }
      const salt = crypto.randomBytes(16);
      await kv.put('user/' + userId, {
        id: userId, email, salt: salt.toString('base64'), hash: await hashAuth(body.auth, salt), createdAt: now(), doc: { rev: 0 }
      }, { isNew: true });
      return json(200, { email, userId, rev: 0 }, { 'Set-Cookie': await newSession(userId) });
    },

    async login(body) {
      const email = normEmail(body.email);
      const emailKey = sha(email);
      const idx = EMAIL_RE.test(email) ? await kv.get('email/' + emailKey) : null;
      const user = idx && idx.data ? await kv.get('user/' + idx.data.userId) : null;
      if (!user || !user.data) {
        if (await lockedOut(emailKey)) return fail(429, 'locked', 'Too many wrong passwords. Try again in 15 minutes.');
        await hashAuth(AUTH_RE.test(String(body.auth || '')) ? body.auth : 'A'.repeat(43), crypto.randomBytes(16)); // same time as a real check
        await noteFailure(emailKey);
        return fail(401, 'wrong', 'Wrong email or password.');
      }
      const bad = await verify(user, body.auth);
      if (bad) return bad;
      return json(200, Object.assign({ email: user.data.email, userId: user.data.id }, docOut(user.data.doc)),
        { 'Set-Cookie': await newSession(user.data.id) });
    },

    async logout(body, s) {
      if (s) await kv.del(s.key);
      return json(200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
    },

    async pull(body, s) {
      return json(200, Object.assign({ email: s.user.data.email, userId: s.userId }, docOut(s.user.data.doc)));
    },

    async push(body, s) {
      const bad = checkDoc(body);
      if (bad) return bad;
      const rev = await writeDoc(s.user, body.base, body.iv, body.ct);
      return rev == null ? conflict(s.userId) : json(200, { rev });
    },

    // A new password means a new key: the browser sends the document encrypted with it.
    async password(body, s) {
      const bad = checkDoc(body) || (await verify(s.user, body.auth));
      if (bad) return bad;
      if (!AUTH_RE.test(String(body.newAuth || ''))) return fail(400, 'bad_request', 'That request is missing something.');
      const salt = crypto.randomBytes(16);
      const rev = await writeDoc(s.user, body.base, body.iv, body.ct, { salt: salt.toString('base64'), hash: await hashAuth(body.newAuth, salt) });
      if (rev == null) return conflict(s.userId);
      await dropSessions(s.userId, s.key); // other devices have the old key: they sign in again
      return json(200, { rev });
    },

    async delete(body, s) {
      const bad = await verify(s.user, body.auth);
      if (bad) return bad;
      const emailKey = sha(s.user.data.email);
      await kv.del('user/' + s.userId);
      await kv.del('email/' + emailKey);
      await kv.del('fail/' + emailKey);
      await dropSessions(s.userId, null);
      return json(200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
    }
  };
  const OPEN = new Set(['signup', 'login', 'logout']);

  return async function handle(req, action) {
    if (req.method !== 'POST') return fail(405, 'method', 'Use POST.', null);
    if (!actions[action] || !Object.prototype.hasOwnProperty.call(actions, action)) return fail(404, 'not_found', 'No such action.');
    // Only this app's own pages may call: browsers won't let another site set this header without asking first.
    const site = req.headers.get('sec-fetch-site');
    if (req.headers.get('x-tdw') !== '1' || (site && site !== 'same-origin' && site !== 'none')) return fail(403, 'forbidden', 'Not allowed.');
    let text = '';
    try { text = await req.text(); } catch (_) { /* no body */ }
    if (text.length > MAX_BODY) return fail(413, 'too_big', 'That request is too large.');
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch (_) { return fail(400, 'bad_request', 'That request is missing something.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'bad_request', 'That request is missing something.');
    const s = await session(req);
    if (!s && !OPEN.has(action)) return fail(401, 'signed_out', 'You are signed out.', null);
    const res = await actions[action](body, s);
    if (!s || !s.refresh || res.headers.has('Set-Cookie')) return res;
    const headers = new Headers(res.headers);
    headers.set('Set-Cookie', s.refresh);
    return new Response(res.body, { status: res.status, headers });
  };
}
