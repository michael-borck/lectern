// db.js — SQLite storage: users, login codes, sessions, decks.
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// renamed from "present" — adopt the old database file if it's still there
const DB_PATH = path.join(DATA_DIR, 'lectern.db');
const LEGACY_DB = path.join(DATA_DIR, 'present.db');
if (!fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB)) {
  fs.renameSync(LEGACY_DB, DB_PATH);
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(LEGACY_DB + ext)) fs.renameSync(LEGACY_DB + ext, DB_PATH + ext);
  }
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY,
    email      TEXT NOT NULL UNIQUE,
    handle     TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS login_codes (
    email      TEXT PRIMARY KEY,
    code_hash  TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS decks (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug        TEXT NOT NULL,
    title       TEXT NOT NULL,
    slide_count INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'converting',  -- converting | ready | error
    error       TEXT,
    live        INTEGER NOT NULL DEFAULT 0,
    code        TEXT,
    slide_index INTEGER NOT NULL DEFAULT 0,
    blank       INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, slug)
  );
`);

// join-code + presenter-position columns (added after initial release — migrate in place)
try {
  db.prepare('SELECT code FROM decks LIMIT 0');
} catch {
  db.exec('ALTER TABLE decks ADD COLUMN code TEXT');
}
try {
  db.prepare('SELECT slide_index FROM decks LIMIT 0');
} catch {
  db.exec('ALTER TABLE decks ADD COLUMN slide_index INTEGER NOT NULL DEFAULT 0');
}
try {
  db.prepare('SELECT blank FROM decks LIMIT 0');
} catch {
  db.exec('ALTER TABLE decks ADD COLUMN blank INTEGER NOT NULL DEFAULT 0');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// --- users ---

const qUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const qUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const qHandleTaken = db.prepare('SELECT 1 FROM users WHERE handle = ?');
const qInsertUser = db.prepare('INSERT INTO users (email, handle) VALUES (?, ?)');

const HANDLE_RESERVED = new Set([
  'j', 'reveal', 'sync', 'login', 'dashboard', 'api', 'decks.json', 'live.json',
  'viewer.js', 'style.css', 'qrcode.js', 'dashboard.js', 'favicon.ico',
]);

function handleFromEmail(email) {
  const local = email.split('@')[0].toLowerCase();
  let base = local.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'user';
  if (HANDLE_RESERVED.has(base)) base = `${base}-user`;
  let handle = base;
  for (let i = 2; qHandleTaken.get(handle); i++) handle = `${base}-${i}`;
  return handle;
}

function getOrCreateUser(email) {
  let user = qUserByEmail.get(email);
  if (!user) {
    const handle = handleFromEmail(email);
    const info = qInsertUser.run(email, handle);
    user = qUserById.get(info.lastInsertRowid);
  }
  return user;
}

// --- login codes ---

const qSetCode = db.prepare(`
  INSERT INTO login_codes (email, code_hash, expires_at, attempts)
  VALUES (?, ?, ?, 0)
  ON CONFLICT (email) DO UPDATE SET code_hash = excluded.code_hash,
    expires_at = excluded.expires_at, attempts = 0
`);
const qGetCode = db.prepare('SELECT * FROM login_codes WHERE email = ?');
const qBumpAttempts = db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?');
const qClearCode = db.prepare('DELETE FROM login_codes WHERE email = ?');

const CODE_TTL_MS = 10 * 60 * 1000;

function setLoginCode(email, code) {
  qSetCode.run(email, sha256(code), Date.now() + CODE_TTL_MS);
}

// returns true/false; deletes the code on success or after 5 failures
function checkLoginCode(email, code) {
  const row = qGetCode.get(email);
  if (!row) return false;
  if (Date.now() > row.expires_at) {
    qClearCode.run(email);
    return false;
  }
  if (row.attempts >= 5) {
    qClearCode.run(email);
    return false;
  }
  if (row.code_hash === sha256(code)) {
    qClearCode.run(email);
    return true;
  }
  qBumpAttempts.run(email);
  return false;
}

// --- sessions ---

const qSetSession = db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)');
const qGetSession = db.prepare(`
  SELECT s.token_hash, s.expires_at, u.id AS user_id, u.email, u.handle
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ?
`);
const qDeleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  qSetSession.run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
  return token;
}

function userForToken(token) {
  if (!token) return null;
  const row = qGetSession.get(sha256(token));
  if (!row) return null;
  if (Date.now() > row.expires_at) {
    qDeleteSession.run(row.token_hash);
    return null;
  }
  return { id: row.user_id, email: row.email, handle: row.handle };
}

function deleteSession(token) {
  if (token) qDeleteSession.run(sha256(token));
}

// --- decks ---

const qInsertDeck = db.prepare('INSERT INTO decks (user_id, slug, title) VALUES (?, ?, ?)');
const qDeckById = db.prepare(`
  SELECT d.*, u.handle FROM decks d JOIN users u ON u.id = d.user_id WHERE d.id = ?
