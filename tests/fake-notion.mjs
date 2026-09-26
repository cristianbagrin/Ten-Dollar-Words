// Fake Notion API for the sync stress tests. It answers the calls the app makes with Notion's
// shapes, keeps everything in memory, and adds /__admin routes to edit pages "in Notion".
//   node apps/ten-dollar-words/tests/fake-notion.mjs [--state <file>]
// With --state, pages are saved to that file after every change and loaded at start, so a
// restart keeps the same data (the request log starts empty).
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const NotionMap = require('../app/js/notion-map.js');

const HOST = '127.0.0.1';
const PORT = 8787;
const DB_ID = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
const DS_ID = 'ds1';
const SECRET = 'test-secret';
const stateAt = process.argv.indexOf('--state');
const STATE_FILE = stateAt > 0 ? process.argv[stateAt + 1] : null;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Notion-Version',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS'
};
const ANN = { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' };
const TEXT_TYPES = new Set(['paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'quote', 'to_do']);
const MENTIONED = { '99999999-9999-4999-8999-999999999999': 'Big idea' };
const PILLAR = [['40% Personal', 'blue'], ['30% Craft', 'green'], ["20% Client's reality", 'orange'], ['10% Proof', 'purple'], ['Other', 'gray']];
const STAGE = [['Idea', 'gray'], ['Draft 1 (no backspace)', 'blue'], ['Draft 2', 'blue'], ['Ready', 'yellow'], ['Scheduled', 'orange'], ['Posted', 'green']];
const GROUPS = [['To-do', 'gray', [0]], ['In progress', 'blue', [1, 2, 3, 4]], ['Complete', 'green', [5]]];

let S = null; // { pages: [{ id, created, edited, in_trash, props, blocks }], faults, count, log }

const uuid = () => crypto.randomUUID();
const minute = (ms) => Math.floor(ms / 60000) * 60000;
const iso = (ms) => new Date(ms).toISOString();
const dashless = (id) => String(id || '').replace(/-/g, '').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const bad = (message) => new ApiError(400, 'validation_error', message);
const missing = (what, id) => new ApiError(404, 'object_not_found', 'Could not find ' + what + ' with ID: ' + id + '.');

/* ---------- Shapes ---------- */

const txt = (content, ann) => ({
  type: 'text', text: { content, link: null }, annotations: Object.assign({}, ANN, ann || {}), plain_text: content, href: null
});
const pageTitle = (id) => {
  const p = S && S.pages.find((x) => x.id === id);
  return p ? p.props.Name.map((r) => r.plain_text).join('') : null;
};

// Rich text as the client sends it -> rich text as Notion returns it.
function richIn(list) {
  if (!Array.isArray(list)) throw bad('rich_text should be an array.');
  return list.map((r) => {
    if (!r || typeof r !== 'object') throw bad('rich_text items should be objects.');
    const annotations = Object.assign({}, ANN, r.annotations || {});
    if (r.type === 'mention') {
      const m = r.mention || {};
      if (m.type === 'page' && m.page && m.page.id) {
        return {
          type: 'mention', mention: { type: 'page', page: { id: m.page.id } }, annotations,
          plain_text: MENTIONED[m.page.id] || pageTitle(m.page.id) || 'Untitled', href: 'https://www.notion.so/' + dashless(m.page.id)
        };
      }
      if (m.type === 'date' && m.date) return { type: 'mention', mention: { type: 'date', date: m.date }, annotations, plain_text: String(m.date.start), href: null };
      throw bad('Unsupported mention.');
    }
    if (r.type === 'equation') {
      const e = String((r.equation && r.equation.expression) || '');
      return { type: 'equation', equation: { expression: e }, annotations, plain_text: e, href: null };
    }
    const t = r.text || {};
    const content = typeof t.content === 'string' ? t.content : '';
    if (content.length > 2000) throw bad('body.children[].rich_text[].text.content.length should be ≤ `2000`.');
    const link = t.link && t.link.url ? { url: String(t.link.url) } : null;
    return { type: 'text', text: { content, link }, annotations, plain_text: content, href: link ? link.url : null };
  });
}

function blockIn(c) {
  const type = c && c.type;
  if (!type || !c[type]) throw bad('Each child needs a type and a body.');
  const now = Date.now();
  const b = { id: uuid(), type, created: now, edited: now };
  if (TEXT_TYPES.has(type)) {
    b.body = { rich_text: richIn(c[type].rich_text || []), color: 'default' };
    if (type === 'to_do') b.body.checked = !!c[type].checked;
  } else if (type === 'divider') b.body = {};
  else if (type === 'image') b.body = c.image;
  else throw bad('Unsupported block type: ' + type + '.');
  return b;
}

const blockOut = (b, pageId, trashed) => ({
  object: 'block', id: b.id, parent: { type: 'page_id', page_id: pageId },
  created_time: iso(minute(b.created)), last_edited_time: iso(minute(b.edited)),
  has_children: false, in_trash: !!trashed, type: b.type, [b.type]: b.body
});

function option(list, name, prefix) {
  const i = list.findIndex(([n]) => n === name);
  return { id: prefix + (i + 1), name, color: i >= 0 ? list[i][1] : 'default' };
}

const pageOut = (p) => ({
  object: 'page', id: p.id,
  created_time: iso(minute(p.created)), last_edited_time: iso(minute(p.edited)),
  in_trash: !!p.in_trash, is_locked: false,
  parent: { type: 'data_source_id', data_source_id: DS_ID, database_id: DB_ID },
  url: 'https://www.notion.so/fake/' + dashless(p.id), public_url: null,
  properties: {
    Name: { id: 'title', type: 'title', title: p.props.Name },
    Date: { id: 'dDte', type: 'date', date: p.props.Date ? { start: p.props.Date, end: null, time_zone: null } : null },
    Pillar: { id: 'pPlr', type: 'select', select: p.props.Pillar ? option(PILLAR, p.props.Pillar, 'p') : null },
    Stage: { id: 'sStg', type: 'status', status: p.props.Stage ? option(STAGE, p.props.Stage, 's') : null }
  }
});

const dataSourceOut = () => ({
  object: 'data_source', id: DS_ID, title: [txt('Write posts')],
  parent: { type: 'database_id', database_id: DB_ID },
  properties: {
    Name: { id: 'title', name: 'Name', type: 'title', title: {} },
    Date: { id: 'dDte', name: 'Date', type: 'date', date: {} },
    Pillar: { id: 'pPlr', name: 'Pillar', type: 'select', select: { options: PILLAR.map(([n, c], i) => ({ id: 'p' + (i + 1), name: n, color: c })) } },
    Stage: {
      id: 'sStg', name: 'Stage', type: 'status', status: {
        options: STAGE.map(([n, c], i) => ({ id: 's' + (i + 1), name: n, color: c })),
        groups: GROUPS.map(([name, color, idx], i) => ({ id: 'g' + (i + 1), name, color, option_ids: idx.map((k) => 's' + (k + 1)) }))
      }
    }
  }
});

const databaseOut = () => ({
  object: 'database', id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: [txt('✍️ Write posts')],
  data_sources: [{ id: DS_ID, name: 'Write posts' }], in_trash: false, url: 'https://www.notion.so/fake/' + DB_ID
});

function setProps(p, props) {
  for (const [name, v] of Object.entries(props || {})) {
    if (!v || typeof v !== 'object') throw bad('Property ' + name + ' needs a value object.');
    if (name === 'Name') {
      if (!Array.isArray(v.title)) throw bad('Name is expected to be title.');
      p.props.Name = richIn(v.title);
    } else if (name === 'Date') {
      if (!('date' in v)) throw bad('Date is expected to be date.');
      p.props.Date = v.date ? String(v.date.start) : null;
    } else if (name === 'Pillar') {
      if (!('select' in v)) throw bad('Pillar is expected to be select.');
      p.props.Pillar = v.select ? String(v.select.name) : null;
    } else if (name === 'Stage') {
      if (!v.status || !v.status.name) throw bad('Stage is expected to be status.');
      if (!STAGE.some(([n]) => n === v.status.name)) throw bad('Invalid status option. Status option "' + v.status.name + '" does not exist.');
      p.props.Stage = v.status.name;
    } else {
      throw bad(name + ' is not a property that exists.');
    }
  }
}

/* ---------- State ---------- */

function seed() {
  const t0 = Date.parse('2026-09-20T09:00:00.000Z');
  const blk = (type, rich) => ({ id: uuid(), type, created: t0, edited: t0, body: { rich_text: rich, color: 'default' } });
  S = {
    pages: [
      {
        id: '11111111-1111-4111-8111-111111111111', created: t0, edited: t0 + 3 * 3600e3, in_trash: false,
        props: { Name: [txt('Why I write drafts without backspace')], Date: '2026-09-28', Pillar: '30% Craft', Stage: 'Draft 2' },
        blocks: [
          blk('paragraph', [txt('The first draft is for '), txt('getting it down', { bold: true }), txt(', not for getting it right. I explain why in '),
            { type: 'mention', mention: { type: 'page', page: { id: '99999999-9999-4999-8999-999999999999' } }, annotations: Object.assign({}, ANN),
              plain_text: 'Big idea', href: 'https://www.notion.so/99999999999949998999999999999999' },
            txt('.')]),
          blk('paragraph', [txt('Every time you hit backspace, you stop thinking about the reader.')]),
          blk('paragraph', [txt('So I switched it off for the first pass.')])
        ]
      },
      {
        id: '22222222-2222-4222-8222-222222222222', created: t0, edited: t0 + 2 * 3600e3, in_trash: false,
        props: { Name: [txt('Desk photo post')], Date: null, Pillar: '40% Personal', Stage: 'Idea' },
        blocks: [
          blk('paragraph', [txt('This is where the words happen.')]),
          { id: uuid(), type: 'image', created: t0, edited: t0, body: { type: 'external', external: { url: 'https://example.com/desk.jpg' }, caption: [] } },
          blk('paragraph', [txt('Nothing fancy. A desk and a deadline.')])
        ]
      },
      {
        id: '33333333-3333-4333-8333-333333333333', created: t0, edited: t0 + 3600e3, in_trash: false,
        props: { Name: [txt('Empty idea')], Date: null, Pillar: null, Stage: 'Idea' },
        blocks: []
      }
    ],
    faults: { every429: 0, fail500Once: false, latencyMs: 0 },
    count: 0,
    log: []
  };
}

function save() {
  if (!STATE_FILE) return;
  fs.writeFileSync(STATE_FILE, JSON.stringify({ pages: S.pages }));
}

function load() {
  seed();
  if (STATE_FILE && fs.existsSync(STATE_FILE)) {
    try { S.pages = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).pages; } catch (_) { /* keep the seed */ }
  }
}

const touch = (p) => { p.edited = Date.now(); };
function pageById(id) {
  const k = dashless(id);
  return S.pages.find((p) => dashless(p.id) === k) || null;
}
function findBlock(id) {
  for (const page of S.pages) {
    const index = page.blocks.findIndex((b) => b.id === id);
    if (index >= 0) return { page, index };
  }
  return null;
}
const editable = (p) => { if (p.in_trash) throw bad("Can't edit block that is archived. You must unarchive the block before editing."); };

/* ---------- API ---------- */

function list(results, start, size, type) {
  const next = start + size < results.length ? String(start + size) : null;
  return { object: 'list', results: results.slice(start, start + size), next_cursor: next, has_more: !!next, type, [type]: {} };
}

function route(method, parts, url, body, info) {
  const [a, id, sub] = parts;
  if (a === 'databases' && parts.length === 2 && method === 'GET') {
    if (dashless(id) !== DB_ID) throw missing('database', id);
    return databaseOut();
  }
  if (a === 'data_sources' && id !== DS_ID) throw missing('data_source', id);
  if (a === 'data_sources' && parts.length === 2 && method === 'GET') return dataSourceOut();
  if (a === 'data_sources' && sub === 'query' && method === 'POST') {
    const size = Math.min(100, Math.max(1, Number(body.page_size) || 100));
    const start = Number(body.start_cursor) || 0;
    const pages = S.pages.filter((p) => !p.in_trash).sort((x, y) => y.edited - x.edited).map(pageOut);
    info.n = pages.length;
    return list(pages, start, size, 'page_or_data_source');
  }
  if (a === 'pages' && parts.length === 1 && method === 'POST') {
    const parent = body.parent || {};
    if (parent.data_source_id !== DS_ID && dashless(parent.database_id) !== DB_ID) throw missing('data_source', parent.data_source_id || parent.database_id);
    const children = body.children || [];
    if (children.length > 100) throw bad('body.children.length should be ≤ `100`.');
    const now = Date.now();
    const p = { id: uuid(), created: now, edited: now, in_trash: false, props: { Name: [], Date: null, Pillar: null, Stage: null }, blocks: [] };
    setProps(p, body.properties);
    p.blocks = children.map(blockIn);
    S.pages.push(p);
    info.n = children.length;
    info.title = p.props.Name.map((r) => r.plain_text).join('');
    return pageOut(p);
  }
  if (a === 'pages' && parts.length === 2) {
    const p = pageById(id);
    if (!p) throw missing('page', id);
    if (method === 'GET') return pageOut(p);
    if (method === 'PATCH') {
      if (body.properties && p.in_trash && body.in_trash !== false) editable(p);
      if ('in_trash' in body) { p.in_trash = !!body.in_trash; info.in_trash = p.in_trash; }
      if (body.properties) { setProps(p, body.properties); info.props = Object.keys(body.properties).join(','); }
      touch(p);
      return pageOut(p);
    }
  }
  if (a === 'blocks' && sub === 'children') {
    const p = pageById(id);
    if (!p) throw missing('block', id);
    if (method === 'GET') {
      const size = Math.min(100, Math.max(1, Number(url.searchParams.get('page_size')) || 100));
      const start = Number(url.searchParams.get('start_cursor')) || 0;
      return list(p.blocks.map((b) => blockOut(b, p.id)), start, size, 'block');
    }
    if (method === 'PATCH') {
      editable(p);
      const children = body.children;
      if (!Array.isArray(children) || !children.length) throw bad('body.children should be a non-empty array.');
      if (children.length > 100) throw bad('body.children.length should be ≤ `100`.');
      const pos = body.position || { type: 'end' };
      let at;
      if (pos.type === 'start') at = 0;
      else if (pos.type === 'end') at = p.blocks.length;
      else if (pos.type === 'after_block') {
        const i = p.blocks.findIndex((b) => b.id === (pos.after_block && pos.after_block.id));
        if (i < 0) throw bad('Block ' + (pos.after_block && pos.after_block.id) + ' is not a child of this page.');
        at = i + 1;
      } else throw bad('position.type should be start, end, or after_block.');
      const made = children.map(blockIn);
      p.blocks.splice(at, 0, ...made);
      touch(p);
      info.n = children.length;
      info.after = pos.type === 'after_block' ? pos.after_block.id : pos.type;
      return list(made.map((b) => blockOut(b, p.id)), 0, made.length, 'block');
    }
  }
  if (a === 'blocks' && parts.length === 2) {
    const f = findBlock(id);
    if (!f) throw missing('block', id);
    const b = f.page.blocks[f.index];
    editable(f.page);
    if (method === 'DELETE') {
      f.page.blocks.splice(f.index, 1);
      touch(f.page);
      info.type = b.type;
      return blockOut(b, f.page.id, true);
    }
    if (method === 'PATCH') {
      const keys = Object.keys(body);
      if (keys.length !== 1 || keys[0] !== b.type) throw bad('Block type ' + b.type + " can't be changed to " + keys.join(', ') + '.');
      if (!TEXT_TYPES.has(b.type)) throw bad('Only text blocks can be updated here.');
      const v = body[b.type] || {};
      if (v.rich_text) b.body.rich_text = richIn(v.rich_text);
      if (b.type === 'to_do' && 'checked' in v) b.body.checked = !!v.checked;
      b.edited = Date.now();
      touch(f.page);
      info.type = b.type;
      return blockOut(b, f.page.id);
    }
  }
  throw new ApiError(400, 'invalid_request_url', 'Invalid request URL.');
}

/* ---------- Admin ---------- */

const plainRich = (rich) => rich.map((r) => r.plain_text).join('');
function dump() {
  return S.pages.map((p) => {
    const blocks = p.blocks.map((b) => blockOut(b, p.id));
    return {
      id: p.id, in_trash: !!p.in_trash, last_edited_time: iso(minute(p.edited)),
      title: plainRich(p.props.Name), stage: p.props.Stage, pillar: p.props.Pillar, date: p.props.Date,
      text: NotionMap.entriesToText(NotionMap.blocksToEntries(blocks)),
      blocks: p.blocks.map((b) => ({
        id: b.id, type: b.type,
        rich: TEXT_TYPES.has(b.type) ? b.body.rich_text.map((r) => ({ t: r.type, text: r.plain_text, bold: r.annotations.bold || undefined })) : undefined
      }))
    };
  });
}

function admin(method, action, body) {
  const page = () => { const p = pageById(body.pageId); if (!p) throw missing('page', body.pageId); return p; };
  if (method === 'GET' && action === 'dump') return dump();
  if (method === 'GET' && action === 'log') return S.log;
  if (method !== 'POST') throw bad('Use POST.');
  switch (action) {
    case 'reset': seed(); return { ok: true };
    case 'faults':
      Object.assign(S.faults, body);
      S.count = 0;
      return S.faults;
    case 'edit-block': {
      const p = page();
      const b = p.blocks[body.index];
      if (!b || !TEXT_TYPES.has(b.type)) throw bad('No text block at that index.');
      const first = b.body.rich_text[0];
      b.body.rich_text = [txt(String(body.text), first ? first.annotations : null)];
      b.edited = Date.now();
      touch(p);
      return { ok: true };
    }
    case 'add-block': {
      const p = page();
      const b = blockIn({ type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: String(body.text) } }] } });
      p.blocks.splice(Math.max(0, Math.min(Number(body.index) || 0, p.blocks.length)), 0, b);
      touch(p);
      return { ok: true, id: b.id };
    }
    case 'trash': page().in_trash = true; touch(page()); return { ok: true };
    case 'create-page': {
      const now = Date.now();
      const p = {
        id: uuid(), created: now, edited: now, in_trash: false,
        props: { Name: [txt(String(body.title || ''))], Date: null, Pillar: null, Stage: 'Idea' },
        blocks: (body.lines || []).map((l) => blockIn({ type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: String(l) } }] } }))
      };
      S.pages.push(p);
      return { ok: true, id: p.id };
    }
    case 'set-prop': {
      const p = page();
      const v = body.value;
      const shape = {
        Name: { title: [{ type: 'text', text: { content: String(v || '') } }] },
        Date: { date: v ? { start: String(v) } : null },
        Pillar: { select: v ? { name: String(v) } : null },
        Stage: { status: { name: String(v) } }
      }[body.name];
      if (!shape) throw bad(body.name + ' is not a property that exists.');
      setProps(p, { [body.name]: shape });
      touch(p);
      return { ok: true };
    }
    default: throw new ApiError(404, 'object_not_found', 'No admin route ' + action + '.');
  }
}

