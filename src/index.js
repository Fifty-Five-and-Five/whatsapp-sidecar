import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import pino from 'pino';
import qrcode from 'qrcode';
import fs from 'node:fs';
import { SessionManager } from './manager.js';

const PORT = Number(process.env.PORT || 3030);
const TOKEN = process.env.SIDECAR_TOKEN;
const GROUP_JID = process.env.WHATSAPP_GROUP_JID || null;
const PRIMARY_USER_ID = process.env.WHATSAPP_PRIMARY_USER_ID;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

if (!TOKEN) {
  console.error('SIDECAR_TOKEN env is required');
  process.exit(1);
}
if (!PRIMARY_USER_ID) {
  console.error('WHATSAPP_PRIMARY_USER_ID env is required (the earl-tasks UUID of the phone owner)');
  process.exit(1);
}

const logger = pino({ level: LOG_LEVEL });
const manager = new SessionManager({ logger, groupJid: GROUP_JID, primaryUserId: PRIMARY_USER_ID });

const app = Fastify({ loggerInstance: logger });
// Voice notes are POSTed as multipart; cap at 16 MB (well above a PTT clip).
app.register(multipart, { limits: { fileSize: 16 * 1024 * 1024, files: 1 } });

app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return;
  // Per-session QR is open for first-time pairing; the QR rotates every ~20s
  // and is useless without physical access to the phone.
  if (/^\/(qr|sessions\/[^/]+\/qr)$/.test(req.url)) return;
  const header = req.headers.authorization || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (presented !== TOKEN) {
    reply.code(401).send({ error: 'unauthorized' });
  }
});

// ---- legacy single-session endpoints (kept for backwards compat) ------------

app.get('/health', async () => manager.primaryStatus() || { status: 'starting' });

app.get('/qr', async (req, reply) => {
  const qr = manager.primaryQR();
  if (!qr) {
    reply.code(404).send({ error: 'no QR available', status: manager.primaryStatus()?.status });
    return;
  }
  const png = await qrcode.toBuffer(qr, { type: 'png', width: 360 });
  reply.header('content-type', 'image/png').send(png);
});

app.get('/messages', async (req) => {
  const since = typeof req.query.since === 'string' ? req.query.since : null;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  return { messages: manager.recentMessages({ sinceIso: since, limit }) };
});

app.post('/messages', async (req, reply) => {
  const body = req.body?.body;
  // `to` (phone number or JID) sends a 1:1 message; omit it to post to the group.
  const to = typeof req.body?.to === 'string' ? req.body.to : null;
  const senderName = req.body?.senderName;
  const quoted = req.body?.quoted || null;
  // `via` is trusted because the bearer token already authenticated this call
  // and the sidecar lives on an internal-only Docker network — there's no
  // public ingress to forge a `via` from. earl-tasks /api/whatsapp/send sets
  // it from the user's server-side session.
  const via = typeof req.body?.via === 'string' ? req.body.via : null;
  if (typeof body !== 'string' || !body.trim()) {
    reply.code(400).send({ error: 'body required' });
    return;
  }
  const userId = via || manager.primaryUserId;
  try {
    const sent = await manager.send({ userId, to, body, senderName, quoted });
    return { ok: true, message: sent };
  } catch (err) {
    if (err.code === 'NOT_PAIRED') {
      reply.code(412).send({ error: err.message, userId });
      return;
    }
    reply.code(503).send({ error: err.message });
  }
});

app.post('/history/fetch', async (req, reply) => {
  const count = Math.min(Number(req.body?.count || 100), 500);
  try {
    const result = await manager.fetchOlder(count);
    return { ok: true, ...result };
  } catch (err) {
    if (err.code === 'NO_ANCHOR') {
      reply.code(409).send({ error: err.message });
      return;
    }
    reply.code(503).send({ error: err.message });
  }
});

app.get('/history/anchor', async () => ({ anchor: manager.oldestAnchor() }));

app.get('/media/:id', async (req, reply) => {
  const id = req.params.id;
  const filePath = manager.mediaPathFor(id);
  if (!filePath) {
    reply.code(404).send({ error: 'not found' });
    return;
  }
  const cached = manager.bufferEntryById(id);
  const mime = cached?.media?.mime || 'application/octet-stream';
  const stat = fs.statSync(filePath);
  reply
    .header('content-type', mime)
    .header('content-length', stat.size)
    .header('cache-control', 'private, max-age=86400');
  return reply.send(fs.createReadStream(filePath));
});

app.post('/reactions', async (req, reply) => {
  const messageId = req.body?.messageId;
  const originalSenderJid = req.body?.originalSenderJid || null;
  const emoji = typeof req.body?.emoji === 'string' ? req.body.emoji : '';
  const via = typeof req.body?.via === 'string' ? req.body.via : null;
  if (typeof messageId !== 'string' || !messageId) {
    reply.code(400).send({ error: 'messageId required' });
    return;
  }
  const userId = via || manager.primaryUserId;
  try {
    const reaction = await manager.sendReaction({ userId, messageId, originalSenderJid, emoji });
    return { ok: true, reaction };
  } catch (err) {
    if (err.code === 'NOT_PAIRED') {
      reply.code(412).send({ error: err.message, userId });
      return;
    }
    reply.code(503).send({ error: err.message });
  }
});

// ---- presence / read receipts / edit / delete / voice -----------------------

function viaUserId(req) {
  const via = typeof req.body?.via === 'string' ? req.body.via : null;
  return via || manager.primaryUserId;
}

