/**
 * The recording rules, and the boundaries between one paired phone and another.
 *
 * These cover the decisions that are easy to get wrong and impossible to prove
 * by looking at a running system: which session records what, whose store it
 * lands in, and what happens to a message from someone we hold no number for.
 *
 * SESSION_DIR is read at module load, so it is set before the dynamic import.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let ROOT;
let WhatsAppClient;
let SessionManager;

const silent = {
  info() {}, warn() {}, error() {}, debug() {},
  child() { return silent; },
};

before(async () => {
  ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-sidecar-test-'));
  process.env.SESSION_DIR = ROOT;
  ({ WhatsAppClient } = await import('../src/wa.js'));
  ({ SessionManager } = await import('../src/manager.js'));
});

after(async () => {
  if (ROOT) await fs.rm(ROOT, { recursive: true, force: true });
});

const GROUP = '120363000000000000@g.us';
const CONTACT = '447700900123@s.whatsapp.net';
const STRANGER = '447700900999@s.whatsapp.net';

/** A client with a fake socket, so _processMessage can run without Baileys. */
function client({ mode = 'primary', storeDir = ROOT, groupJid = GROUP } = {}) {
  const c = new WhatsAppClient({ logger: silent, groupJid, storeDir, mode });
  c.sock = { user: { id: '447000000001:24@s.whatsapp.net', name: 'Me' } };
  return c;
}

/** A minimal inbound text message. */
function message({ from, id = `m${Math.floor(performance.now() * 1000)}`, fromMe = false, text = 'hello' }) {
  return {
    key: { remoteJid: from, id, fromMe, participant: from.endsWith('@g.us') ? CONTACT : undefined },
    message: { conversation: text },
    messageTimestamp: 1756000000,
    pushName: 'A Contact',
  };
}

test('the primary records the group; a secondary never does', async () => {
  const primary = client({ mode: 'primary' });
  const secondary = client({ mode: 'secondary', storeDir: path.join(ROOT, 'users', 'neil') });

  assert.equal(primary._processMessage(message({ from: GROUP }), { emit: false }), true);
  assert.equal(secondary._processMessage(message({ from: GROUP }), { emit: false }), false);

  assert.equal(primary.recent.length, 1);
  assert.equal(secondary.recent.length, 0, 'a group message in a secondary would be a duplicate');
  await primary._settleWrites();
  await secondary._settleWrites();
});

test('a 1:1 is recorded only if the counterparty is on that session\'s allow-set', async () => {
  const c = client({ mode: 'secondary', storeDir: path.join(ROOT, 'users', 'be') });
  c.setDirectPeers(['+447700900123']);

  assert.equal(c._processMessage(message({ from: CONTACT }), { emit: false }), true);
  assert.equal(c._processMessage(message({ from: STRANGER }), { emit: false }), false);

  assert.equal(c.recent.length, 1);
  assert.equal(c.recent[0].groupJid, CONTACT);
  await c._settleWrites();
});

test('each session has its own allow-set', async () => {
  const chris = client({ mode: 'primary' });
  const neil = client({ mode: 'secondary', storeDir: path.join(ROOT, 'users', 'n2') });
  chris.setDirectPeers(['+447700900123']);

  assert.equal(neil.directPeers.size, 0, 'pushing to one session must not touch another');
  assert.equal(neil._processMessage(message({ from: CONTACT }), { emit: false }), false);
  await Promise.all([chris._settleWrites(), neil._settleWrites()]);
});

test('setDirectPeers replaces, so removing a number revokes capture', async () => {
  const c = client();
  assert.equal(c.setDirectPeers(['+447700900123', '447700900999']), 2);
  assert.equal(c.setDirectPeers(['+447700900123']), 1);
  assert.ok(c.directPeers.has(CONTACT));
  assert.ok(!c.directPeers.has(STRANGER), 'a merge would make "delete the contact" a no-op');
  await c._settleWrites();
});

test('numbers in any human format land on the same JID', async () => {
  const c = client();
  c.setDirectPeers(['+44 7700 900123']);
  assert.ok(c.directPeers.has(CONTACT));
  await c._settleWrites();
});

