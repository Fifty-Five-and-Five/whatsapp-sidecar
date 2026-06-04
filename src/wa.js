import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';

const SESSION_DIR = process.env.SESSION_DIR || '/session';
// Shared state lives at /session root so all paired devices contribute to
// a single message history. Per-user Baileys auth files live under
// /session/baileys/<userId>/ — set explicitly via the constructor.
const BUFFER_PATH = path.join(SESSION_DIR, 'buffer.json');
const ANCHOR_PATH = path.join(SESSION_DIR, 'anchor.json');
const CONTACTS_PATH = path.join(SESSION_DIR, 'contacts.json');
const MEDIA_DIR = path.join(SESSION_DIR, 'media');
const RECONNECT_DELAY_MS = 2000;
const REPLAY_BUFFER_LIMIT = 5000;
const BUFFER_FLUSH_DEBOUNCE_MS = 1500;
const MEDIA_CAP_BYTES = Number(process.env.MEDIA_CAP_BYTES || 500 * 1024 * 1024);

const MEDIA_FIELDS = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];

// WhatsApp message timestamps come in two flavours: seconds-since-epoch
// (typical `messageTimestamp`) and ms-since-epoch (`reactionMessage.
// senderTimestampMs`). Anything past 1e12 we treat as ms; anything else we
// multiply. Missing/zero falls back to now.
function coerceWaTimestampMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n > 1e12 ? n : n * 1000;
}

function parseNameOverrides() {
  const raw = process.env.WHATSAPP_NAME_OVERRIDES || '';
  const out = new Map();
  for (const pair of raw.split(',')) {
    const [jid, name] = pair.split(':').map((s) => s?.trim());
    if (jid && name) out.set(jid, name);
  }
  return out;
}

function mimeToExt(mime) {
  if (!mime) return 'bin';
  const m = mime.split(';')[0].trim();
  return {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'video/quicktime': 'mov',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'application/pdf': 'pdf',
    'application/zip': 'zip',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  }[m] || (m.includes('/') ? m.split('/')[1] : 'bin');
}

function quotedTextPreview(quotedMessage) {
  if (!quotedMessage) return '';
  return (
    quotedMessage.conversation
    || quotedMessage.extendedTextMessage?.text
    || quotedMessage.imageMessage?.caption
    || (quotedMessage.imageMessage ? '[image]' : '')
    || quotedMessage.videoMessage?.caption
    || (quotedMessage.videoMessage ? '[video]' : '')
    || (quotedMessage.audioMessage ? '[audio]' : '')
    || (quotedMessage.documentMessage ? `[file] ${quotedMessage.documentMessage.fileName || ''}`.trim() : '')
    || (quotedMessage.stickerMessage ? '[sticker]' : '')
    || ''
  );
}

function findMediaField(m) {
  if (!m) return null;
  for (const f of MEDIA_FIELDS) {
    if (m[f]) {
      const type = f.replace('Message', '');
      return { field: f, type, content: m[f] };
    }
  }
  return null;
}

function extractContent(msg) {
  const m = msg.message;
  if (!m) return { text: null, media: null, contextInfo: null };

  let text = m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || m.documentMessage?.caption
    || null;

  const mediaInfo = findMediaField(m);
  let media = null;
  if (mediaInfo) {
    const c = mediaInfo.content;
    media = {
      type: mediaInfo.type,
      mime: c.mimetype || null,
      size: c.fileLength ? Number(c.fileLength) : null,
      width: c.width || null,
      height: c.height || null,
    };
  }

  // contextInfo (quoted reply) — present on any Contextable. Prefer the field
  // that actually has it; fall back to extendedTextMessage which is the most
  // common location.
  const contextInfo = (mediaInfo && mediaInfo.content.contextInfo)
    || m.extendedTextMessage?.contextInfo
    || null;

  return { text, media, contextInfo };
}

