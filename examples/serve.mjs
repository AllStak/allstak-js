/**
 * Simple static file server for the SDK examples.
 * Serves the entire allstak-js directory so examples can import from ../../dist/
 *
 * Usage: node examples/serve.mjs
 * Then open:
 *   http://localhost:5175/examples/vanilla-js/
 *   http://localhost:5175/examples/react-app/dist/  (after npm run build in react-app)
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');  // allstak-js/
const PORT = 5176;

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ts': 'text/plain',
};

const server = http.createServer((req, res) => {
  // CORS for SDK module imports
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/examples/vanilla-js/index.html';

  // Prevent path traversal above ROOT
  const filePath = path.resolve(ROOT, '.' + urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden');
    return;
  }

  // Try file, then index.html for directories
  let resolved = filePath;
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    resolved = path.join(resolved, 'index.html');
  }

  if (!fs.existsSync(resolved)) {
    console.warn(`404: ${urlPath}`);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`Not found: ${urlPath}`);
    return;
  }

  const ext = path.extname(resolved);
  const contentType = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(resolved).pipe(res);
  console.log(`200: ${urlPath}`);
});

server.listen(PORT, () => {
  console.log(`\n=== AllStak SDK Example Server ===`);
  console.log(`Root: ${ROOT}`);
  console.log(`Serving: http://localhost:${PORT}`);
  console.log(`\nApp URLs:`);
  console.log(`  Vanilla JS: http://localhost:${PORT}/examples/vanilla-js/`);
  console.log(`  React:      http://localhost:${PORT}/examples/react-app/dist/`);
});
