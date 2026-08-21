#!/usr/bin/env node
// import-deck.js — adopt an existing presentations/<folder> into a user's account.
// usage: node scripts/import-deck.js <email> <folder-name> [title]
//   e.g. node scripts/import-deck.js me@uni.edu udl-lens "UDL Lens Showcase"
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DECKS_DIR = process.env.DECKS_DIR || path.join(ROOT, 'presentations');
const db = require('../db');

const [, , email, folder, titleArg] = process.argv;
if (!email || !folder) {
  console.error('usage: node scripts/import-deck.js <email> <folder-name> [title]');
  process.exit(1);
}

const src = path.join(DECKS_DIR, folder);
if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
  console.error(`no such folder: ${src}`);
  process.exit(1);
}

const user = db.getOrCreateUser(email.toLowerCase());
const base = path.basename(folder); // folder may be nested (handle/slug) already
let slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'deck';
for (let i = 2; !db.deckSlugFree(user.handle, slug); i++) slug = `${slug}-${i}`;

const dest = path.join(DECKS_DIR, user.handle, slug);
if (src !== dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
}

const slides = fs.readdirSync(dest).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).length;
if (slides === 0) {
  console.error(`no slide images found in ${dest}`);
  process.exit(1);
}

const deck = db.createDeck(user.id, slug, titleArg || folder);
db.setDeckReady(deck.id, slides);
console.log(`imported: ${folder} -> /${user.handle}/${slug}/ (${slides} slides, owner ${user.email})`);