export class WhatsAppClient extends EventEmitter {
  constructor({ logger, groupJid, baileysDir, mode = 'primary' }) {
    super();
    this.logger = logger || pino({ level: 'info' });
    this.groupJid = groupJid || null;
    // Where Baileys persists its auth/session files for THIS device.
    // Each paired earl-tasks user gets their own dir.
    this.baileysDir = baileysDir || SESSION_DIR;
    // 'primary' — listens to messages.upsert, history, contacts; owns the
    // shared buffer/anchor/contacts/media. There is exactly one primary.
    // 'sender-only' — used to relay outbound messages from another earl-tasks
    // user via their own paired phone. Skips inbound subscriptions; primary
    // still receives the echo and records it.
    this.mode = mode;
    this.sock = null;
    this.qr = null;
    this.status = 'connecting';
    this.recent = [];
    this.recentIndex = new Set();
    this.groupNameCache = new Map();
    this.sentByMe = new Set();
    this.bufferFlushTimer = null;
    this.oldestAnchor = null;
    this._anchorFlushTimer = null;
    this.contacts = new Map();
    this.contactsFlushTimer = null;
    this.nameOverrides = parseNameOverrides();
  }

  async start() {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    await fs.mkdir(MEDIA_DIR, { recursive: true });
    await fs.mkdir(this.baileysDir, { recursive: true });
    if (this.mode === 'primary') {
      await this._loadBuffer();
      await this._loadAnchor();
      await this._loadContacts();
    }
    const { state, saveCreds } = await useMultiFileAuthState(this.baileysDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: this.logger.child({ mod: 'baileys' }),
      printQRInTerminal: false,
      browser: ['Earl Tasks Sidecar', 'Chrome', '1.0'],
      syncFullHistory: true,
      markOnlineOnConnect: false,
      cachedGroupMetadata: async (jid) => this.groupNameCache.get(jid),
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => this._onConnection(u));
    if (this.mode === 'primary') {
      sock.ev.on('messages.upsert', (u) => this._onMessages(u));
      sock.ev.on('messaging-history.set', (u) => this._onHistory(u));
      sock.ev.on('contacts.upsert', (cs) => this._onContacts(cs));
      sock.ev.on('contacts.update', (cs) => this._onContacts(cs));
      sock.ev.on('groups.update', (events) => {
        for (const ev of events) {
          if (ev.id && ev.subject) {
            const cur = this.groupNameCache.get(ev.id) || {};
            this.groupNameCache.set(ev.id, { ...cur, subject: ev.subject });
          }
        }
      });
    } else {
      // sender-only sessions still need messages.upsert to track sentByMe so
      // they can detect their own outgoing echoes (used for status feedback),
      // but they never record to the shared buffer.
      sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          if (msg.key?.fromMe && msg.key.id && this.sentByMe.has(msg.key.id)) {
            this.sentByMe.delete(msg.key.id);
          }
        }
      });
    }
  }

  async stop() {
    try {
      // Detach Baileys event handlers before tearing the socket down. Without
      // this, listeners hold the dead socket alive in Node's GC chain and
      // could fire on a re-launch's events if Baileys' internal queues reuse
      // identity.
      this.sock?.ev?.removeAllListeners?.();
      this.sock?.end?.(undefined);
    } catch (err) {
      this.logger.warn({ err }, 'sock.end errored');
    }
    this.sock = null;
    this._setStatus('disconnected');
  }

  _setStatus(next) {
    if (this.status === next) return;
    this.status = next;
    this.emit('status', next);
  }

  _onConnection(u) {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      this.qr = qr;
      this._setStatus('qr');
      this.logger.info('QR code ready — scan via /qr endpoint');
    }
    if (connection === 'open') {
      this.qr = null;
      this._setStatus('connected');
      this.logger.info({ user: this.sock?.user?.id, mode: this.mode }, 'WhatsApp connected');
      if (this.mode === 'primary') {
        this._primeGroupCache().catch((err) =>
          this.logger.warn({ err }, 'group cache prime failed'),
        );
      }
    }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      this.logger.warn({ code, loggedOut }, 'WhatsApp connection closed');
      if (loggedOut) {
        this._setStatus('logged_out');
        return;
      }
      this._setStatus('connecting');
      setTimeout(() => {
        this.start().catch((err) =>
          this.logger.error({ err }, 'reconnect failed'),
        );
      }, RECONNECT_DELAY_MS);
    }
  }

  _onContacts(contacts) {
    if (!Array.isArray(contacts)) return;
    let changed = false;
    for (const c of contacts) {
      const name = c.name || c.notify || c.verifiedName;
      if (c.id && name && this.contacts.get(c.id) !== name) {
        this.contacts.set(c.id, name);
        changed = true;
      }
    }
    if (changed) this._scheduleContactsFlush();
  }

  async _primeGroupCache() {
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      for (const [jid, meta] of Object.entries(groups)) {
        this.groupNameCache.set(jid, meta);
      }
      if (this.groupJid && groups[this.groupJid]) {
        this.logger.info(
          { groupJid: this.groupJid, subject: groups[this.groupJid].subject },
          'pinned group found',
        );
      } else if (this.groupJid) {
        this.logger.warn(
          { groupJid: this.groupJid },
          'pinned group JID not found in participating groups',
        );
      } else {
        this.logger.info(
          { count: Object.keys(groups).length },
          'no WHATSAPP_GROUP_JID set — listing all participating groups',
        );
        for (const [jid, meta] of Object.entries(groups)) {
          this.logger.info({ groupJid: jid, subject: meta.subject }, 'group');
        }
      }
    } catch (err) {
      this.logger.warn({ err }, 'groupFetchAllParticipating failed');
    }
  }

  _resolveName(jid, pushName) {
    if (!jid) return pushName || 'unknown';
    // Env overrides take highest precedence — Chris adds his co-founders' JIDs
    // here so they always render with proper names regardless of pushName.
    if (this.nameOverrides.has(jid)) return this.nameOverrides.get(jid);
    if (this.contacts.has(jid)) return this.contacts.get(jid);
    if (pushName) {
      // Cache the pushName so future history messages benefit.
      this.contacts.set(jid, pushName);
      this._scheduleContactsFlush();
      return pushName;
    }
    return jid;
  }

  _onMessages({ messages, type }) {
    if (type !== 'notify') return;
    for (const msg of messages) {
      this._processMessage(msg, { emit: true });
    }
  }

  _onHistory({ messages, syncType }) {
    if (!messages?.length) return;
    let kept = 0;
    for (const msg of messages) {
      if (this._processMessage(msg, { emit: true })) kept++;
    }
    if (kept) {
      this.logger.info(
        { syncType, total: messages.length, kept },
        'history sync chunk processed',
      );
    }
  }

  _processMessage(msg, { emit }) {
    if (!msg?.message) return false;
    if (msg.message.protocolMessage) return false;
    if (!msg.key) return false;
    if (msg.message.reactionMessage) {
      this._processReaction(msg, { emit });
      return false;
    }

    const jid = msg.key.remoteJid;
    if (!jid?.endsWith('@g.us')) return false;

    if (this.groupJid) {
      if (jid !== this.groupJid) return false;
    } else {
      this.logger.info(
        { groupJid: jid, subject: this.groupNameCache.get(jid)?.subject },
        'inbound group message — set WHATSAPP_GROUP_JID to this to scope the sidecar',
      );
      return false;
    }

    const { text, media, contextInfo } = extractContent(msg);
    // Drop only if there's neither text nor media. Pure-reaction etc were
    // already filtered above.
    if (!text && !media) return false;

    const fromMe = !!msg.key.fromMe;
    const selfBare = this.sock?.user?.id?.split(':')[0] + '@s.whatsapp.net';
    const senderJid = fromMe ? selfBare : msg.key.participant || jid;

    if (fromMe && this.sentByMe.has(msg.key.id)) {
      this.sentByMe.delete(msg.key.id);
      return false;
    }

    if (msg.key.id && this.recentIndex.has(msg.key.id)) return false;

    const senderName = fromMe
      ? this.sock?.user?.name || 'me'
      : this._resolveName(senderJid, msg.pushName);

    const tsMs = coerceWaTimestampMs(msg.messageTimestamp);

    let quoted = null;
    if (contextInfo?.stanzaId && contextInfo?.quotedMessage) {
      const qSender = contextInfo.participant || null;
      quoted = {
        id: contextInfo.stanzaId,
        senderName: qSender ? this._resolveName(qSender, null) : 'unknown',
        bodyPreview: quotedTextPreview(contextInfo.quotedMessage).slice(0, 120),
      };
    }

    const out = {
      id: msg.key.id,
      groupJid: jid,
      senderJid,
      senderName,
      body: text || '',
      direction: fromMe ? 'out' : 'in',
      timestamp: new Date(tsMs).toISOString(),
      media: media || null,
      quoted,
    };

    this._recordMessage(out);

    if (media) {
      // Download in the background — don't block message processing. When the
      // file lands on disk, /media/:id will start serving it on the next call.
      this._downloadMedia(msg, out).catch((err) =>
        this.logger.warn({ err, id: out.id }, 'media download failed'),
      );
    }

    const tsSec = Math.floor(tsMs / 1000);
    if (!this.oldestAnchor || tsSec < this.oldestAnchor.timestamp) {
      this.oldestAnchor = {
        key: {
          remoteJid: msg.key.remoteJid,
          fromMe: !!msg.key.fromMe,
          id: msg.key.id,
          participant: msg.key.participant || undefined,
        },
        timestamp: tsSec,
      };
      this._scheduleAnchorFlush();
    }
    if (emit) this.emit('message', out);
    return true;
  }

  _processReaction(msg, { emit }) {
    const r = msg.message.reactionMessage;
    const targetKey = r?.key;
    if (!targetKey?.id) return;
    const jid = msg.key.remoteJid;
    if (this.groupJid && jid !== this.groupJid) return;
    if (!jid?.endsWith('@g.us')) return;

    const fromMe = !!msg.key.fromMe;
    const selfBare = this.sock?.user?.id?.split(':')[0] + '@s.whatsapp.net';
    const senderJid = fromMe ? selfBare : msg.key.participant || jid;
    const senderName = fromMe
      ? this.sock?.user?.name || 'me'
      : this._resolveName(senderJid, msg.pushName);
    const ts = coerceWaTimestampMs(r.senderTimestampMs || msg.messageTimestamp);

    const out = {
      messageId: targetKey.id,
      senderJid,
      senderName,
      // Empty string in r.text = remove reaction
      emoji: r.text || '',
      timestamp: new Date(ts).toISOString(),
    };
    if (emit) this.emit('reaction', out);
  }

  async sendReaction({ messageId, originalSenderJid, emoji }) {
    if (this.status !== 'connected') throw new Error(`not connected (status=${this.status})`);
    if (!this.groupJid) throw new Error('WHATSAPP_GROUP_JID is not configured');
    const key = {
      remoteJid: this.groupJid,
      fromMe: false,
      id: messageId,
      participant: originalSenderJid || undefined,
    };
    await this.sock.sendMessage(this.groupJid, {
      react: { text: emoji || '', key },
    });
    // Build a local-echo reaction so the UI gets immediate feedback (the
    // upstream messages.upsert echo will fire shortly after and onConflict
    // will dedup).
    const selfBare = this.sock?.user?.id?.split(':')[0] + '@s.whatsapp.net';
    const out = {
      messageId,
      senderJid: selfBare,
      senderName: this.sock?.user?.name || 'me',
      emoji: emoji || '',
      timestamp: new Date().toISOString(),
    };
    this.emit('reaction', out);
    return out;
  }

  async _downloadMedia(msg, recorded) {
    if (!recorded?.media || !recorded.id) return;
    const ext = mimeToExt(recorded.media.mime);
    const target = path.join(MEDIA_DIR, `${recorded.id}.${ext}`);
    try {
      await fs.access(target);
      return; // already downloaded
    } catch {
      // proceed
    }
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger: this.logger.child({ mod: 'media' }), reuploadRequest: this.sock.updateMediaMessage },
    );
    if (!buffer || !buffer.length) throw new Error('empty buffer');
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, buffer);
    await fs.rename(tmp, target);
    this.logger.info({ id: recorded.id, bytes: buffer.length, ext }, 'media saved');
    this._evictMediaIfOverCap().catch((err) =>
      this.logger.warn({ err }, 'media eviction failed'),
    );
  }

  async _evictMediaIfOverCap() {
    const entries = await fs.readdir(MEDIA_DIR);
    let total = 0;
    const stats = [];
    for (const name of entries) {
      const full = path.join(MEDIA_DIR, name);
      try {
        const s = await fs.stat(full);
        if (s.isFile()) {
          total += s.size;
          stats.push({ path: full, size: s.size, mtime: s.mtimeMs });
        }
      } catch {
        // skip
      }
    }
    if (total <= MEDIA_CAP_BYTES) return;
    stats.sort((a, b) => a.mtime - b.mtime);
    while (total > MEDIA_CAP_BYTES && stats.length) {
      const oldest = stats.shift();
      try {
        await fs.unlink(oldest.path);
        total -= oldest.size;
      } catch {
        // skip
      }
    }
  }

  mediaPathFor(id) {
    if (!id || /[^A-Za-z0-9_-]/.test(id)) return null;
    const entries = fsSync.readdirSync(MEDIA_DIR).filter((n) => n.startsWith(`${id}.`));
    if (!entries.length) return null;
    return path.join(MEDIA_DIR, entries[0]);
  }

  _recordMessage(m) {
    if (m.id) {
      if (this.recentIndex.has(m.id)) return;
      this.recentIndex.add(m.id);
    }
    this.recent.push(m);
    if (this.recent.length > REPLAY_BUFFER_LIMIT) {
      const drop = this.recent.length - REPLAY_BUFFER_LIMIT;
      const removed = this.recent.splice(0, drop);
      for (const r of removed) if (r.id) this.recentIndex.delete(r.id);
    }
    this._scheduleBufferFlush();
  }

  _scheduleBufferFlush() {
    if (this.bufferFlushTimer) return;
    this.bufferFlushTimer = setTimeout(() => {
      this.bufferFlushTimer = null;
      this._flushBuffer().catch((err) =>
        this.logger.warn({ err }, 'buffer flush failed'),
      );
    }, BUFFER_FLUSH_DEBOUNCE_MS);
  }

  async _flushBuffer() {
    const sorted = [...this.recent].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    );
    this.recent = sorted;
    const tmp = `${BUFFER_PATH}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(sorted), 'utf-8');
    await fs.rename(tmp, BUFFER_PATH);
  }

  async _loadBuffer() {
    try {
      const raw = await fs.readFile(BUFFER_PATH, 'utf-8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        this.recent = arr.slice(-REPLAY_BUFFER_LIMIT);
        for (const m of this.recent) if (m.id) this.recentIndex.add(m.id);
        this.logger.info({ count: this.recent.length }, 'buffer loaded from disk');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.logger.warn({ err }, 'failed to load buffer');
      }
    }
  }

  _scheduleAnchorFlush() {
    if (this._anchorFlushTimer) return;
    this._anchorFlushTimer = setTimeout(() => {
      this._anchorFlushTimer = null;
      this._flushAnchor().catch((err) =>
        this.logger.warn({ err }, 'anchor flush failed'),
      );
    }, BUFFER_FLUSH_DEBOUNCE_MS);
  }

  async _flushAnchor() {
    if (!this.oldestAnchor) return;
    const tmp = `${ANCHOR_PATH}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.oldestAnchor), 'utf-8');
    await fs.rename(tmp, ANCHOR_PATH);
  }

  async _loadAnchor() {
    try {
      const raw = await fs.readFile(ANCHOR_PATH, 'utf-8');
      const obj = JSON.parse(raw);
      if (obj?.key && obj?.timestamp) {
        this.oldestAnchor = obj;
        this.logger.info({ anchor: this.oldestAnchor }, 'oldest anchor loaded');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.logger.warn({ err }, 'failed to load anchor');
      }
    }
  }

  _scheduleContactsFlush() {
    if (this.contactsFlushTimer) return;
    this.contactsFlushTimer = setTimeout(() => {
      this.contactsFlushTimer = null;
      this._flushContacts().catch((err) =>
        this.logger.warn({ err }, 'contacts flush failed'),
      );
    }, BUFFER_FLUSH_DEBOUNCE_MS);
  }

  async _flushContacts() {
    const obj = Object.fromEntries(this.contacts);
    const tmp = `${CONTACTS_PATH}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(obj), 'utf-8');
    await fs.rename(tmp, CONTACTS_PATH);
  }

  async _loadContacts() {
    try {
      const raw = await fs.readFile(CONTACTS_PATH, 'utf-8');
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) this.contacts.set(k, v);
        this.logger.info({ count: this.contacts.size }, 'contacts loaded from disk');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.logger.warn({ err }, 'failed to load contacts');
      }
    }
  }

  async fetchOlder(count = 100) {
    if (this.status !== 'connected') {
      throw new Error(`not connected (status=${this.status})`);
    }
    if (!this.oldestAnchor) {
      const err = new Error(
        'no anchor message yet — wait for at least one live message in the group',
      );
      err.code = 'NO_ANCHOR';
      throw err;
    }
    const { key, timestamp } = this.oldestAnchor;
    const requestId = await this.sock.fetchMessageHistory(count, key, timestamp);
    this.logger.info(
      { requestId, count, anchor: this.oldestAnchor },
      'fetchMessageHistory issued',
    );
    return { requestId, anchor: this.oldestAnchor, count };
  }

  getQR() {
    return this.qr;
  }

  getStatus() {
    return {
      status: this.status,
      groupJid: this.groupJid,
      groupName: this.groupJid
        ? this.groupNameCache.get(this.groupJid)?.subject || null
        : null,
      self: this.sock?.user?.id || null,
    };
  }

  recentMessages({ sinceIso, limit } = {}) {
    const sinceTs = sinceIso ? Date.parse(sinceIso) : 0;
    const items = this.recent.filter((m) => Date.parse(m.timestamp) > sinceTs);
    if (limit && items.length > limit) return items.slice(-limit);
    return items;
  }

  async sendText({ body, senderName, quoted }) {
    if (this.status !== 'connected') {
      throw new Error(`not connected (status=${this.status})`);
    }
    if (!this.groupJid) {
      throw new Error('WHATSAPP_GROUP_JID is not configured');
    }

    const sendOpts = {};
    if (quoted?.id) {
      sendOpts.quoted = {
        key: {
          remoteJid: this.groupJid,
          fromMe: false,
          id: quoted.id,
          participant: quoted.senderJid || undefined,
        },
        message: { conversation: quoted.body || '' },
      };
    }

    const sent = await this.sock.sendMessage(
      this.groupJid,
      { text: body },
      sendOpts,
    );
    if (sent?.key?.id) this.sentByMe.add(sent.key.id);

    const selfBare = this.sock?.user?.id?.split(':')[0] + '@s.whatsapp.net';
    const out = {
      id: sent?.key?.id || `local-${Date.now()}`,
      groupJid: this.groupJid,
      senderJid: selfBare,
      senderName: senderName || this.sock?.user?.name || 'me',
      body,
      direction: 'out',
      timestamp: new Date().toISOString(),
      media: null,
      quoted: quoted?.id
        ? {
            id: quoted.id,
            senderName: quoted.senderName || 'unknown',
            bodyPreview: (quoted.body || '').slice(0, 120),
          }
        : null,
    };
    this._recordMessage(out);
    this.emit('message', out);
    return out;
  }
}
