import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WhatsAppClient } from './wa.js';

const SESSION_DIR = process.env.SESSION_DIR || '/session';
const BAILEYS_ROOT = path.join(SESSION_DIR, 'baileys');

// Files at /session root are SHARED across all paired devices (the canonical
// message buffer, history anchor, contact name map, downloaded media).
// Everything else in /session predates the multi-device refactor and belongs
// to the primary device — we migrate it on first boot.
const SHARED_TOP_LEVEL = new Set([
  'baileys',
  'buffer.json',
  'buffer.json.tmp',
  'anchor.json',
  'anchor.json.tmp',
  'contacts.json',
  'contacts.json.tmp',
  'media',
]);

// Per-user Baileys dirs are named after whatever identifier the host app uses
// for users. Originally a UUID (earl-tasks) — relaxed here so other apps can
// drop the sidecar in with their own user-id format.
function isValidUserId(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(s);
}

export class SessionManager extends EventEmitter {
  constructor({ logger, groupJid, primaryUserId }) {
    super();
    this.logger = logger;
    this.groupJid = groupJid;
    this.primaryUserId = primaryUserId;
    if (!isValidUserId(this.primaryUserId)) {
      throw new Error(
        `WHATSAPP_PRIMARY_USER_ID must be 1-64 chars of [A-Za-z0-9_.-] (got: ${this.primaryUserId})`,
      );
    }
    this.clients = new Map();
  }

  async start() {
    await this._migrateLegacyLayout();
    await this._loadExistingSessions();
  }

  async _migrateLegacyLayout() {
    // If /session contains Baileys auth files (creds.json etc.) at root,
    // move them under /session/baileys/<primaryUserId>/.
    let entries;
    try {
      entries = await fs.readdir(SESSION_DIR);
    } catch (err) {
      if (err.code === 'ENOENT') {
        await fs.mkdir(SESSION_DIR, { recursive: true });
        return;
      }
      throw err;
    }
    const baileysFiles = entries.filter((name) => !SHARED_TOP_LEVEL.has(name));
    if (!baileysFiles.length) return;
    const target = path.join(BAILEYS_ROOT, this.primaryUserId);
    await fs.mkdir(target, { recursive: true });
    for (const name of baileysFiles) {
      const src = path.join(SESSION_DIR, name);
      const dst = path.join(target, name);
      try {
        await fs.rename(src, dst);
      } catch (err) {
        this.logger.warn({ err, name }, 'migration: rename failed');
      }
    }
    this.logger.info(
      { count: baileysFiles.length, primary: this.primaryUserId },
      'migrated legacy Baileys auth files into /session/baileys/<primaryUserId>/',
    );
  }