`);
const qDeckByPath = db.prepare(`
  SELECT d.*, u.handle FROM decks d JOIN users u ON u.id = d.user_id
  WHERE u.handle = ? AND d.slug = ?
`);
const qDecksForUser = db.prepare(`
  SELECT d.*, u.handle FROM decks d JOIN users u ON u.id = d.user_id
  WHERE d.user_id = ? ORDER BY d.created_at DESC
`);
const qDeckSlugTaken = db.prepare(`
  SELECT 1 FROM decks d JOIN users u ON u.id = d.user_id WHERE u.handle = ? AND d.slug = ?
`);
const qSetDeckReady = db.prepare("UPDATE decks SET status = 'ready', slide_count = ?, error = NULL WHERE id = ?");
const qSetDeckError = db.prepare("UPDATE decks SET status = 'error', error = ? WHERE id = ?");
const qSetDeckLive = db.prepare('UPDATE decks SET live = ? WHERE id = ?');
const qSetDeckCode = db.prepare('UPDATE decks SET code = ? WHERE id = ?');
const qSetDeckIndex = db.prepare('UPDATE decks SET slide_index = ? WHERE id = ?');
const qSetDeckBlank = db.prepare('UPDATE decks SET blank = ? WHERE id = ?');
const qDeckByCode = db.prepare(`
  SELECT d.*, u.handle FROM decks d JOIN users u ON u.id = d.user_id
  WHERE d.code = ? AND d.live = 1 AND d.status = 'ready'
`);
const qCodeInUse = db.prepare('SELECT 1 FROM decks WHERE live = 1 AND code = ?');
const qDeleteDeck = db.prepare('DELETE FROM decks WHERE id = ?');
const qLiveDecks = db.prepare(`
  SELECT d.*, u.handle
  FROM decks d JOIN users u ON u.id = d.user_id
  WHERE d.live = 1 AND d.status = 'ready'
  ORDER BY d.created_at DESC
`);

function createDeck(userId, slug, title) {
  const info = qInsertDeck.run(userId, slug, title);
  return qDeckById.get(info.lastInsertRowid);
}

function deckSlugFree(handle, slug) {
  return !qDeckSlugTaken.get(handle, slug);
}

module.exports = {
  db,
  getOrCreateUser,
  setLoginCode,
  checkLoginCode,
  createSession,
  userForToken,
  deleteSession,
  createDeck,
  deckSlugFree,
  getDeckById: (id) => qDeckById.get(id),
  getDeckByPath: (handle, slug) => qDeckByPath.get(handle, slug),
  decksForUser: (userId) => qDecksForUser.all(userId),
  setDeckReady: (id, count) => qSetDeckReady.run(count, id),
  setDeckError: (id, error) => qSetDeckError.run(error, id),
  setDeckLive: (id, live) => qSetDeckLive.run(live ? 1 : 0, id),
  setDeckCode: (id, code) => qSetDeckCode.run(code, id),
  setDeckIndex: (id, index) => qSetDeckIndex.run(index, id),
  setDeckBlank: (id, blank) => qSetDeckBlank.run(blank ? 1 : 0, id),
  getDeckByCode: (code) => qDeckByCode.get(code),
  codeInUse: (code) => !!qCodeInUse.get(code),
  deleteDeck: (id) => qDeleteDeck.run(id),
  liveDecks: () => qLiveDecks.all(),
};