function replyErr(reply, err) {
  if (err.code === 'NOT_PAIRED') { reply.code(412).send({ error: err.message }); return; }
  reply.code(503).send({ error: err.message });
}

app.post('/presence', async (req, reply) => {
  const state = typeof req.body?.state === 'string' ? req.body.state : 'paused';
  try {
    return { ok: true, ...(await manager.sendPresence({ userId: viaUserId(req), state })) };
  } catch (err) { replyErr(reply, err); }
});

app.post('/read', async (req, reply) => {
  const messageIds = Array.isArray(req.body?.messageIds) ? req.body.messageIds : [];
  try {
    return { ok: true, ...(await manager.markRead({ userId: viaUserId(req), messageIds })) };
  } catch (err) { replyErr(reply, err); }
});

app.post('/edit', async (req, reply) => {
  const messageId = req.body?.messageId;
  const body = req.body?.body;
  if (typeof messageId !== 'string' || !messageId || typeof body !== 'string' || !body.trim()) {
    reply.code(400).send({ error: 'messageId and non-empty body required' });
    return;
  }
  try {
    return { ok: true, ...(await manager.editText({ userId: viaUserId(req), messageId, body })) };
  } catch (err) { replyErr(reply, err); }
});

app.post('/delete', async (req, reply) => {
  const messageId = req.body?.messageId;
  if (typeof messageId !== 'string' || !messageId) {
    reply.code(400).send({ error: 'messageId required' });
    return;
  }
  try {
    return { ok: true, ...(await manager.deleteMessage({ userId: viaUserId(req), messageId })) };
  } catch (err) { replyErr(reply, err); }
});

// Voice notes: multipart upload → sent as a PTT audio message. `via`/`to`/`ptt`
// travel as multipart fields alongside the file part.
app.post('/media/upload', async (req, reply) => {
  let data;
  try { data = await req.file(); } catch (err) { reply.code(400).send({ error: 'invalid upload' }); return; }
  if (!data) { reply.code(400).send({ error: 'file required' }); return; }
  const buffer = await data.toBuffer();
  const fields = data.fields || {};
  const fv = (k) => (fields[k] && typeof fields[k].value === 'string') ? fields[k].value : null;
  const via = fv('via');
  const to = fv('to');
  const ptt = fv('ptt') !== 'false';
  const userId = via || manager.primaryUserId;
  try {
    const sent = await manager.sendAudio({ userId, to, buffer, mimeType: data.mimetype, ptt });
    return { ok: true, message: sent };
  } catch (err) { replyErr(reply, err); }
});

app.get('/events', (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const write = (event, data) => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  write('status', manager.primaryStatus());

  const onMessage = (m) => write('message', m);
  const onReaction = (r) => write('reaction', r);
  const onStatus = () => write('status', manager.primaryStatus());
  // Additive event types for presence/typing, read ticks, and edit/delete.
  const onPresence = (p) => write('presence', p);
  const onReceipt = (r) => write('receipt', r);
  const onEdit = (e) => write('edit', e);
  const onDelete = (d) => write('delete', d);

  manager.onMessage(onMessage);
  manager.onReaction(onReaction);
  manager.onStatus(onStatus);
  manager.on('presence', onPresence);
  manager.on('receipt', onReceipt);
  manager.on('edit', onEdit);
  manager.on('delete', onDelete);

  const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25000);

  req.raw.on('close', () => {
    clearInterval(ping);
    manager.offMessage(onMessage);
    manager.offReaction(onReaction);
    manager.offStatus(onStatus);
    manager.off('presence', onPresence);
    manager.off('receipt', onReceipt);
    manager.off('edit', onEdit);
    manager.off('delete', onDelete);
  });
});

// ---- per-user sessions ------------------------------------------------------

app.get('/sessions', async () => ({ sessions: manager.list() }));

app.get('/sessions/:userId/health', async (req, reply) => {
  const client = manager.get(req.params.userId);
  if (!client) {
    reply.code(404).send({ error: 'not initialised' });
    return;
  }
  return { isPrimary: req.params.userId === manager.primaryUserId, ...client.getStatus() };
});

app.get('/sessions/:userId/qr', async (req, reply) => {
  const client = manager.get(req.params.userId);
  if (!client) {
    reply.code(404).send({ error: 'not initialised', hint: 'POST /sessions/:userId first' });
    return;
  }
  const qr = client.getQR();
  if (!qr) {
    reply.code(404).send({ error: 'no QR available', status: client.status });
    return;
  }
  const png = await qrcode.toBuffer(qr, { type: 'png', width: 360 });
  reply.header('content-type', 'image/png').send(png);
});

app.post('/sessions/:userId', async (req, reply) => {
  try {
    const client = await manager.createSession(req.params.userId);
    return {
      ok: true,
      userId: req.params.userId,
      isPrimary: req.params.userId === manager.primaryUserId,
      ...client.getStatus(),
    };
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

app.delete('/sessions/:userId', async (req, reply) => {
  try {
    await manager.deleteSession(req.params.userId);
    return { ok: true };
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

async function main() {
  await manager.start();
  await app.listen({ port: PORT, host: '0.0.0.0' });
  logger.info({ port: PORT, groupJid: GROUP_JID, primary: PRIMARY_USER_ID }, 'sidecar listening');
}

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    logger.info({ sig }, 'shutting down');
    app.close().finally(() => process.exit(0));
  });
}
