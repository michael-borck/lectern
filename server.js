// present — one process: static slides + WebSocket slide-sync.
// Presenter:  https://your.domain/?key=SECRET   (drives the slides)
// Viewers:    https://your.domain/              (follow along, no invite)
//
// Env:
//   PORT             (default 3000)
//   PRESENTER_SECRET required to drive slides; default "changeme"

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PRESENTER_SECRET = process.env.PRESENTER_SECRET || 'changeme';

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const SLIDES = path.join(ROOT, 'slides');
const REVEAL = path.join(ROOT, 'node_modules/reveal.js/dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function listSlides() {
  let files = [];
  try {
    files = fs.readdirSync(SLIDES);
  } catch {}
  return files
    .filter((f) => !f.startsWith('.') && /\.(png|jpe?g|webp)$/i.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function serveFile(res, base, rel) {
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base + path.sep) && file !== base) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/slides.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(listSlides()));
    return;
  }
  if (url.pathname.startsWith('/slides/')) {
    serveFile(res, SLIDES, url.pathname.slice('/slides'.length));
    return;
  }
  if (url.pathname.startsWith('/reveal/')) {
    serveFile(res, REVEAL, url.pathname.slice('/reveal'.length));
    return;
  }
  serveFile(res, PUBLIC, url.pathname === '/' ? '/index.html' : url.pathname);
});

// --- sync ---

const wss = new WebSocketServer({ server, path: '/sync' });
const clients = new Set();
let currentIndex = 0;

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(msg, except) {
  for (const c of clients) if (c !== except) send(c, msg);
}

function broadcastViewerCount() {
  const count = [...clients].filter((c) => !c.isPresenter).length;
  broadcast({ type: 'viewers', count });
}

wss.on('connection', (ws, req) => {
  const key = new URL(req.url, 'http://localhost').searchParams.get('key');
  ws.isPresenter = PRESENTER_SECRET.length > 0 && key === PRESENTER_SECRET;
  clients.add(ws);

  // late joiners (and presenter reloads) land on the current slide
  send(ws, { type: 'state', index: currentIndex, role: ws.isPresenter ? 'presenter' : 'viewer' });
  broadcastViewerCount();

  ws.on('message', (data) => {
    if (!ws.isPresenter) return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === 'goto' && Number.isInteger(msg.index) && msg.index >= 0) {
      currentIndex = msg.index;
      broadcast({ type: 'goto', index: currentIndex }, ws);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcastViewerCount();
  });
});

server.listen(PORT, () => {
  console.log(`present listening on :${PORT}`);
  if (PRESENTER_SECRET === 'changeme') {
    console.log('WARNING: set PRESENTER_SECRET env var; presenter key is currently the default "changeme"');
  }
});