/* ---------- Server ---------- */

function send(res, status, obj, headers) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS, headers || {}));
  res.end(obj === undefined ? '' : JSON.stringify(obj));
}
const errorBody = (status, code, message) => ({ object: 'error', status, code, message });

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { throw bad('Body failed to parse as JSON.'); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + HOST + ':' + PORT);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  if (url.pathname.startsWith('/__admin/')) {
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const out = admin(req.method, url.pathname.slice(9), body);
      save();
      send(res, 200, out);
    } catch (e) {
      send(res, e.status || 500, errorBody(e.status || 500, e.code || 'internal_server_error', e.message));
    }
    return;
  }

  const entry = { i: S.log.length, t: new Date().toISOString(), method: req.method, path: url.pathname + url.search, status: 0 };
  S.log.push(entry);
  const reply = (status, obj, headers) => { entry.status = status; send(res, status, obj, headers); };
  try {
    if (!url.pathname.startsWith('/v1/')) throw new ApiError(400, 'invalid_request_url', 'Invalid request URL.');
    if (req.headers.authorization !== 'Bearer ' + SECRET) {
      reply(401, errorBody(401, 'unauthorized', 'API token is invalid.'));
      return;
    }
    if (!req.headers['notion-version']) throw bad('Notion-Version header failed validation.');
    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
    S.count++;
    if (S.faults.latencyMs) await sleep(S.faults.latencyMs);
    if (S.faults.fail500Once) {
      S.faults.fail500Once = false;
      reply(500, errorBody(500, 'internal_server_error', 'Fake server error.'));
      return;
    }
    if (S.faults.every429 && S.count % S.faults.every429 === 0) {
      reply(429, errorBody(429, 'rate_limited', 'You have been rate limited. Please try again in a few minutes.'), { 'Retry-After': '1' });
      return;
    }
    const info = {};
    const out = route(req.method, url.pathname.slice(4).split('/').filter(Boolean), url, body, info);
    if (Object.keys(info).length) entry.info = info;
    if (req.method !== 'GET' && !(req.method === 'POST' && url.pathname.endsWith('/query'))) save();
    reply(200, out);
  } catch (e) {
    if (e instanceof ApiError) reply(e.status, errorBody(e.status, e.code, e.message));
    else reply(500, errorBody(500, 'internal_server_error', String(e && e.message)));
  }
});

load();
server.listen(PORT, HOST, () => console.log('Fake Notion on http://' + HOST + ':' + PORT + (STATE_FILE ? ' (state: ' + STATE_FILE + ')' : '')));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(); process.exit(0); });
