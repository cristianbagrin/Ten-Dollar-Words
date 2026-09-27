// The app with accounts, on this computer: serves app/ with the headers from app/_headers, and
// answers /api/account/* with the same code the Netlify Function runs.
//   node tools/dev-server.mjs [--port 8765] [--blobs <folder>]
// Accounts live in memory and go when the server stops. With --blobs they're kept in that folder,
// through Netlify's local Blobs server (the same client code as production).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler, memoryKV, blobsKV } from '../netlify/lib/account-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const PORT = Number(arg('--port')) || 8765;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8'
};

// The headers app/_headers gives every page ("/*"), so the CSP is the one production has, except
// that pages may also call servers on this computer (the fake Notion in tests/fake-notion.mjs).
function siteHeaders() {
  const out = {};
  let on = false;
  for (const line of fs.readFileSync(path.join(ROOT, '_headers'), 'utf8').split('\n')) {
    if (!/^\s/.test(line)) { on = line.trim() === '/*'; continue; }
    const m = /^\s+([^:]+):\s*(.*)$/.exec(line);
    if (on && m) out[m[1]] = m[2];
  }
  const csp = 'Content-Security-Policy';
  if (out[csp]) out[csp] = out[csp].replace('connect-src ', 'connect-src http://127.0.0.1:* http://localhost:* ');
  return out;
}

async function store() {
  const dir = arg('--blobs');
  if (!dir) return memoryKV();
  const { BlobsServer } = await import('@netlify/blobs/server');
  const { getStore } = await import('@netlify/blobs');
  fs.mkdirSync(dir, { recursive: true });
  const server = new BlobsServer({ directory: dir, token: 'dev', port: 0 });
  const { port } = await server.start();
  const url = 'http://localhost:' + port;
  return blobsKV(getStore({ name: 'accounts', siteID: 'dev', token: 'dev', edgeURL: url, uncachedEdgeURL: url, consistency: 'strong' }));
}

const handle = createHandler({ kv: await store(), secure: false });
const HEADERS = siteHeaders();

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const api = /^\/api\/account\/([a-z]+)$/.exec(url.pathname);
  if (api) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url, { method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks) });
    const response = await handle(request, api[1]);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }
  let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
  res.writeHead(200, Object.assign({ 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }, HEADERS));
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log('Ten Dollar Words on http://127.0.0.1:' + PORT + '/'));
