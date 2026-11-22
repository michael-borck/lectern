const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lectern-test-'));
const DATA_DIR = path.join(TMP, 'data');
const DECKS_DIR = path.join(TMP, 'decks');
const DECK_DIR = path.join(DECKS_DIR, 'alice', 'demo');

// the app reads these at require time, so set them before requiring db
process.env.DATA_DIR = DATA_DIR;
process.env.DECKS_DIR = DECKS_DIR;

const db = require('../db');

// 1x1 PNG — tests seed slides directly and never invoke the converters
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
fs.mkdirSync(DECK_DIR, { recursive: true });
for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(DECK_DIR, `slide-0${i}.png`), PNG);

const USER = db.getOrCreateUser('alice@example.com');
const DECK = db.createDeck(USER.id, 'demo', 'Demo');
db.setDeckReady(DECK.id, 5);
db.setDeckCode(DECK.id, 'abcdef');
db.setDeckLive(DECK.id, true);
const TOKEN = db.createSession(USER.id);

let child = null;
let log = '';
let base = '';
let port = 0;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function inlineHash(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'expected an inline script');
  return `sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}`;
}

function waitFor(re, timeout = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (re.test(log)) return resolve();
      if (Date.now() - start > timeout) return reject(new Error(`timeout waiting for ${re}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function startServer(env = {}) {
  if (!port) port = 3400 + Math.floor(Math.random() * 800);
  log = '';
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR, DECKS_DIR, EMAIL_PROVIDER: 'dev', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  await waitFor(/listening on :/);
  base = `http://127.0.0.1:${port}`;
}

function stopServer() {
  return new Promise((resolve) => {
    if (!child) return resolve();
    const c = child;
    child = null;
    c.once('exit', resolve);
    c.kill('SIGKILL');
  });
}

function openSync(query, cookie) {
  const headers = { Origin: base };
  if (cookie) headers.Cookie = `lectern_session=${cookie}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/sync${query}`, { headers });
  const messages = [];
  const state = new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error('timeout waiting for state')), 5000).unref();
    ws.on('message', (m) => {
      let j;
      try {
        j = JSON.parse(m);
      } catch {
        return;
      }
      messages.push(j);
      if (j.type === 'state') resolve(j);
    });
    ws.on('error', reject);
  });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, state, opened, messages };
}

before(async () => {
  await startServer();
});

after(async () => {
  await stopServer();
  fs.rmSync(TMP, { recursive: true, force: true });
  db.db.close();
});

test('security headers are set on responses', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('HTML pages use a hash-based script CSP', async () => {
  const pages = [
    ['/login', {}],
    ['/dashboard', { cookie: `lectern_session=${TOKEN}` }],
    ['/', {}],
    ['/j/abcdef/', {}],
  ];
  for (const [page, headers] of pages) {
    const r = await fetch(`${base}${page}`, { headers, redirect: 'manual' });
    const csp = r.headers.get('content-security-policy');
    assert.ok(csp, `missing CSP for ${page}`);
    assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), `unsafe-inline script for ${page}`);
    assert.match(csp, /frame-ancestors 'none'/);
  }

  const login = fs.readFileSync(path.join(ROOT, 'public/login.html'), 'utf8');
  let csp = (await fetch(`${base}/login`)).headers.get('content-security-policy');
  assert.ok(csp.includes(`'${inlineHash(login)}'`), 'login inline script hash missing');

  const decks = fs.readFileSync(path.join(ROOT, 'public/decks.html'), 'utf8');
  csp = (await fetch(`${base}/`)).headers.get('content-security-policy');
  assert.ok(csp.includes(`'${inlineHash(decks)}'`), 'decks inline script hash missing');

  csp = (await fetch(`${base}/j/abcdef/`)).headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'(?:;|$)/, 'viewer page should not need script hashes');
});

