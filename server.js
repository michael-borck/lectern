// lectern — synced slide sharing, multi-user.
//
//   /                      home: hero + live presentations
//   /login                 passwordless email-code login
//   /dashboard             your decks: upload (PDF/PPTX), present, stop, delete
//   /<handle>/<deck>/      viewer URL — live decks only
//   /<handle>/<deck>/?present   presenter view (owner only; keys: q join panel · Q QR overlay · p pen · c clear ink · b blank · f fullscreen)
//
// Decks live in presentations/<handle>/<deck>/slide-*.png
// Accounts/sessions/decks in data/lectern.db (SQLite)
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
const QRCODE_DIST = path.join(ROOT, 'node_modules/qrcode-generator/dist');
const DECKS_DIR = process.env.DECKS_DIR || path.join(ROOT, 'presentations');

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IMG = /\.(png|jpe?g|webp)$/i;
const MAX_UPLOAD = 50 * 1024 * 1024;
const MAX_USER_BYTES = Number(process.env.MAX_USER_BYTES || 500 * 1024 * 1024);
const MAX_DECK_BYTES = Number(process.env.MAX_DECK_BYTES || 200 * 1024 * 1024);

// Only believe X-Forwarded-For when explicitly behind a trusted proxy,
// otherwise clients can mint a fresh rate-limit key per request.
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) {
      const first = xff.split(',')[0].trim();
      if (first) return first;
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

const MAX_WS_PER_IP = Number(process.env.MAX_WS_PER_IP || 50);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client; no cookie-driven CSRF surface
  try {
    const u = new URL(origin);
    if (ALLOWED_ORIGINS.length) return ALLOWED_ORIGINS.includes(u.origin);
    return u.host === req.headers.host;
  } catch {
    return false;
  }
}

