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

---

## Reference UI: the earl-tasks panel

A complete working consumer, in production at `tasks.earl.partners`. ~1200 LOC for the React component plus 9 route handlers plus 2 DB tables. The intent of this section is to give you a head start when you build the next UI on top of the sidecar — a desktop floater, a different app, a CLI, whatever.

### Stack

- Next.js 16 App Router (React 19)
- Drizzle ORM + Postgres 16
- Tailwind v4 (CSS-first config)
- Phosphor Icons (`@phosphor-icons/react/dist/ssr`)
- Internal OIDC + magic-link auth (replace with your own)
- One Docker container next to the sidecar on the same Coolify network

### Three integration points to swap

When porting the panel into a new app, exactly three things change:

1. **Auth.** earl-tasks has `getCurrentUser(): Promise<{ id, email, name } | null>` in `src/lib/auth.ts`. Every API route calls it and 401s if null. Replace with your app's session lookup.
2. **DB.** earl-tasks uses a `db` singleton from `src/lib/db/index.ts` (Drizzle wrapping `postgres-js`). Replace with whichever ORM/driver your app uses, and adjust the schema fragments below to match.
3. **Theme tokens.** The panel hardcodes a few CSS custom properties (`var(--earl-blue-fg)`, `var(--earl-blue-border)`, `var(--earl-blue-muted)`, `var(--earl-blue-bg)`, `var(--earl-blue-accent)`) plus utility classes (`btn`, `btn-quiet`, `btn-primary`, `btn-sm`, `icon-btn`). Either define the same tokens/classes in your CSS, or `s/var(--earl-blue-/var(--your-/g` once when copying in.

That's it. The actual WhatsApp logic (message rendering, reactions, replies, media, pairing) is independent of all three.

### DB schema (Drizzle TS, Postgres)

Two tables. Both keyed by WhatsApp's native string message IDs (not UUIDs).

```ts
export const whatsappMessages = pgTable(
  'whatsapp_messages',
  {
    id: text('id').primaryKey(),               // WhatsApp message id
    groupJid: text('group_jid').notNull(),
    senderJid: text('sender_jid').notNull(),
    senderName: text('sender_name').notNull(), // resolved at write time
    body: text('body').notNull(),              // also holds media caption
    direction: text('direction', { enum: ['in', 'out'] }).notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    // Media — null unless WA carries an image/video/audio/document/sticker
    mediaType: text('media_type'),
    mediaMime: text('media_mime'),
    mediaSize: integer('media_size'),
    mediaWidth: integer('media_width'),
    mediaHeight: integer('media_height'),
    // Quoted reply — denormalised so rendering needs no self-join
    quotedMessageId: text('quoted_message_id'),
    quotedSenderName: text('quoted_sender_name'),
    quotedBodyPreview: text('quoted_body_preview'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index('whatsapp_messages_group_ts_idx').on(t.groupJid, t.timestamp)]
);

export const whatsappReactions = pgTable(
  'whatsapp_reactions',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => whatsappMessages.id, { onDelete: 'cascade' }),
    senderJid: text('sender_jid').notNull(),
    senderName: text('sender_name').notNull(),
    emoji: text('emoji').notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.senderJid] }),
    index('whatsapp_reactions_message_idx').on(t.messageId)
  ]
);
```

Optional: an `avatar_url` column on your users table if you want LinkedIn-style faces next to incoming bubbles.

### Route handlers

All under `src/app/api/whatsapp/`. Each delegates to the sidecar over HTTP using a small wrapper module at `src/lib/whatsapp.ts`. Auth on every route via `getCurrentUser()`.

