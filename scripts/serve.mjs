import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../docs/', import.meta.url);
const types = new Map([
  ['/index.html', 'text/html; charset=utf-8'],
  ['/matrix.json', 'application/json; charset=utf-8'],
  ['/changes.json', 'application/json; charset=utf-8'],
  ['/screenshot.png', 'image/png'], ['/demo.gif', 'image/gif'],
]);
const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return;
  }
  const requested = new URL(req.url, 'http://127.0.0.1').pathname;
  const resource = requested === '/' ? '/index.html' : requested;
  if (!types.has(resource)) { res.writeHead(404).end('Not found'); return; }
  try {
    const body = await readFile(new URL(resource.slice(1), root));
    res.writeHead(200, { 'Content-Type': types.get(resource), 'Content-Length': body.length,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(500).end('Could not read the built site'); }
});
server.listen(Number(process.env.PORT ?? 4173), '127.0.0.1', () => {
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/`, pid: process.pid,
    root: fileURLToPath(root), mode: 'read-only local preview' }));
});
