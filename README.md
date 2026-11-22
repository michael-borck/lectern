# lectern

Synced slide sharing over a plain URL. A presenter uploads a PDF/PPTX, the server
converts it to slide images, and every viewer's screen follows the presenter in
real time. Viewers join with a short code (or QR) from the presenter view.

- `/` — live decks + join box
- `/login`, `/dashboard` — passwordless email-code sign-in, upload/present/stop/delete
- `/j/<code>/` — viewer URL
- `/<handle>/<deck>/?present` — presenter view (owner only)

Docs: [AUDIT.md](./AUDIT.md) tracks the security/reliability audit and remediation.

## Run

```sh
npm ci
npm start                 # http://localhost:3000
```

Requires `pdftoppm` (poppler) for PDFs and `soffice` (LibreOffice) for PPTX. The
Dockerfile installs both. State lives in `data/` (SQLite) and `presentations/`
(slide images).

## Configuration

All settings are environment variables; `.env.example` lists them.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | SQLite location |
| `DECKS_DIR` | `./presentations` | slide image root |
| `EMAIL_PROVIDER` | `dev` | `dev` (log codes), `smtp`, or `resend` |
| `EMAIL_FROM` | `lectern@localhost` | sender for smtp/resend |
| `SMTP_HOST/PORT/USER/PASS` | — | when `EMAIL_PROVIDER=smtp` |
| `RESEND_API_KEY` | — | when `EMAIL_PROVIDER=resend` |
| `ALLOWED_DOMAINS` | empty (anyone) | comma-separated email domains allowed to sign in |
| `TRUST_PROXY` | `false` | whether to trust `X-Forwarded-For` (see below) |
| `ALLOWED_ORIGINS` | empty | comma-separated WS origins; empty = Origin host must match Host |
| `MAX_WS_PER_IP` | `50` | concurrent WebSocket connections per IP |
| `MAX_USER_BYTES` | `524288000` (500 MB) | stored slide bytes per user |
| `MAX_DECK_BYTES` | `209715200` (200 MB) | converted slide bytes per deck |
| `MAX_RATE_BUCKETS` | `50000` | in-process rate-limit bucket cap |
| `MAX_UPLOAD` | `50 MB` (code constant) | upload size limit |

### `TRUST_PROXY` in detail

This controls how the server determines a client's IP for rate limiting.

- **`false` (default, recommended unless behind a proxy you control)**
  The client IP is the TCP peer (`req.socket.remoteAddress`). `X-Forwarded-For`
  is ignored, so clients cannot spoof a new IP per request. If a reverse proxy
  sits in front, every request appears to come from the proxy's IP, so per-IP
  limits become effectively global for all viewers.
- **`true`**
  The client IP is the first entry of `X-Forwarded-For`. This restores per-client
  limits behind a proxy, but **only set it when the app port is unreachable
  except through that proxy** (loopback bind, host firewall, or a private Docker
  network). If the port is directly reachable from the internet, an attacker can
  send any `X-Forwarded-For` value and bypass per-IP limits.

Truthy values are `1`, `true`, `yes` (case-insensitive). The login-code per-email
bucket is independent of the IP and works either way.

Pick by topology:

| Topology | `TRUST_PROXY` |
| --- | --- |
| No proxy, direct access, local dev | `false` |
| Caddy/nginx on the same host, app bound to `127.0.0.1` | `true` |
| Proxy in another container/host reaching `:3100` | `true` **only if** the host firewall restricts `3100` to that proxy; otherwise `false` |
| App port publicly exposed alongside a proxy | `false` |

## Deploy

Docker (see `docker-compose.yml`, `deploy/Caddyfile`):

```sh
chown -R 1000:1000 presentations data   # the container runs as uid 1000
docker compose up -d --build
```

The container runs unprivileged because LibreOffice converts untrusted uploads.
Put TLS in front (Caddy) and keep `3100` private.

Bare metal: `deploy/lectern.service` runs as the `lectern` user; create it and
`chown` the app directory first (instructions in the unit file).
