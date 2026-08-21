// present — synced slide sharing, multi-user.
//
//   /                      home: hero + live presentations
//   /login                 passwordless email-code login
//   /dashboard             your decks: upload (PDF/PPTX), present, stop, delete
//   /<handle>/<deck>/      viewer URL — live decks only
//   /<handle>/<deck>/?present   presenter view (owner only; QR overlay on "q")
//
// Decks live in presentations/<handle>/<deck>/slide-*.png
// Accounts/sessions/decks in data/present.db (SQLite)
//
// Env: PORT, DATA_DIR, DECKS_DIR, ALLOWED_DOMAINS, EMAIL_PROVIDER (+SMTP_*/RESEND_API_KEY)

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const busboy = require('busboy');
const { WebSocketServer } = require('ws');

const db = require('./db');
const auth = require('./auth');
const { convert } = require('./convert');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const REVEAL = path.join(ROOT, 'node_modules/reveal.js/dist');
const QRCODE_JS = path.join(ROOT, 'node_modules/qrcode-generator/dist/qrcode.js');
const DECKS_DIR = process.env.DECKS_DIR || path.join(ROOT, 'presentations');

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IMG = /\.(png|jpe?g|webp)$/i;
const MAX_UPLOAD = 50 * 1024 * 1024;

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
};

// --- helpers ---

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(obj));
}

function sendHtml(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
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

function slideFiles(deck) {
  try {
    return fs
      .readdirSync(deckDir(deck))
      .filter((f) => !f.startsWith('.') && IMG.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

function deckDir(deck) {
  return path.join(DECKS_DIR, deck.handle, deck.slug);
}

function deckJson(deck) {
  const files = slideFiles(deck);
  return {
    id: deck.id,
    slug: deck.slug,
    title: deck.title,
    slides: deck.slide_count,
    status: deck.status,
    error: deck.error,
    live: !!deck.live,
    handle: deck.handle,
    thumb: files[0] || null,
    url: `/${deck.handle}/${deck.slug}/`,
  };
}

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'deck';

// deck visible to this requester? (live for everyone; owner always)
function deckVisibleTo(deck, user) {
  if (!deck || deck.status !== 'ready') return false;
  if (deck.live) return true;
  return !!user && user.id === deck.user_id;
}

// --- sync state (per deck, keyed "handle/slug") ---

const clients = new Set();
const deckIndex = new Map();

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcastDeck(key, msg, except) {
  for (const c of clients) if (c.deck === key && c !== except) send(c, msg);
}
function broadcastViewerCount(key) {
  const count = [...clients].filter((c) => c.deck === key && !c.isPresenter).length;
  broadcastDeck(key, { type: 'viewers', count });
}
function endDeckForViewers(key) {
  for (const c of [...clients]) {
    if (c.deck === key && !c.isPresenter) {
      send(c, { type: 'ended' });
      c.close(4000, 'presentation ended');
      clients.delete(c);
    }
  }
}

// --- upload (busboy -> tmp file) ---

function parseUpload(req) {
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD, files: 1 } });
    const fields = {};
    let fileInfo = null;
    let fileWritten = null;
    let tooBig = false;

    bb.on('field', (name, val) => (fields[name] = val));
    bb.on('file', (name, stream, info) => {
      if (name !== 'file') return stream.resume();
      const tmp = path.join(os.tmpdir(), `present-up-${crypto.randomBytes(8).toString('hex')}`);
      const out = fs.createWriteStream(tmp);
      stream.pipe(out);
      // size limit: drain the rest so parsing completes, reject afterwards
      stream.on('limit', () => {
        tooBig = true;
        stream.resume();
      });
      fileWritten = new Promise((res2, rej2) => {
        out.on('finish', res2);
        out.on('error', rej2);
        stream.on('error', rej2);
      });
      fileInfo = { tmp, filename: info.filename || 'deck' };
    });
    bb.on('error', reject);
    bb.on('close', async () => {
      try {
        if (fileWritten) await fileWritten; // let the disk write flush
        if (tooBig) {
          fs.rmSync(fileInfo.tmp, { force: true });
          reject(new Error(`file too large (max ${MAX_UPLOAD / 1024 / 1024} MB)`));
        } else if (!fileInfo) {
          reject(new Error('no file uploaded'));
        } else {
          resolve({ fields, ...fileInfo });
        }
      } catch (e) {
        reject(e);
      }
    });
    req.pipe(bb);
  });
}

function sniffKind(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const head = Buffer.alloc(4);
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  if (head.toString('latin1') === '%PDF') return 'pdf';
  if (head.readUInt32LE(0) === 0x04034b50) return 'pptx'; // zip (pptx/docx/xlsx)
  return null;
}