test('two sessions write to two different files', async () => {
  const chrisDir = path.join(ROOT, 'iso-primary');
  const neilDir = path.join(ROOT, 'users', 'iso-neil');
  await fs.mkdir(chrisDir, { recursive: true });
  await fs.mkdir(neilDir, { recursive: true });

  const chris = client({ mode: 'primary', storeDir: chrisDir });
  const neil = client({ mode: 'secondary', storeDir: neilDir });
  chris.setDirectPeers(['+447700900123']);
  neil.setDirectPeers(['+447700900999']);

  chris._processMessage(message({ from: CONTACT, id: 'c1', text: 'for chris' }), { emit: false });
  neil._processMessage(message({ from: STRANGER, id: 'n1', text: 'for neil' }), { emit: false });
  await chris._settleWrites();
  await neil._settleWrites();

  const chrisBuf = JSON.parse(await fs.readFile(path.join(chrisDir, 'buffer.json'), 'utf-8'));
  const neilBuf = JSON.parse(await fs.readFile(path.join(neilDir, 'buffer.json'), 'utf-8'));
  assert.deepEqual(chrisBuf.map((m) => m.body), ['for chris']);
  assert.deepEqual(neilBuf.map((m) => m.body), ['for neil']);
});

test('an allow-set survives a restart', async () => {
  const dir = path.join(ROOT, 'users', 'restart');
  await fs.mkdir(dir, { recursive: true });
  const first = client({ mode: 'secondary', storeDir: dir });
  first.setDirectPeers(['+447700900123']);
  await first._settleWrites();

  // The gate is applied as each message arrives and history lands seconds after
  // a pair, so an allow-set that only existed in memory would lose all of it.
  const second = client({ mode: 'secondary', storeDir: dir });
  await second._loadDirectPeers();
  assert.ok(second.directPeers.has(CONTACT));
});

test('our own echo is retired even when the counterparty is off the allow-set', async () => {
  const c = client();
  c.sentByMe.add('echo-1');
  assert.equal(
    c._processMessage(message({ from: STRANGER, id: 'echo-1', fromMe: true }), { emit: false }),
    false,
  );
  assert.equal(c.sentByMe.size, 0, 'an unretired id leaks for the life of the process');
  await c._settleWrites();
});

test('direct=1 hides the group from the CRM', async () => {
  const c = client();
  c.setDirectPeers(['+447700900123']);
  c._processMessage(message({ from: GROUP, id: 'g1' }), { emit: false });
  c._processMessage(message({ from: CONTACT, id: 'd1' }), { emit: false });

  assert.equal(c.recentMessages({}).length, 2);
  const direct = c.recentMessages({ directOnly: true });
  assert.equal(direct.length, 1);
  assert.equal(direct[0].groupJid, CONTACT);
  await c._settleWrites();
});

test('a message we hold no number for is not stored anywhere', async () => {
  const dir = path.join(ROOT, 'users', 'nowhere');
  await fs.mkdir(dir, { recursive: true });
  const c = client({ mode: 'secondary', storeDir: dir });
  c._processMessage(message({ from: STRANGER, id: 's1' }), { emit: false });
  await c._settleWrites();

  const buf = JSON.parse(await fs.readFile(path.join(dir, 'buffer.json'), 'utf-8'));
  assert.deepEqual(buf, [], 'refused messages are dropped at ingest, not filtered later');
});

test('the legacy migration leaves the primary\'s store alone', async () => {
  // Every file the primary writes at /session root has to be on the shared
  // list. An unlisted one is taken for stray Baileys auth and moved into the
  // auth directory, which is how direct-peers.json would have been swallowed
  // on the next restart, silently switching capture off until the next sync.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-migrate-'));
  process.env.SESSION_DIR = dir;
  const { SessionManager: SM } = await import(`../src/manager.js?migrate=${Date.now()}`);

  for (const name of ['buffer.json', 'anchor.json', 'contacts.json', 'direct-peers.json']) {
    await fs.writeFile(path.join(dir, name), '[]');
  }
  await fs.writeFile(path.join(dir, 'creds.json'), '{}');  // genuinely stray auth

  const mgr = new SM({ logger: silent, groupJid: GROUP, primaryUserId: 'primary' });
  await mgr._migrateLegacyLayout();

  const rootAfter = await fs.readdir(dir);
  assert.ok(rootAfter.includes('direct-peers.json'), 'the allow-set must stay at root');
  assert.ok(rootAfter.includes('buffer.json'));
  assert.ok(!rootAfter.includes('creds.json'), 'stray auth should still be migrated');
  const moved = await fs.readdir(path.join(dir, 'baileys', 'primary'));
  assert.deepEqual(moved, ['creds.json']);

  process.env.SESSION_DIR = ROOT;
  await fs.rm(dir, { recursive: true, force: true });
});

test('a manager reports a session it does not have rather than guessing', () => {
  const mgr = new SessionManager({ logger: silent, groupJid: GROUP, primaryUserId: 'primary' });
  assert.throws(() => mgr.setPeersFor('nobody', ['+447700900123']), /not paired/);
  assert.throws(() => mgr.messagesFor('nobody', {}), /not paired/);
});
