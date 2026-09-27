/* The account's safe. Your password becomes two keys, in this browser: one proves who you are to
   the server, the other encrypts what the account keeps (AES-GCM), so the server only ever holds
   ciphertext. What's kept is a set of fields, { name: { v: value, at: time } }; two copies merge
   field by field, and the later change wins.
   UMD: TDW.Vault in the browser, module.exports in Node (for the tests). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(globalThis.crypto);
  else { root.TDW = root.TDW || {}; root.TDW.Vault = factory(root.crypto); }
})(typeof self !== 'undefined' ? self : this, function (webcrypto) {
  'use strict';

  const ITERATIONS = 600000; // PBKDF2-SHA256, OWASP's number for 2023 and later
  const utf8 = new TextEncoder();

  const normEmail = (e) => String(e || '').trim().toLowerCase();

  function subtle() {
    // Only secure pages (https or localhost) get WebCrypto.
    if (!webcrypto || !webcrypto.subtle) throw Object.assign(new Error('Accounts need a secure (https) page.'), { code: 'insecure' });
    return webcrypto.subtle;
  }

  function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  // { auth: base64url, sent to the server; key: base64, never leaves this browser }
  async function deriveKeys(email, password) {
    const s = subtle();
    const pw = await s.importKey('raw', utf8.encode(String(password).normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
    const master = await s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: utf8.encode('ten-dollar-words|' + normEmail(email)), iterations: ITERATIONS }, pw, 256);
    const hk = await s.importKey('raw', master, 'HKDF', false, ['deriveBits']);
    const part = (info) => s.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8.encode(info) }, hk, 256);
    const [auth, key] = await Promise.all([part('tdw auth'), part('tdw data')]);
    return { auth: b64url(new Uint8Array(auth)), key: b64(new Uint8Array(key)) };
  }

  const aesKey = (key) => subtle().importKey('raw', unb64(key), 'AES-GCM', false, ['encrypt', 'decrypt']);

  // The account id goes in as additional data, so one account's document can't pass for another's.
  async function seal(fields, key, userId) {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(userId) }, await aesKey(key),
      utf8.encode(JSON.stringify({ v: 1, fields })));
    return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  }

  // Throws when the key is wrong or the document was changed.
  async function open(doc, key, userId) {
    let plain;
    try {
      plain = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(doc.iv), additionalData: utf8.encode(userId) }, await aesKey(key), unb64(doc.ct));
    } catch (e) {
      if (e && e.code === 'insecure') throw e;
      throw Object.assign(new Error("This browser's key doesn't open your account."), { code: 'locked' });
    }
    const obj = JSON.parse(new TextDecoder().decode(plain));
    return clean(obj && obj.fields);
  }

  function clean(fields) {
    const out = {};
    if (!fields || typeof fields !== 'object') return out;
    for (const name of Object.keys(fields)) {
      const f = fields[name];
      if (f && typeof f === 'object' && Number.isFinite(f.at) && 'v' in f) out[name] = { v: f.v, at: f.at };
    }
    return out;
  }

  // JSON with object keys in order, so equal values compare equal wherever they came from.
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  const same = (a, b) => stable(a) === stable(b);

  // Field by field, the later change wins. Equal times pick the same side on every device.
  function merge(a, b) {
    const out = {};
    for (const name of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
      const x = a && a[name], y = b && b[name];
      if (!x || !y) { out[name] = x || y; continue; }
      if (x.at !== y.at) { out[name] = x.at > y.at ? x : y; continue; }
      out[name] = stable(x.v) >= stable(y.v) ? x : y;
    }
    return out;
  }

  // Whether b holds any field that a lacks or has differently: after a merge, whether the server's
  // copy is missing something.
  function differs(b, a) {
    return Object.keys(b || {}).some((n) => !a || !a[n] || b[n].at !== a[n].at || !same(b[n].v, a[n].v));
  }

  return { ITERATIONS, normEmail, deriveKeys, seal, open, merge, differs, same, stable, b64, unb64 };
});