function validInk(msg) {
  if (!Number.isInteger(msg.slide) || msg.slide < 0 || msg.slide > 100000) return false;
  if (typeof msg.id !== 'string' || !msg.id || msg.id.length > 64) return false;
  if (typeof msg.color !== 'string' || !/^#[0-9a-f]{3,8}$/i.test(msg.color)) return false;
  if (typeof msg.width !== 'number' || !Number.isFinite(msg.width) || msg.width <= 0 || msg.width > 1)
    return false;
  if (!Array.isArray(msg.pts) || msg.pts.length > 2000) return false;
  for (const p of msg.pts) {
    if (!Array.isArray(p) || p.length !== 2) return false;
    const [x, y] = p;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < -2 || x > 3 || y < -2 || y > 3) return false;
  }
  return true;
}

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

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
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
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    };
    if (ext === '.html') {
      const policy = cspForHtml(data);
      if (policy) headers['Content-Security-Policy'] = policy;
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

// Strict page policy: inline <script> blocks are allowed by sha256 hash, so a
// new or edited inline script needs a matching hash or it won't run.
function inlineScriptHashes(html) {
  const hashes = [];
  const re = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (!m[1].trim()) continue;
    hashes.push(`'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  }
  return hashes;
}

function cspForHtml(data) {
  const scriptSrc = ["'self'", ...inlineScriptHashes(data.toString('utf8'))].join(' ');
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
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

function dirBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirBytes(p);
      else total += fs.statSync(p).size;
    } catch {
      // raced with a concurrent delete — ignore
    }
  }
  return total;
}

function userBytes(user) {
  return db
    .decksForUser(user.id)
    .reduce((sum, d) => sum + dirBytes(path.join(DECKS_DIR, user.handle, d.slug)), 0);
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
    code: deck.live ? deck.code : undefined,
    join_url: deck.live && deck.code ? `/j/${deck.code}/` : undefined,
  };
}

// public projection: join codes are shared out-of-band by the presenter,
// never handed to anonymous clients (e.g. /api/live.json)
function publicDeckJson(deck) {
  const d = deckJson(deck);
  delete d.code;
  delete d.join_url;
  return d;
}

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'deck';

// join codes: 6 chars, unambiguous alphabet, unique among currently-live decks
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function genCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!db.codeInUse(c)) return c;
  }
}

// pretty URL (/<handle>/<deck>/) is owner-only; viewers join via /j/<code>
function deckVisibleTo(deck, user) {
  if (!deck || deck.status !== 'ready') return false;
  return !!user && user.id === deck.user_id;
}

// --- sync state (per deck, keyed "handle/slug") ---

const clients = new Set();
const deckState = new Map(); // key -> { index, blank } (ink is ephemeral: relayed, never stored)

// seed from the deck row so a restart doesn't reset an in-progress talk.
// accepts a deck row or an existing key (message-handler callers use the key).
function stateFor(deckOrKey) {
  const key = typeof deckOrKey === 'string' ? deckOrKey : `${deckOrKey.handle}/${deckOrKey.slug}`;
  let s = deckState.get(key);
  if (!s) {
    const row = typeof deckOrKey === 'string' ? null : deckOrKey;
    s = { index: row ? row.slide_index || 0 : 0, blank: row ? !!row.blank : false };
    deckState.set(key, s);
  }
  return s;
}

function presenterOnline(key) {
  for (const c of clients) if (c.deck === key && c.isPresenter) return true;
  return false;
}

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
    const bb = busboy({
      headers: req.headers,
      limits: { fileSize: MAX_UPLOAD, files: 1, fields: 10, fieldSize: 1024, fieldNameSize: 100, parts: 20 },
    });
    const fields = {};
    let fileInfo = null;
    let fileWritten = null;
    let tooBig = false;

    bb.on('field', (name, val) => (fields[name] = val));
    bb.on('file', (name, stream, info) => {
      if (name !== 'file') return stream.resume();
      const tmp = path.join(os.tmpdir(), `lectern-up-${crypto.randomBytes(8).toString('hex')}`);
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
  if (head.readUInt32LE(0) === 0x04034b50) {
    // a zip is only a deck if it actually carries a presentation part
    const buf = fs.readFileSync(filePath);
    return buf.includes(Buffer.from('ppt/presentation.xml')) ? 'pptx' : 'zip';
  }
  return null;
}

// --- HTTP ---

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('bad request');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  let user = null;
  try {
    user = auth.currentUser(req);
  } catch {
    // malformed auth cookie — treat as signed out rather than failing the request
  }

  try {
    // ---- health ----
    if (url.pathname === '/healthz') {
      try {
        db.db.prepare('SELECT 1').get();
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 503, { ok: false });
      }
    }

    // ---- statics ----
    if (url.pathname.startsWith('/reveal/')) return serveFile(res, REVEAL, url.pathname.slice('/reveal'.length));
    if (url.pathname === '/qrcode.js') return serveFile(res, QRCODE_DIST, '/qrcode.js');
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
      const ip = clientIp(req);
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
      return sendJson(res, 200, db.liveDecks().map(publicDeckJson));
    }

    // public thumbnail for home cards: first slide of a live deck only
    const thumbMatch = url.pathname.match(/^\/api\/thumb\/(\d+)$/);
    if (thumbMatch) {
      const tdeck = db.getDeckById(Number(thumbMatch[1]));
      const first = tdeck && tdeck.live && tdeck.status === 'ready' ? slideFiles(tdeck)[0] : null;
      if (!first) return res.writeHead(404).end('not found');
      return serveFile(res, deckDir(tdeck), `/${first}`);
    }

    // ---- deck management API (owner only) ----
    const deckApi = url.pathname.match(/^\/api\/decks(?:\/(\d+)(?:\/(live|stop))?)?$/);
    if (deckApi) {
      if (!user) return sendJson(res, 401, { error: 'not logged in' });
      const [, idStr, action] = deckApi;

      if (req.method === 'POST' && !idStr) {
        // upload
        if (!auth.rateLimit(`upload:${user.id}`, 20, 3600e3)) return sendJson(res, 429, { error: 'too many uploads' });
        if (userBytes(user) >= MAX_USER_BYTES)
          return sendJson(res, 413, { error: 'storage quota reached — delete a deck first' });
        let up;
        try {
          up = await parseUpload(req);
        } catch (e) {
          return sendJson(res, 400, { error: e.message });
        }
        const kind = sniffKind(up.tmp);
        const ext = up.filename.toLowerCase();
        const extOk = (kind === 'pdf' && ext.endsWith('.pdf')) || (kind === 'pptx' && ext.endsWith('.pptx'));
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
          .then((count) => {
            const bytes = dirBytes(outDir);
            if (bytes > MAX_DECK_BYTES || userBytes(user) > MAX_USER_BYTES) {
              fs.rmSync(outDir, { recursive: true, force: true });
              throw new Error(`converted deck is too large (${Math.round(bytes / 1024 / 1024)} MB)`);
            }
            db.setDeckReady(deck.id, count);
          })
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
        const code = genCode();
        db.setDeckCode(deck.id, code);
        db.setDeckLive(deck.id, true);
        db.setDeckIndex(deck.id, 0);
        db.setDeckBlank(deck.id, 0);
        deckState.delete(key);
        return sendJson(res, 200, {
          ok: true,
          url: `/${deck.handle}/${deck.slug}/`,
          join_url: `/j/${code}/`,
          code,
        });
      }
      if (req.method === 'POST' && action === 'stop') {
        db.setDeckLive(deck.id, false);
        db.setDeckCode(deck.id, null);
        db.setDeckIndex(deck.id, 0);
        db.setDeckBlank(deck.id, 0);
        deckState.delete(key);
        endDeckForViewers(key);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'DELETE' && !action) {
        db.setDeckLive(deck.id, false);
        deckState.delete(key);
        endDeckForViewers(key);
        db.deleteDeck(deck.id);
        fs.rmSync(deckDir(deck), { recursive: true, force: true });
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // ---- viewer join: /j/<code>/... ----
    if (parts[0] === 'j' && parts.length >= 2) {
      const code = (parts[1] || '').toLowerCase();
      const jdeck = /^[a-z0-9]{6}$/.test(code) ? db.getDeckByCode(code) : null;
      if (!jdeck) {
        const ip = clientIp(req);
        if (!auth.rateLimit(`join:${ip}`, 30, 60e3))
          return sendHtml(res, 429, '<h1>429</h1><p>Too many tries — wait a minute.</p>');
        return sendHtml(
          res,
          404,
          '<h1>Invalid or expired code</h1><p>Check the code with the presenter, or see <a href="/">live presentations</a>.</p>'
        );
      }
      if (parts.length === 2) {
        if (!url.pathname.endsWith('/')) return redirect(res, url.pathname + '/');
        return serveFile(res, PUBLIC, '/index.html');
      }
      if (parts[2] === 'slides.json' && parts.length === 3) return sendJson(res, 200, slideFiles(jdeck));
      if (parts[2] === 'slides' && parts.length === 4 && IMG.test(parts[3]))
        return serveFile(res, deckDir(jdeck), `/${parts[3]}`);
      return sendHtml(res, 404, '<h1>404</h1>');
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

const wss = new WebSocketServer({
  server,
  path: '/sync',
  maxPayload: 64 * 1024,
  // reject cross-origin handshakes before the upgrade completes
  verifyClient: (info, done) => {
    if (!originAllowed(info.req)) return done(false, 403, 'origin not allowed');
    done(true);
  },
});
const wsPerIp = new Map();

wss.on('connection', (ws, req) => {
  if (!originAllowed(req)) return ws.close(4003, 'origin not allowed');

  const ip = clientIp(req);
  const open = wsPerIp.get(ip) || 0;
  if (open >= MAX_WS_PER_IP) return ws.close(4029, 'too many connections');
  wsPerIp.set(ip, open + 1);

  // release the per-IP slot even if we reject before the main close handler is wired
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const left = (wsPerIp.get(ip) || 1) - 1;
    if (left <= 0) wsPerIp.delete(ip);
    else wsPerIp.set(ip, left);
  };
  ws.on('close', release);
  ws.on('error', release);

  const params = new URL(req.url, 'http://localhost').searchParams;
  const codeParam = (params.get('code') || '').toLowerCase();
  const deckParam = params.get('deck') || '';
  let user = null;
  try {
    user = auth.currentUser(req);
  } catch {
    // malformed auth cookie — treat as signed out
  }

  let deck = null;
  if (codeParam) {
    // viewer joining with a session code
    deck = db.getDeckByCode(codeParam);
    if (!deck) return ws.close(4004, 'invalid or expired code');
  } else {
    // presenter channel: /<handle>/<slug> + session cookie + ownership
    const [handle, slug] = deckParam.split('/');
    deck = handle && slug ? db.getDeckByPath(handle, slug) : null;
    if (!deck || deck.status !== 'ready') return ws.close(4004, 'unknown deck');
    if (!user || user.id !== deck.user_id) return ws.close(4003, 'presenter must own the deck');
  }

  ws.deck = `${deck.handle}/${deck.slug}`;
  ws.isPresenter = !codeParam && !!user && user.id === deck.user_id;

  clients.add(ws);
  const st = stateFor(deck);
  send(ws, {
    type: 'state',
    index: st.index,
    blank: st.blank,
    presenter: presenterOnline(ws.deck),
    role: ws.isPresenter ? 'presenter' : 'viewer',
  });
  if (ws.isPresenter) broadcastDeck(ws.deck, { type: 'presenter', connected: true }, ws);
  broadcastViewerCount(ws.deck);

  ws.on('message', (data) => {
    if (!ws.isPresenter) return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const st = stateFor(ws.deck);
    if (msg.type === 'goto' && Number.isInteger(msg.index) && msg.index >= 0 && msg.index <= 100000) {
      st.index = msg.index;
      db.setDeckIndex(deck.id, msg.index);
      broadcastDeck(ws.deck, { type: 'goto', index: msg.index }, ws);
    } else if (msg.type === 'blank') {
      st.blank = !!msg.on;
      db.setDeckBlank(deck.id, st.blank);
      broadcastDeck(ws.deck, { type: 'blank', on: st.blank }, ws);
    } else if (msg.type === 'ink' && validInk(msg)) {
      // relay only — ink is ephemeral and kept client-side per slide
      broadcastDeck(ws.deck, { type: 'ink', id: msg.id, slide: msg.slide, color: msg.color, width: msg.width, pts: msg.pts, done: !!msg.done }, ws);
    } else if (msg.type === 'ink-clear' && Number.isInteger(msg.slide) && msg.slide >= -1 && msg.slide <= 100000) {
      broadcastDeck(ws.deck, { type: 'ink-clear', slide: msg.slide }, ws); // slide -1 = all slides
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (ws.isPresenter && !presenterOnline(ws.deck)) broadcastDeck(ws.deck, { type: 'presenter', connected: false });
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
  console.log(`lectern listening on :${PORT}`);
  console.log(`decks: ${DECKS_DIR}`);
  if (auth.PROVIDER === 'dev' || require('./email').PROVIDER === 'dev') {
    console.log('EMAIL_PROVIDER=dev — login codes are printed to this log');
  }
});
