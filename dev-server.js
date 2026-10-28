// Local dev server — a zero-dependency stand-in for `vercel dev`.
// Serves index.html and runs api/*.js with Vercel-style req/res helpers.
// Reads settings from .env (or .env.local) — never committed / deployed. On Railway, use its Variables instead.
// Usage:  node dev-server.js      → http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);

// Load .env.local, then .env (KEY=value lines); empty values and real env vars are left alone
for (const name of ['.env.local', '.env']) {
  const envFile = path.join(ROOT, name);
  if (!fs.existsSync(envFile)) continue;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    const value = m ? m[2].replace(/^["']|["']$/g, '') : '';
    if (m && value && !(m[1] in process.env)) process.env[m[1]] = value;
  }
}
if (!process.env.APP_URL) process.env.APP_URL = 'http://localhost:' + PORT;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.pdf': 'application/pdf' };

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      if (!data) return resolve(undefined);
      try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
    });
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const started = Date.now();
  res.on('finish', () => console.log(`${req.method} ${url.pathname} → ${res.statusCode} (${Date.now() - started}ms)`));

  // Vercel-style helpers
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return res; };
  res.send = (body) => { res.end(typeof body === 'object' ? JSON.stringify(body) : String(body)); return res; };

  // /api/<name> → api/<name>.js
  const api = url.pathname.match(/^\/api\/([A-Za-z0-9-][A-Za-z0-9_-]*)\/?$/); // "_" files are helpers, not routes
  if (api) {
    const file = path.join(ROOT, 'api', api[1] + '.js');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'no such function' });
    req.query = Object.fromEntries(url.searchParams);
    req.body = await readBody(req);
    try {
      delete require.cache[require.resolve(file)]; // pick up edits without restart
      await require(file)(req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.status(500).json({ error: String(e.message || e) });
    }
    return;
  }

  // Static files (index.html for /)
  const rel = url.pathname === '/' ? 'index.html' : url.pathname === '/admin' ? 'admin.html'
    : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT) || /(^|[\\/])\.|dev-server\.js$|package(-lock)?\.json$|^(data|api|handoff)([\\/]|$)/.test(rel) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404; return res.end('Not found');
  }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  require('./api/_truthfinder').start(); // step ② background worker (only when TF_ENABLED=true)
  require('./api/_pipeline').start();    // background flow: runs ② + ③ after the customer submits, emails the result
  const missing = ['DIDIT_API_KEY', 'DIDIT_WORKFLOW_ID', 'WC_URL', 'WC_CK', 'WC_CS'].filter((k) => !process.env[k]);
  console.log(`Imperium rental app → http://localhost:${PORT}`);
  if (missing.length) console.log('⚠  Missing env vars (fill .env or Railway Variables): ' + missing.join(', '));
});
