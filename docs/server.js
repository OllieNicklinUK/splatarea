#!/usr/bin/env node
// Static file server with Cross-Origin-Embedder-Policy + Cross-Origin-Opener-Policy headers.
// These are required for WebGPU collision generation (SharedArrayBuffer).
//
// Usage:  node server.js          (serves on port 3030)
//         node server.js 8080     (custom port)
//
// No npm dependencies — uses Node.js built-ins only.

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const PORT = parseInt(process.argv[2] || '3030', 10);
const ROOT = __dirname;

const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'text/javascript',
  '.mjs':   'text/javascript',
  '.css':   'text/css',
  '.json':  'application/json',
  '.ply':   'application/octet-stream',
  '.glb':   'model/gltf-binary',
  '.wasm':  'application/wasm',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.ogg':   'audio/ogg',
  '.mp3':   'audio/mpeg',
  '.zip':   'application/zip',
};

const server = http.createServer((req, res) => {
  // CORS / isolation headers
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');

  let pathname = url.parse(req.url).pathname;
  // Decode percent-encoding
  try { pathname = decodeURIComponent(pathname); } catch {}

  // Resolve to filesystem path
  let filePath = path.join(ROOT, pathname);

  // Directory index
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  // Stay inside ROOT (path traversal guard)
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Not found: ${pathname}`);
      return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Splat Arena running at http://localhost:${PORT}`);
  console.log(`Press Ctrl+C to stop.`);
});
