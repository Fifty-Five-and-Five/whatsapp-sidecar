# whatsapp-sidecar

A tiny Node service that pairs as a WhatsApp linked device (via [Baileys](https://github.com/WhiskeySockets/Baileys)) and exposes its messages over a small HTTP + SSE API. Build a chat panel, a desktop floater, a CLI, a bot — all consuming the same sidecar.

Designed to run as a Docker container. Persists Baileys auth state + a rolling message buffer + downloaded media to a single named volume.

## Why a sidecar

WhatsApp Web needs a long-lived WebSocket to the WhatsApp servers. A Next.js / Rails / Flask app can't reliably hold one open per user across request lifecycles. This sidecar does — once, behind your app — and your app talks to it over HTTP. Multiple host apps can share one sidecar.

## Features

- Per-user pairing (multi-device). Each end user pairs their own phone; each session has its own Baileys auth dir.
- Full message history sync on first pair (Baileys `syncFullHistory: true`).
- On-demand backfill via `sock.fetchMessageHistory()`.
- Media (image / video / audio / document / sticker) downloads + persists to disk; served via authenticated endpoint.
- Quoted replies (in + out) with denormalised previews.
- Reactions (in + out) using `sock.sendMessage(jid, { react: { text, key } })`.
- Sender-name resolution from pushName + contacts + env overrides (handles WhatsApp's opaque `@lid` JIDs).
- SSE event stream: `message`, `reaction`, `status`.
- Bearer-token auth on every endpoint except `/health` and `/qr` (first-pair friendly).
- Internal-only deployment assumed — designed to live on the same Docker network as the consuming app.

## Quickstart

```bash
git clone https://github.com/Fifty-Five-and-Five/whatsapp-sidecar.git
cd whatsapp-sidecar

# 1. Generate a bearer token your app and the sidecar will share
echo "SIDECAR_TOKEN=$(openssl rand -hex 32)" > .env

# 2. Pick the host-app user-id that owns the primary pairing (your phone owner)
echo "WHATSAPP_PRIMARY_USER_ID=primary" >> .env

# 3. (Optional) Pin to a single group. Leave blank for first boot; the sidecar
#    will log every participating group's JID so you can pick one.
echo "WHATSAPP_GROUP_JID=" >> .env

# 4. Launch
docker compose up -d

# 5. First pair — your phone owner scans the QR
docker exec whatsapp-sidecar wget -qO- http://127.0.0.1:3030/sessions/primary/qr > qr.png
open qr.png   # macOS — scan with WhatsApp → Settings → Linked Devices

# 6. Status check
docker exec whatsapp-sidecar wget -qO- http://127.0.0.1:3030/health
```

## Configuration

| Env | Purpose |
|---|---|
| `SIDECAR_TOKEN` | Bearer token. Every authenticated endpoint requires `Authorization: Bearer $SIDECAR_TOKEN`. **Required.** |
| `WHATSAPP_PRIMARY_USER_ID` | Identifier for the phone owner's session. Becomes the `<userId>` in `/sessions/<userId>/*`. Any string of `[A-Za-z0-9_.-]{1,64}` — typically your app's user-id format. **Required.** |
| `WHATSAPP_GROUP_JID` | Single WhatsApp group JID to scope the panel to (e.g. `1203...@g.us`). Optional — leave blank and the sidecar logs every participating group on connect so you can choose. |
| `WHATSAPP_NAME_OVERRIDES` | Comma-separated `jid:Display Name,jid:Display Name`. Resolves history senders whose pushName isn't set. |
| `WHATSAPP_PRIMARY_USER_ID` | See above. |
| `PORT` | HTTP port. Defaults to `3030`. |
| `LOG_LEVEL` | Pino level. Defaults to `info`. |
| `SESSION_DIR` | Where to persist Baileys auth + buffer + media. Defaults to `/session`. Bind to a docker volume. |
| `MEDIA_CAP_BYTES` | Max bytes of downloaded media on disk before oldest-first eviction. Defaults to 500MB. |

## HTTP API

All endpoints (except `/health` and `/qr*`) require `Authorization: Bearer $SIDECAR_TOKEN`.

### Status

- `GET /health` → `{ status, groupJid, groupName, self }` for the primary session.

### Pairing

- `GET /sessions` → `{ sessions: [{ userId, isPrimary, status, ... }] }`.
- `GET /sessions/:userId/health` → status for one user's session.
- `GET /sessions/:userId/qr` → PNG of the current QR (only when `status === 'qr'`). No auth on this endpoint so the host app can serve it directly.
- `POST /sessions/:userId` → initialise a new session. Returns the session record. Status will be `connecting` then `qr`.
- `DELETE /sessions/:userId` → wipe `/session/baileys/<userId>/` and disconnect.

### Messages

- `GET /messages?since=<isoTs>&limit=<n>` → rolling buffer (cap 5000). `since` filters; `limit` returns the most recent N within that filter.
- `POST /messages` body `{ body, senderName?, via?, quoted? }` → send via the user identified by `via` (defaults to primary). Returns the sent message DTO. 412 if the `via` user hasn't paired yet.
- `GET /events` → SSE stream. Event types: `status`, `message`, `reaction`. Heartbeat comments every 25s.

### Reactions

- `POST /reactions` body `{ messageId, emoji, via?, originalSenderJid? }` → react via the `via` user's session. Empty `emoji` clears.

### History backfill

- `GET /history/anchor` → `{ anchor: { key, timestamp } | null }`.
- `POST /history/fetch` body `{ count? }` → triggers `sock.fetchMessageHistory()` from the oldest known message. Older messages arrive via `messaging-history.set` and flow through the `/events` stream.

### Media

- `GET /media/:id` → bytes of the downloaded media for that WA message id, with the right `Content-Type`. 404 if not downloaded.

## Message DTO

```ts
{
  id: string;             // WhatsApp message id
  groupJid: string;
  senderJid: string;      // e.g. "447843...@s.whatsapp.net" or "...@lid"
  senderName: string;     // resolved via pushName + contacts + env overrides
  body: string;
  direction: 'in' | 'out';
  timestamp: string;      // ISO
  media: {
    type: 'image' | 'video' | 'audio' | 'document' | 'sticker';
    mime: string | null;
    size: number | null;
    width: number | null;
    height: number | null;
  } | null;
  quoted: {
    id: string;
    senderName: string;
    bodyPreview: string;
  } | null;
}
```

## Architecture

```
                  ┌──────────────────────┐
WhatsApp ◀──────▶│  Baileys WebSocket    │
phone (linked    │  (long-lived, one     │
device per user) │   per paired user)    │
                  └──────────┬───────────┘
                             │
                  ┌──────────▼───────────┐
                  │  SessionManager       │
                  │  Map<userId, Client>  │
                  │  + shared buffer      │
                  │  + anchor + media     │
                  └──────────┬───────────┘
                             │  HTTP + SSE
                  ┌──────────▼───────────┐         ┌────────────┐
                  │  Host app(s)          │────────▶│  Your DB   │
                  │  (Next.js, Tauri,     │         │ (optional) │
                  │   CLI, …)             │         └────────────┘
                  └──────────────────────┘
```

## Limitations

- **History before pairing is unreachable.** WhatsApp uses Signal's per-device key fan-out; messages sent before a device was linked were never encrypted for that device, so they can't be decrypted. Solution: full re-pair triggers a phone-driven history backfill on first connect.
- **Linked device cap:** WhatsApp allows max 4 linked devices per account. Multi-user pairing burns slots — keep an eye on this.
- **Baileys is unofficial.** Account-ban risk exists. The library is widely used and stable but you're using WhatsApp's web protocol without a formal license.

## Deployment

The `docker-compose.yml` in this repo builds locally. For production, prefer the GHCR image: every push to `main` builds and publishes to `ghcr.io/fifty-five-and-five/whatsapp-sidecar:latest`. Change `build: .` to `image: ghcr.io/fifty-five-and-five/whatsapp-sidecar:latest` in your compose file.

## License

MIT