// --- HTTP ---

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  const user = auth.currentUser(req);

  try {
    // ---- statics ----
    if (url.pathname.startsWith('/reveal/')) return serveFile(res, REVEAL, url.pathname.slice('/reveal'.length));
    if (url.pathname === '/qrcode.js') return serveFile(res, QRCODE_JS, '/');
    if (['/viewer.js', '/style.css', '/dashboard.js', '/favicon.ico'].includes(url.pathname))
      return serveFile(res, PUBLIC, url.pathname);

    // ---- pages ----
    if (url.pathname === '/') return serveFile(res, PUBLIC, '/decks.html');
    if (url.pathname === '/login') {
      if (user) return redirect(res, '/dashboard');
      return serveFile(res, PUBLIC, '/login.html');
    }
    if (url.pathname === '/dashboard') {
      if (!user) return redirect(res, '/login?next=/dashboard');
      return serveFile(res, PUBLIC, '/dashboard.html');
    }

    // ---- auth API ----
    if (url.pathname === '/api/auth/request-code' && req.method === 'POST') {
      const body = await readJson(req);
      const emailAddr = (body?.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailAddr)) return sendJson(res, 400, { error: 'invalid email' });
      if (!auth.domainAllowed(emailAddr)) return sendJson(res, 403, { error: 'this email domain is not allowed' });
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      if (!auth.rateLimit(`code:email:${emailAddr}`, 5, 3600e3) || !auth.rateLimit(`code:ip:${ip}`, 20, 3600e3))
        return sendJson(res, 429, { error: 'too many codes requested — try again later' });
      try {
        await auth.requestCode(emailAddr);
      } catch (e) {
        console.error('send code failed:', e.message);
        return sendJson(res, 502, { error: 'could not send the code email' });
      }
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/api/auth/verify' && req.method === 'POST') {
      const body = await readJson(req);
      const emailAddr = (body?.email || '').trim().toLowerCase();
      const code = (body?.code || '').trim();
      if (!auth.rateLimit(`verify:${emailAddr}`, 10, 60e3)) return sendJson(res, 429, { error: 'too many attempts' });
      const verified = auth.verifyCode(emailAddr, code);
      if (!verified) return sendJson(res, 401, { error: 'wrong or expired code' });
      auth.setSessionCookie(req, res, db.createSession(verified.id));
      return sendJson(res, 200, { ok: true, handle: verified.handle });
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      db.deleteSession(auth.sessionToken(req));
      auth.clearSessionCookie(req, res);
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/api/me') {
      if (!user) return sendJson(res, 200, { user: null });
      return sendJson(res, 200, {
        user: { email: user.email, handle: user.handle },
        decks: db.decksForUser(user.id).map(deckJson),
      });
    }
    if (url.pathname === '/api/live.json') {
      return sendJson(res, 200, db.liveDecks().map(deckJson));
    }

    // ---- deck management API (owner only) ----
    const deckApi = url.pathname.match(/^\/api\/decks(?:\/(\d+)(?:\/(live|stop))?)?$/);
    if (deckApi) {
      if (!user) return sendJson(res, 401, { error: 'not logged in' });
      const [, idStr, action] = deckApi;

      if (req.method === 'POST' && !idStr) {
        // upload
        if (!auth.rateLimit(`upload:${user.id}`, 20, 3600e3)) return sendJson(res, 429, { error: 'too many uploads' });
        let up;
        try {
          up = await parseUpload(req);
        } catch (e) {
          return sendJson(res, 400, { error: e.message });
        }
        const kind = sniffKind(up.tmp);
        const ext = up.filename.toLowerCase();
        const extOk = (kind === 'pdf' && ext.endsWith('.pdf')) || (kind === 'pptx' && (ext.endsWith('.pptx') || ext.endsWith('.ppt')));
        if (!kind || !extOk) {
          fs.rmSync(up.tmp, { force: true });
          return sendJson(res, 400, { error: 'only PDF or PPTX files are accepted' });
        }
        const title = (up.fields.title || up.filename.replace(/\.(pdf|pptx?|ppt)$/i, '')).trim().slice(0, 120) || 'Untitled deck';
        let slug = slugify(up.fields.slug || title);
        if (!SLUG.test(slug)) slug = 'deck';
        for (let i = 2; !db.deckSlugFree(user.handle, slug); i++) slug = `${slugify(title)}-${i}`;

        const deck = db.createDeck(user.id, slug, title);
        const outDir = deckDir({ handle: user.handle, slug });
        convert(up.tmp, kind, outDir)
          .then((count) => db.setDeckReady(deck.id, count))
          .catch((e) => {
            console.error(`convert deck ${deck.id} failed:`, e.message);
            db.setDeckError(deck.id, e.message);
          });
        return sendJson(res, 202, { deck: db.getDeckById(deck.id) && deckJson(db.getDeckById(deck.id)) });
      }

      const deck = idStr ? db.getDeckById(Number(idStr)) : null;
      if (!deck || deck.user_id !== user.id) return sendJson(res, 404, { error: 'no such deck' });
      const key = `${deck.handle}/${deck.slug}`;

      if (req.method === 'POST' && action === 'live') {
        if (deck.status !== 'ready') return sendJson(res, 409, { error: 'deck is not ready yet' });
        db.setDeckLive(deck.id, true);
        return sendJson(res, 200, { ok: true, url: `/${deck.handle}/${deck.slug}/` });
      }
      if (req.method === 'POST' && action === 'stop') {
        db.setDeckLive(deck.id, false);
        deckIndex.delete(key);
        endDeckForViewers(key);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'DELETE' && !action) {
        db.setDeckLive(deck.id, false);
        endDeckForViewers(key);
        db.deleteDeck(deck.id);
        fs.rmSync(deckDir(deck), { recursive: true, force: true });
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // ---- deck pages + slide files: /<handle>/<deck>/... ----
    if (parts.length >= 2 && SLUG.test(parts[0]) && SLUG.test(parts[1])) {
      const deck = db.getDeckByPath(parts[0], parts[1]);
      const isOwner = !!user && deck && user.id === deck.user_id;
      const wantsPresent = url.searchParams.has('present');

      // presenter view: owner only
      if (parts.length === 2 && wantsPresent) {
        if (!deck || deck.status !== 'ready') return sendHtml(res, 404, '<h1>404</h1><p>No such presentation.</p>');
        if (!user) return redirect(res, `/login?next=${encodeURIComponent(url.pathname + '?present')}`);
        if (!isOwner) return sendHtml(res, 403, '<h1>403</h1><p>You can only present your own decks.</p>');
        if (!url.pathname.endsWith('/')) return redirect(res, url.pathname + '/?present');
        return serveFile(res, PUBLIC, '/index.html');
      }

      if (!deckVisibleTo(deck, user))
        return sendHtml(res, 404, '<h1>404</h1><p>No such presentation. <a href="/">Live presentations</a></p>');

      if (parts.length === 2) {
        if (!url.pathname.endsWith('/')) return redirect(res, url.pathname + '/');
        return serveFile(res, PUBLIC, '/index.html');
      }
      if (parts[2] === 'slides.json' && parts.length === 3) return sendJson(res, 200, slideFiles(deck));
      if (parts[2] === 'slides' && parts.length === 4 && IMG.test(parts[3]))
        return serveFile(res, deckDir(deck), `/${parts[3]}`);
      return sendHtml(res, 404, '<h1>404</h1>');
    }

    sendHtml(res, 404, '<h1>404</h1><p><a href="/">Home</a></p>');
  } catch (e) {
    console.error('request error:', e);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  }
});

