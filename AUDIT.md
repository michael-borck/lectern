# lectern — security & reliability audit

Status: in progress. This file is the tracking document for the audit findings and
their remediation. Tick items as they land; keep the severity ordering.

Audit basis: static review of `server.js`, `db.js`, `auth.js`, `email.js`,
`convert.js`, `public/*`, and the deploy files, plus `npm audit` and `node --check`.
There is no app-level test suite yet.

Severity: **H** = high, **M** = medium, **L** = low / hardening.

## Findings & remediation

### H1 — Malformed cookie crashes the process (unauthenticated DoS)
`auth.js:parseCookies` called `decodeURIComponent` unguarded; `server.js` read the
session before its `try` and again in the WebSocket handler. A cookie like
`x=%` produced an unhandled rejection / uncaught exception and exited Node.

- [x] Guarded cookie decoding per part (`auth.js`).
- [x] `try/catch` around URL parsing and `currentUser` in HTTP and WS paths.
- [x] Accept: `Cookie: x=%` returns a normal response and the process survives.

### H2 — Join codes leaked by `/api/live.json`
The public live-decks feed serialized decks with `code` and `join_url`, defeating
the out-of-band join-code gate.

- [x] Added `publicDeckJson()` that omits `code`/`join_url`.
- [x] `/api/live.json` now uses it; owner `/api/me` still includes them.
- [x] Accept: anonymous `GET /api/live.json` contains no `code` or `join_url`.

### H3 — Vulnerable `nodemailer` (GHSA set)
`nodemailer ^9.0.5` was flagged high by `npm audit`.

- [x] Upgraded to `^10.6.1`; `npm audit --omit=dev` reports 0 vulnerabilities.

### M1 — Rate-limit keys spoofable; bucket map grows without bound
IP rate-limit keys trusted `X-Forwarded-For`; `auth.buckets` was never pruned, so
unique spoofed keys exhausted memory.

- [x] `clientIp(req)` helper: `remoteAddress` unless `TRUST_PROXY=true`, then the
      first `X-Forwarded-For` hop.
- [x] Bounded bucket map with periodic sweep + hard cap (`MAX_BUCKETS`).
- [x] Accept: spoofed XFF does not mint fresh buckets; map size stays bounded.

### M2 — WebSocket has no payload cap, origin check, or connection limit
`ws` defaulted to 100 MB messages and accepted any origin.

- [x] `maxPayload` on `WebSocketServer`.
- [x] Reject cross-origin handshakes (Origin host must match Host).
- [x] Per-IP connection cap.
- [x] Accept: oversized frame closes; cross-origin handshake refused.

### M3 — Untrusted documents to LibreOffice/poppler; no storage quota
Magic-only PPTX check accepted any zip; no decompressed/output size or per-user
quota.

- [x] Require `ppt/presentation.xml` inside the zip.
- [x] Per-user storage quota (`MAX_USER_BYTES`) before accepting an upload.
- [x] Post-conversion deck size cap (`MAX_DECK_BYTES`).
- [x] busboy field/fieldName/fieldSize/parts limits.
- [x] Document container memory limit.
- [x] Accept: non-PPTX zip rejected; over-quota upload rejected; oversized output removed.

### M4 — Presenter loses position after a server restart
`deckState` (slide index + blank) was in-memory; reconnect after restart reset the
presenter to slide 1 and rebroadcast it.

- [x] Persist `slide_index` (and `blank`) on `decks`, migrate like `code`.
- [x] Initialize `deckState` from the row; update on `goto`/`blank`.
- [x] Accept: restart mid-talk, reconnect resumes the same slide.

### M5 — Container and systemd service run as root
LibreOffice converting untrusted files as root is the highest-value target.

- [x] Dockerfile: create non-root user, own `presentations`/`data`, `USER`.
- [x] `deploy/lectern.service`: `User=lectern` with matching ownership.
- [x] Document host-side `chown` for bind mounts.

### L1 — Small correctness fixes
- [x] Add `j` to `HANDLE_RESERVED` (`db.js`) so join route can't be shadowed.
- [x] `deckState.delete(key)` on deck `DELETE`.
- [x] Validate relayed `ink` fields (numeric slide/width, hex color, point shapes).

### L2 — Response headers
- [ ] `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`,
      `X-Frame-Options: DENY` (or `frame-ancestors 'none'`).
- [ ] CSP with nonces/hashes for the inline scripts (follow-up).
- [ ] HSTS at the proxy.

### L3 — Auth & ops hygiene
- [ ] `crypto.timingSafeEqual` for the login-code hash compare.
- [ ] Fail closed when `NODE_ENV=production` and `EMAIL_PROVIDER=dev`.
- [ ] `/healthz` route + compose healthcheck.
- [ ] Remove dev-provider code logging from production paths.

### L4 — Repo hygiene
- [ ] `package.json` license → MIT to match `LICENSE`.
- [x] README (setup, env, deploy).
- [ ] `npm test` + `node:test` integration suite (bad cookie, live.json projection,
      open redirect, single-use code).
- [ ] GitHub Actions: `node --check`, `npm ci`, `npm audit --omit=dev`.
- [x] Merge the one-commit-behind upstream (MIT license) — merged as 6777a98.

### L5 — Open redirect after sign-in
`next` accepted `//evil.com` and `/\evil.com`.

- [x] Reject `//` and `/\` prefixes (`login.html`).

## Phase plan

- Phase 1 (done): M1, M2, M3, M5 — availability, abuse, and container safety.
- Phase 2 (done): M4, L1 — correctness.
- Phase 3 (next): L2, L3, L4 — hardening and hygiene.