| Path | Method | Calls sidecar | What it does |
|---|---|---|---|
| `/api/whatsapp/messages` | GET | `GET /messages` | Drains the entire sidecar buffer (capped 5000) every call, upserts into DB with `onConflictDoNothing`, returns DB rows plus a `reactions` array plus an `avatarsByJid` map plus `status`. Don't filter the sidecar drain by `since=<latest DB ts>` — historical backfill is older than existing rows and the filter eats it. |
| `/api/whatsapp/send` | POST | `POST /messages` | Look up the optional `quotedMessageId` row in DB to get its senderJid + body, pass to sidecar as `quoted`. Pass `via: user.id` so the sidecar routes through the caller's own paired session. 412 if not paired. |
| `/api/whatsapp/events` | GET | `GET /events` | SSE passthrough. Pipes upstream chunks to the client AND persists `message` + `reaction` events into Postgres so reloads pick them up. |
| `/api/whatsapp/history` | POST | `POST /history/fetch` | Trigger Baileys' on-demand history backfill from the oldest known anchor. Older messages arrive via SSE; panel refetches `/messages` after ~2.5s. |
| `/api/whatsapp/media/[id]` | GET | `GET /media/:id` | Auth-gated proxy. Streams bytes through with `Cache-Control: private, max-age=86400`. |
| `/api/whatsapp/reactions` | POST | `POST /reactions` | Look up target message to find its senderJid (needed for the reaction's WAMessageKey.participant). Empty `emoji` clears. |
| `/api/whatsapp/sessions/me` | GET / POST / DELETE | `/sessions/:userId/*` | Get / create / wipe the current user's WhatsApp pairing. `userId` always comes from the server-side session. |
| `/api/whatsapp/sessions/me/qr` | GET | `GET /sessions/:userId/qr` | PNG passthrough for the pairing QR. |

### Panel component

`src/app/WhatsAppPanel.tsx` — one file, ~1200 lines. Two exports:

- `<WhatsAppButton />` — header trigger that dispatches a custom `earl:toggle-whatsapp` event.
- `<WhatsAppPanel />` — the right-side aside itself. Mounts once at the layout level. Listens for the toggle event.

State (TS roughly):

```ts
const [open, setOpen] = useState(false);
const [messages, setMessages] = useState<Msg[]>([]);
const [reactions, setReactions] = useState<Record<msgId, Reaction[]>>({});
const [avatarsByJid, setAvatarsByJid] = useState<Record<jid, string>>({});
const [status, setStatus] = useState<SidecarStatus | null>(null);
const [mySession, setMySession] = useState<MySession | null>(null);
const [myWhatsappJid, setMyWhatsappJid] = useState<string | null>(null);
const [replyTarget, setReplyTarget] = useState<Msg | null>(null);
const [pickerForMessageId, setPickerForMessageId] = useState<string | null>(null);
const [historyState, setHistoryState] = useState<'idle' | 'loading' | 'no-anchor' | 'no-older' | 'error'>('idle');
const [settingsOpen, setSettingsOpen] = useState(false);
```

Effects:

1. **Initial load** — when `open` flips true, `GET /api/whatsapp/messages?limit=2000` fills `messages` + `reactions` + `avatarsByJid` + `status`.
2. **SSE** — open `EventSource('/api/whatsapp/events')` while `open`. Listen for `message`, `reaction`, `status`. Append/upsert into state.
3. **Pairing poll** — `GET /api/whatsapp/sessions/me` every 30s while `open`. Also seeds `myWhatsappJid` synchronously from `session.self` so optimistic reactions get attributed correctly before SSE settles.
4. **Auto history fetch** — once initial load completes and at least one message exists, fire one silent `POST /api/whatsapp/history` to backfill older content.
5. **Persist open state** — `localStorage` so navigation across pages keeps the panel open.
6. **Close on overlay open** — listen for a custom `earl:overlay-open` event (board card sidebar dispatches it) and auto-hide so two right-side panels don't fight.

Sub-components inside the same file:

- `MessageBubble` — renders one bubble (text, media, quoted block, reactions, hover icons for reply + react). Knows about group-start (first bubble from a sender within 2 min) for sender-name label + corner radius.
- `MediaImage` / `MediaChip` — inline image with click-to-fullsize / file chip for other media types.
- `ReactionRow` — chips below bubble, grouped by emoji, your own highlighted green.
- `EmojiPicker` — popover with 8 common emojis + clear-mine button.
- `ReplyChip` — appears above the composer when you've picked a reply target.
- `DayPill` — centered capsule pill separating days.
- `PairingModal` — overlay over the panel itself with QR + Link/Unlink button.

### Optimistic update pattern

Sends, reactions, and reply state all update locally first and reconcile via the SSE round-trip:

```ts
async function react(messageId: string, emoji: string) {
  setReactions(prev => /* immediate UI update with myWhatsappJid */);
  const res = await fetch('/api/whatsapp/reactions', { ... });
  if (res.status === 412) setSettingsOpen(true);
  // SSE 'reaction' event arrives within ~1s and reconciles with the server's view
}
```

### Avatars

LinkedIn-style faces next to incoming bubbles. Two pieces:

1. `avatar_url` text column on your users table. Populated by direct SQL UPDATE — the LinkedIn URLs in WhatsApp data are signed and expire, so download to `public/avatars/<name>.jpg` and use a static path.
2. Environment variable `WHATSAPP_JID_TO_USER_ID=<jid>:<user_id>,...` maps WhatsApp's opaque `@lid` JIDs to your app's user IDs. The messages route parses it, joins users, and returns `avatarsByJid: Record<jid, url>` to the panel. The panel renders a 28px circle on the first bubble of each consecutive-from-same-sender group.

### Wallpaper

`public/wa-wallpaper.svg` — 240x240 SVG tile with WhatsApp-style doodles (smileys, hearts, paper planes, flowers) at 8% opacity over `#efeae2`. Applied via `backgroundImage: 'url(/wa-wallpaper.svg)'` on the scroll container.

### Decisions worth knowing about (lessons from real iterations)

- **The 4 linked-device cap matters.** Multi-user pairing burns a slot per earl-tasks user. With 3 users + the phone owner's other devices (WhatsApp Web + Desktop), you can hit the cap fast. Surface "logged_out" status clearly so users re-pair instead of silently dropping.
- **History sync only happens on first pair.** WhatsApp's protocol re-encrypts history for a new linked device only on initial pair. If your sidecar already has Baileys credentials and you reconnect, no history. Solution: full re-pair = wipe `/session/baileys/<userId>/` and let WhatsApp re-deliver. The shared buffer + DB don't get wiped because they live at `/session` root, so DB history is preserved across re-pair.
- **`fetchMessageHistory` from an anchor returns mostly nothing.** Pre-pairing messages were never encrypted for this device. They literally can't be decrypted regardless of how you ask. The "Load older" button is mostly useful right after pairing while WhatsApp servers still hold some recent history.
- **Drain the sidecar buffer without filtering.** First version filtered by `since=<latest DB ts>` and silently lost 249 history messages because backfill is older than existing rows. Just pull the whole buffer every call (≤5000 messages, ~75KB) and `onConflictDoNothing` on insert.
- **Use the sidecar's `via` field for per-user routing.** Don't impersonate. Each app user pairs their own phone; the panel sends with `via: user.id`. Recipients see the correct name in the WhatsApp group.
- **Resolve `@lid` JIDs to real names via env, not heuristics.** Baileys only sets `pushName` on live messages — history rows show raw JIDs unless you map them. `WHATSAPP_NAME_OVERRIDES` env on the sidecar + name-aware re-rendering in the panel.
- **SSE subscribers must survive primary re-pair.** Subscribe to the sidecar Manager itself, not the underlying primary client object — re-pairing the primary swaps the client and would silently kill open SSE streams otherwise.
- **Mount the panel once at layout level**, not per-page. State (open/closed, message buffer, SSE) persists across navigation. `localStorage` for the open boolean.
- **Auto-hide on overlay open.** When the host app opens its own right-side overlay (a card sidebar etc.), dispatch a custom event the panel listens for. Both panels at `right-0 z-30` is the alternative — not great.

### Files in earl-tasks worth looking at

If you have access to the earl-tasks repo, the relevant files are:

- `src/app/WhatsAppPanel.tsx` — the whole component.
- `src/lib/whatsapp.ts` — the sidecar client wrapper + shared types.
- `src/app/api/whatsapp/**/*.ts` — the 9 route handlers.
- `src/lib/db/schema.ts` — the two Drizzle tables.
- `public/wa-wallpaper.svg` — the doodle background.
- `public/avatars/*.jpg` — user faces.
- `src/app/layout.tsx` — where `<WhatsAppButton />` lives in the header and `<WhatsAppPanel />` mounts at the bottom of body.

Copy those in, swap the three integration points, and you have a working panel.

## License

MIT