// --- WebSocket sync ---

const wss = new WebSocketServer({ server, path: '/sync' });

wss.on('connection', (ws, req) => {
  const deckParam = new URL(req.url, 'http://localhost').searchParams.get('deck') || '';
  const [handle, slug] = deckParam.split('/');
  const deck = handle && slug ? db.getDeckByPath(handle, slug) : null;
  const user = auth.currentUser(req);

  if (!deck || deck.status !== 'ready') return ws.close(4004, 'unknown deck');

  ws.deck = `${deck.handle}/${deck.slug}`;
  ws.isPresenter = !!user && user.id === deck.user_id;
  if (!deck.live && !ws.isPresenter) return ws.close(4003, 'deck is not live');

  clients.add(ws);
  send(ws, { type: 'state', index: deckIndex.get(ws.deck) || 0, role: ws.isPresenter ? 'presenter' : 'viewer' });
  broadcastViewerCount(ws.deck);

  ws.on('message', (data) => {
    if (!ws.isPresenter) return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === 'goto' && Number.isInteger(msg.index) && msg.index >= 0) {
      deckIndex.set(ws.deck, msg.index);
      broadcastDeck(ws.deck, { type: 'goto', index: msg.index }, ws);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcastViewerCount(ws.deck);
  });

  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
});

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
  console.log(`present listening on :${PORT}`);
  console.log(`decks: ${DECKS_DIR}`);
  if (auth.PROVIDER === 'dev' || require('./email').PROVIDER === 'dev') {
    console.log('EMAIL_PROVIDER=dev — login codes are printed to this log');
  }
});