  async _loadExistingSessions() {
    let entries;
    try {
      entries = await fs.readdir(BAILEYS_ROOT, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') {
        await fs.mkdir(BAILEYS_ROOT, { recursive: true });
        entries = [];
      } else {
        throw err;
      }
    }
    // Always start the primary first so shared state loads from disk before
    // any secondary touches it.
    const primaryDir = path.join(BAILEYS_ROOT, this.primaryUserId);
    try {
      await fs.access(primaryDir);
      await this._launchClient(this.primaryUserId, 'primary');
    } catch {
      this.logger.warn(
        { primary: this.primaryUserId },
        'no Baileys auth for primary user yet — primary session will go straight to QR',
      );
      await this._launchClient(this.primaryUserId, 'primary');
    }

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const userId = e.name;
      if (userId === this.primaryUserId) continue;
      if (!isValidUserId(userId)) continue;
      await this._launchClient(userId, 'sender-only');
    }
  }

  async _launchClient(userId, mode) {
    const baileysDir = path.join(BAILEYS_ROOT, userId);
    const logger = this.logger.child({ session: userId.slice(0, 8), mode });
    const client = new WhatsAppClient({
      logger,
      groupJid: this.groupJid,
      baileysDir,
      mode,
    });
    // Only the primary's stream of events drives the Manager's fan-out. Sender-
    // only clients exist purely for outbound; their inbound echoes appear via
    // the primary anyway.
    if (mode === 'primary') {
      const forward = (event) => (payload) => this.emit(event, payload);
      const onMessage = forward('message');
      const onReaction = forward('reaction');
      const onStatus = forward('status');
      client.on('message', onMessage);
      client.on('reaction', onReaction);
      client.on('status', onStatus);
      // Snapshot so we can detach if this same userId is re-paired later.
      client._managerForwarders = { onMessage, onReaction, onStatus };
    }
    this.clients.set(userId, client);
    await client.start();
    // Don't return until this session's handshake has settled, so the
    // caller's serial await loop genuinely serialises Baileys boots.
    // Without this, three sessions fire their fetchProps queries from the
    // same IP simultaneously and WhatsApp throttles them all into a 408
    // loop that blocks message delivery (see incident 2026-05-24).
    await this._waitForSettle(client);
    return client;
  }

  _waitForSettle(client) {
    return new Promise((resolve) => {
      const SETTLED = new Set(['connected', 'qr', 'logged_out']);
      if (SETTLED.has(client.status)) {
        resolve();
        return;
      }
      const onStatus = (s) => {
        if (!SETTLED.has(s)) return;
        client.off('status', onStatus);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        client.off('status', onStatus);
        this.logger.warn(
          { status: client.status },
          'session did not settle within 30s — proceeding anyway',
        );
        resolve();
      }, 30000);
      client.on('status', onStatus);
    });
  }

  primary() {
    return this.clients.get(this.primaryUserId);
  }

  get(userId) {
    return this.clients.get(userId);
  }

  list() {
    return Array.from(this.clients.entries()).map(([userId, client]) => ({
      userId,
      isPrimary: userId === this.primaryUserId,
      ...client.getStatus(),
    }));
  }

  async createSession(userId) {
    if (!isValidUserId(userId)) throw new Error('userId must be 1-64 chars of [A-Za-z0-9_.-]');
    const existing = this.clients.get(userId);
    // A live or pairing-in-progress client is reusable — don't disturb it.
    // A logged_out or disconnected client is dead weight: returning it gives
    // the caller nothing useful (no fresh QR will appear) and looks like a
    // silent no-op. Tear it down and start fresh so re-pair works.
    if (existing && existing.status !== 'logged_out' && existing.status !== 'disconnected') {
      return existing;
    }
    if (existing) {
      await this.deleteSession(userId);
    }
    const mode = userId === this.primaryUserId ? 'primary' : 'sender-only';
    return this._launchClient(userId, mode);
  }

  async deleteSession(userId) {
    const client = this.clients.get(userId);
    if (client) {
      const fwd = client._managerForwarders;
      if (fwd) {
        client.off('message', fwd.onMessage);
        client.off('reaction', fwd.onReaction);
        client.off('status', fwd.onStatus);
      }
      await client.stop();
      this.clients.delete(userId);
    }
    const dir = path.join(BAILEYS_ROOT, userId);
    await fs.rm(dir, { recursive: true, force: true });
    // Note for primary: shared buffer/anchor/contacts/media stay because they
    // live at /session root, not in /session/baileys/. Re-pairing the primary
    // resumes inbound flow without losing any history we've already persisted
    // to the earl-tasks DB.
  }

  // Shared buffer / history / events all live on the primary client.
  recentMessages(opts) {
    return this.primary()?.recentMessages(opts) || [];
  }

  oldestAnchor() {
    return this.primary()?.oldestAnchor || null;
  }

  async fetchOlder(count) {
    const p = this.primary();
    if (!p) throw new Error('primary session not initialised');
    return p.fetchOlder(count);
  }

  mediaPathFor(id) {
    return this.primary()?.mediaPathFor(id) || null;
  }

  bufferEntryById(id) {
    return this.primary()?.recent.find((m) => m.id === id) || null;
  }

  primaryStatus() {
    return this.primary()?.getStatus() || null;
  }

  primaryQR() {
    return this.primary()?.getQR() || null;
  }

  // Manager itself emits forwarded events from whichever client is currently
  // primary. Subscribers don't need to know the primary swapped underneath —
  // critical for keeping SSE consumers alive across un/repair cycles.
  onMessage(cb) {
    this.on('message', cb);
  }

  offMessage(cb) {
    this.off('message', cb);
  }

  onStatus(cb) {
    this.on('status', cb);
  }

  offStatus(cb) {
    this.off('status', cb);
  }

  async send({ userId, body, senderName, quoted }) {
    const client = this.clients.get(userId);
    if (!client) {
      const err = new Error('not paired');
      err.code = 'NOT_PAIRED';
      throw err;
    }
    return client.sendText({ body, senderName, quoted });
  }

  async sendReaction({ userId, messageId, originalSenderJid, emoji }) {
    const client = this.clients.get(userId);
    if (!client) {
      const err = new Error('not paired');
      err.code = 'NOT_PAIRED';
      throw err;
    }
    return client.sendReaction({ messageId, originalSenderJid, emoji });
  }

  onReaction(cb) {
    this.on('reaction', cb);
  }

  offReaction(cb) {
    this.off('reaction', cb);
  }
}
