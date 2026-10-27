// Local dev server: static files from public/ + the same API handler Vercel runs.
// Usage: DATABASE_URL=postgres://... AUTH_SECRET=... node scripts/dev-server.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handle } = require('../lib/handler');

const root = path.join(__dirname, '..', 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return handle(req, res);
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('Not found'); }
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  if (p === '/sw.js') res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(file).pipe(res);
}).listen(Number(process.argv[2]) || 3000, () => console.log('StakeFit dev server on http://localhost:' + (process.argv[2] || 3000)));
