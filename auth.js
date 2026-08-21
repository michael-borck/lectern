// auth.js — passwordless email-code auth, session cookies, rate limits.
const crypto = require('crypto');
const db = require('./db');
const email = require('./email');

const COOKIE = 'present_session';

const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

function domainAllowed(emailAddr) {
  if (ALLOWED_DOMAINS.length === 0) return true;
  const domain = emailAddr.split('@')[1]?.toLowerCase();
  return ALLOWED_DOMAINS.includes(domain);
}

// --- cookies ---

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionToken(req) {
  return parseCookies(req)[COOKIE] || null;
}

function currentUser(req) {
  return db.userForToken(sessionToken(req));
}

function isSecure(req) {
  return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
}

function setSessionCookie(req, res, token) {
  const attrs = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${30 * 24 * 3600}`,
  ];
  if (isSecure(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(req, res) {
  const attrs = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecure(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

// --- login flow ---

async function requestCode(emailAddr) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.setLoginCode(emailAddr, code);
  await email.sendCode(emailAddr, code);
}

// returns user on success, null on failure
function verifyCode(emailAddr, code) {
  if (!db.checkLoginCode(emailAddr, code)) return null;
  return db.getOrCreateUser(emailAddr);
}

// --- rate limiting (in-memory, per key) ---

const buckets = new Map();
// hit(key, max, windowMs) -> true if allowed
function hit(key, max, windowMs) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const arr = (buckets.get(key) || []).filter((t) => t > cutoff);
  if (arr.length >= max) {
    buckets.set(key, arr);
    return false;
  }
  arr.push(now);
  buckets.set(key, arr);
  return true;
}

module.exports = {
  domainAllowed,
  requestCode,
  verifyCode,
  currentUser,
  sessionToken,
  setSessionCookie,
  clearSessionCookie,
  rateLimit: hit,
};