test('/healthz reports ok', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('a malformed cookie does not crash the request or the process', async () => {
  let r = await fetch(`${base}/`, { headers: { cookie: 'lectern_session=%' } });
  assert.equal(r.status, 200);
  r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
});

test('live.json never exposes join codes', async () => {
  const decks = await (await fetch(`${base}/api/live.json`)).json();
  assert.equal(decks.length, 1);
  assert.ok(!('code' in decks[0]), 'code leaked');
  assert.ok(!('join_url' in decks[0]), 'join_url leaked');
  assert.equal(decks[0].handle, 'alice');
});

test('login codes are single-use and wrong codes are rejected', async () => {
  const email = 'bob@example.com';
  const mark = log.length;
  let r = await fetch(`${base}/api/auth/request-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  assert.equal(r.status, 200);

  await waitFor(new RegExp(`code for ${email}: \\d{6}`), 5000);
  const code = log.slice(mark).match(/code for .*?: (\d{6})/)[1];

  const wrong = code === '000000' ? '111111' : '000000';
  r = await fetch(`${base}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code: wrong }),
  });
  assert.equal(r.status, 401);

  r = await fetch(`${base}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });
  assert.equal(r.status, 200);
  const cookie = r.headers.getSetCookie()[0].split(';')[0];
  assert.match(cookie, /^lectern_session=[0-9a-f]{64}$/);

  r = await fetch(`${base}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });
  assert.equal(r.status, 401, 'code should be consumed after first use');
});

test('login page rejects protocol-relative redirect targets', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/login.html'), 'utf8');
  assert.match(html, /!next\.startsWith\('\/\/'\)/);
  assert.match(html, /!next\.startsWith\('\/\\\\'\)/);
});

test('websocket rejects cross-origin handshakes', async () => {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sync?code=abcdef`, {
      headers: { Origin: 'http://evil.example' },
    });
    ws.on('unexpected-response', (req, res) => {
      try {
        assert.equal(res.statusCode, 403);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
    ws.on('open', () => {
      ws.terminate();
      reject(new Error('cross-origin handshake was accepted'));
    });
    ws.on('error', () => {});
  });
});

test('oversized websocket frames are closed', async () => {
  const { ws, opened } = openSync('?code=abcdef');
  await opened;
  const code = await new Promise((resolve) => {
    ws.on('close', resolve);
    ws.send('x'.repeat(200 * 1024));
    setTimeout(() => resolve(-1), 3000).unref();
  });
  assert.equal(code, 1009);
});

test('invalid ink frames are dropped, valid ones relayed', async () => {
  const viewer = openSync('?code=abcdef');
  await viewer.state;
  const presenter = openSync('?deck=alice/demo', TOKEN);
  await presenter.state;

  presenter.ws.send(
    JSON.stringify({ type: 'ink', id: 'badcolor', slide: 0, color: 'javascript:alert(1)', width: 0.004, pts: [[0.1, 0.1]] })
  );
  presenter.ws.send(
    JSON.stringify({ type: 'ink', id: 'badpt', slide: 0, color: '#ff3b30', width: 0.004, pts: [['x', 0.1]] })
  );
  presenter.ws.send(
    JSON.stringify({ type: 'ink', id: 'good', slide: 0, color: '#ff3b30', width: 0.004, pts: [[0.1, 0.1], [0.2, 0.2]] })
  );

  await delay(400);
  const ids = viewer.messages.filter((m) => m.type === 'ink').map((m) => m.id);
  assert.deepEqual(ids, ['good']);

  viewer.ws.terminate();
  presenter.ws.terminate();
});

test('presenter position survives a server restart', async () => {
  const presenter = openSync('?deck=alice/demo', TOKEN);
  await presenter.opened;
  presenter.ws.send(JSON.stringify({ type: 'goto', index: 3 }));
  await delay(300);
  presenter.ws.terminate();

  await stopServer();
  await startServer();

  const viewer = openSync('?code=abcdef');
  const state = await viewer.state;
  assert.equal(state.index, 3);
  viewer.ws.terminate();
});

test('EMAIL_PROVIDER=dev is refused under NODE_ENV=production', () => {
  const r = spawnSync(process.execPath, ['-e', "require('./email')"], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', EMAIL_PROVIDER: 'dev' },
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not allowed/);
});
