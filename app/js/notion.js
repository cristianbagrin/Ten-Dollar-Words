/* Notion API client. One request at a time, at least 340ms apart, with retries.
   The integration secret is only ever sent to the Notion API host, in the Authorization header. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};

  const DEFAULT_BASE = 'https://api.notion.com/v1';
  const NOTION_VERSION = '2026-03-11';
  const GAP_MS = 340;
  const TIMEOUT_MS = 25000;
  const CODES = { 400: 'validation', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 429: 'rate_limited' };

  // Tests point the app at a fake server; that override only works on a local address.
  function pickBase() {
    const h = location.hostname;
    if (h === '127.0.0.1' || h === 'localhost') {
      try {
        const b = localStorage.getItem('tdw.notionBase');
        if (b && /^https?:\/\//.test(b)) return b.replace(/\/+$/, '');
      } catch (_) { /* storage blocked */ }
    }
    return DEFAULT_BASE;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (code, status, message) => ({ code, status: status || 0, message: message || '' });

  let chain = Promise.resolve();
  let lastStart = 0;

  async function attempt(method, path, body) {
    const wait = lastStart + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(Notion.base + path, {
        method,
        headers: {
          Authorization: 'Bearer ' + TDW.Store.getNotionToken(),
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        cache: 'no-store'
      });
      let data = null;
      try { data = await res.json(); } catch (_) { /* empty or not JSON */ }
      return { res, data };
    } catch (_) {
      // A network TypeError, or the 25s timeout: both mean Notion can't be reached.
      throw fail('offline', 0, "Can't reach Notion.");
    } finally {
      clearTimeout(timer);
    }
  }

  async function send(method, path, body) {
    let n429 = 0, n409 = 0, n5xx = 0;
    for (;;) {
      const { res, data } = await attempt(method, path, body);
      if (res.ok) return data || {};
      const s = res.status;
      if (s === 429 && n429 < 5) {
        n429++;
        const secs = Number(res.headers.get('Retry-After'));
        await sleep((secs > 0 ? secs : 1) * 1000);
        continue;
      }
      if (s === 409 && n409 < 1) { n409++; await sleep(500); continue; }
      if (s >= 500 && n5xx < 2) { await sleep(n5xx ? 3000 : 1000); n5xx++; continue; }
      const code = CODES[s] || (s >= 500 ? 'server' : 'unknown');
      throw fail(code, s, (data && typeof data.message === 'string' && data.message) || 'Notion returned ' + s + '.');
    }
  }

  function request(method, path, body) {
    const p = chain.then(() => send(method, path, body));
    chain = p.catch(() => {});
    return p;
  }

  const enc = encodeURIComponent;

  async function paginate(fetchPage) {
    const out = [];
    let cursor;
    do {
      const r = await fetchPage(cursor);
      out.push(...(Array.isArray(r.results) ? r.results : []));
      cursor = r.has_more && r.next_cursor ? r.next_cursor : null;
    } while (cursor);
    return out;
  }

  const Notion = {
    base: pickBase(),
    getDatabase: (id) => request('GET', '/databases/' + enc(id)),
    getDataSource: (id) => request('GET', '/data_sources/' + enc(id)),
    query: (dsId, opts) => request('POST', '/data_sources/' + enc(dsId) + '/query', {
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
      page_size: (opts && opts.page_size) || 100,
      start_cursor: (opts && opts.start_cursor) || undefined
    }),
    queryAll: (dsId) => paginate((cursor) => Notion.query(dsId, { page_size: 100, start_cursor: cursor })),
    getPage: (id) => request('GET', '/pages/' + enc(id)),
    createPage: (body) => request('POST', '/pages', body),
    updatePage: (id, body) => request('PATCH', '/pages/' + enc(id), body),
    trashPage: (id) => Notion.updatePage(id, { in_trash: true }),
    restorePage: (id) => Notion.updatePage(id, { in_trash: false }),
    listChildren: (id) => paginate((cursor) =>
      request('GET', '/blocks/' + enc(id) + '/children?page_size=100' + (cursor ? '&start_cursor=' + enc(cursor) : ''))),
    async appendChildren(pageId, children, afterId) {
      const r = await request('PATCH', '/blocks/' + enc(pageId) + '/children', {
        children,
        position: afterId ? { type: 'after_block', after_block: { id: afterId } } : { type: 'start' }
      });
      return Array.isArray(r.results) ? r.results : [];
    },
    updateBlock: (id, payload) => request('PATCH', '/blocks/' + enc(id), { [payload.type]: payload[payload.type] }),
    deleteBlock: (id) => request('DELETE', '/blocks/' + enc(id))
  };
  // The shape NotionMap.applyOps expects.
  Notion.api = { update: Notion.updateBlock, remove: Notion.deleteBlock, append: Notion.appendChildren };

  TDW.Notion = Notion;
})();
