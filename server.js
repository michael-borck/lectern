// present — one process: static slides + WebSocket slide-sync, multi-deck.
//
// Layout: presentations/<deck>/slide-*.png  (one folder per talk)
//
//   /                      list of decks
//   /<deck>/               viewer URL — share this one, no invite
//   /<deck>/?key=SECRET    presenter URL — drives the slides for that deck
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
const REVEAL = path.join(ROOT, 'node_modules/reveal.js/dist');
const DECKS_DIR = process.env.DECKS_DIR || path.join(ROOT, 'presentations');

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVED = new Set(['reveal', 'sync', 'decks.json', 'viewer.js', 'style.css', 'favicon.ico']);

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

const IMG = /\.(png|jpe?g|webp)$/i;

function deckExists(deck) {
  try {
    return fs.statSync(path.join(DECKS_DIR, deck)).isDirectory();
  } catch {
    return false;
  }
}

function listSlides(deck) {
  try {
    return fs
      .readdirSync(path.join(DECKS_DIR, deck))
      .filter((f) => !f.startsWith('.') && IMG.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

function listDecks() {
  try {
    return fs
      .readdirSync(DECKS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && SLUG.test(d.name) && !RESERVED.has(d.name))
      .map((d) => {
        const slides = listSlides(d.name);
        return { name: d.name, slides: slides.length, thumb: slides[0] || null };
      })
      .filter((d) => d.slides > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
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

function sendJson(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  if (url.pathname === '/') {
    serveFile(res, PUBLIC, '/decks.html');
    return;
  }
  if (url.pathname === '/decks.json') {
    sendJson(res, listDecks());
    return;
  }
  if (url.pathname.startsWith('/reveal/')) {
    serveFile(res, REVEAL, url.pathname.slice('/reveal'.length));
    return;
  }
  if (url.pathname === '/viewer.js' || url.pathname === '/style.css' || url.pathname === '/favicon.ico') {
    serveFile(res, PUBLIC, url.pathname);
    return;
  }

  // deck routes: /<deck>/ , /<deck>/slides.json , /<deck>/slides/<file>
  const deck = parts[0];
  if (!deck || !SLUG.test(deck) || RESERVED.has(deck) || !deckExists(deck)) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404</h1><p>No such presentation. <a href="/">All presentations</a></p>');
    return;
  }
  if (parts.length === 1) {
    if (!url.pathname.endsWith('/')) {
      res.writeHead(301, { Location: `/${deck}/` });
      res.end();
      return;
    }
    serveFile(res, PUBLIC, '/index.html');
    return;
  }
  if (parts[1] === 'slides.json' && parts.length === 2) {
    sendJson(res, listSlides(deck));
    return;
  }
  if (parts[1] === 'slides' && parts.length === 3 && IMG.test(parts[2])) {
    serveFile(res, path.join(DECKS_DIR, deck), `/${parts[2]}`);
    return;
  }
  res.writeHead(404).end('not found');
});

// --- sync (per deck) ---

const wss = new WebSocketServer({ server, path: '/sync' });
const clients = new Set();
const deckIndex = new Map(); // deck -> current slide index

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastDeck(deck, msg, except) {
  for (const c of clients) if (c.deck === deck && c !== except) send(c, msg);
}

function broadcastViewerCount(deck) {
  const count = [...clients].filter((c) => c.deck === deck && !c.isPresenter).length;
  broadcastDeck(deck, { type: 'viewers', count });
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const deck = url.searchParams.get('deck');
  if (!deck || !deckExists(deck)) {
    ws.close(4004, 'unknown deck');
    return;
  }
  const key = url.searchParams.get('key');
  ws.deck = deck;
  ws.isPresenter = PRESENTER_SECRET.length > 0 && key === PRESENTER_SECRET;
  clients.add(ws);

  // late joiners (and presenter reloads) land on the current slide
  send(ws, {
    type: 'state',
    index: deckIndex.get(deck) || 0,
    role: ws.isPresenter ? 'presenter' : 'viewer',
  });
  broadcastViewerCount(deck);

  ws.on('message', (data) => {
    if (!ws.isPresenter) return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === 'goto' && Number.isInteger(msg.index) && msg.index >= 0) {
      deckIndex.set(deck, msg.index);
      broadcastDeck(deck, { type: 'goto', index: msg.index }, ws);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcastViewerCount(deck);
  });

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

// keep connections alive through proxies that idle-kill WebSockets
setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) {
      clients.delete(ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`present listening on :${PORT}, decks from ${DECKS_DIR}`);
  if (PRESENTER_SECRET === 'changeme') {
    console.log('WARNING: set PRESENTER_SECRET env var; presenter key is currently the default "changeme"');
  }
});
