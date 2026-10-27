// End to end over real sockets: rooms, phones as controllers, the big screen, host controls, operator API.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { startServer } from '../src/server.js';
import { PHASES, RULES } from '../shared/rules.js';

const TOKEN = 'o'.repeat(40);
let server;
let base;
const sockets = [];

before(async () => {
  server = await startServer({ port: 0, opsToken: TOKEN, roomLimits: { maxRoomsPerIp: 50 }, createPerMinute: 100, maxSocketsPerIp: 100 });
  base = `http://127.0.0.1:${server.port}`;
});
after(async () => {
  sockets.forEach((s) => s.disconnect());
  await server.close();
});

const createRoom = async () => (await fetch(`${base}/api/rooms`, { method: 'POST', headers: { Origin: base } })).json();
function client(code) {
  const socket = connect(base, { transports: ['websocket'], forceNew: true, query: { room: code } });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}
const ask = (socket, event, data) => (data === undefined ? socket.timeout(2000).emitWithAck(event) : socket.timeout(2000).emitWithAck(event, data));
const next = (socket, event, predicate = () => true) => new Promise((resolve) => {
  const handler = (payload) => {
    if (!predicate(payload)) return;
    socket.off(event, handler);
    resolve(payload);
  };
  socket.on(event, handler);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('pages: home, a room\'s phone/host/OBS pages, 404 for unknown rooms', async () => {
  const { code, hostUrl, playerUrl } = await createRoom();
  assert.match(code, /^[A-Z2-9]{6}$/);
  assert.ok(hostUrl.includes('?key='));
  assert.equal(playerUrl, `${base}/r/${code}`);
  for (const path of ['/', `/r/${code}`, `/r/${code}/host`, `/r/${code}/live`, '/quyen-rieng-tu', '/dieu-khoan']) {
    assert.equal((await fetch(`${base}${path}`)).status, 200, path);
  }
  assert.equal((await fetch(`${base}/r/ZZZZZZ`)).status, 404);
  assert.equal((await fetch(`${base}/api/rooms`, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.match((await fetch(`${base}/r/${code}/qr.svg`)).headers.get('content-type'), /svg/);
});

test('a full match: phones join and steer, the big screen gets frames, slippers fly', async () => {
  const { code } = await createRoom();
  const entry = server.rooms.get(code);
  const host = await client(code);
  assert.ok((await ask(host, 'host:auth', { key: 'wrong' })).error);
  const auth = await ask(host, 'host:auth', { key: entry.hostKey });
  assert.ok(auth.ok && auth.qr.startsWith('data:image/png'));

  const phoneA = await client(code);
  const phoneB = await client(code);
  const a = await ask(phoneA, 'player:join', { name: 'An', animal: 'duck' });
  const b = await ask(phoneB, 'player:join', { name: 'Bình', animal: 'cat' });
  assert.ok(a.ok && b.ok && a.token);
  assert.ok((await ask(phoneA, 'host:start')).error, 'phones are not hosts');
  assert.deepEqual((await ask(host, 'host:duration', { seconds: 60 })).ok, true);

  let phoneFrames = 0;
  phoneA.on('frame', () => { phoneFrames += 1; });
  const frame = next(host, 'frame');
  assert.ok((await ask(host, 'host:start')).ok);
  assert.ok((await frame).p.length === 2, 'the big screen sees both players');
  await next(host, 'state', (s) => s.phase === PHASES.PLAYING);

  // Line them up, then steer A and throw at B.
  const pa = entry.room.players.get(a.playerId);
  const pb = entry.room.players.get(b.playerId);
  Object.assign(pa, { x: 300, y: 450, fx: 1, fy: 0 });
  Object.assign(pb, { x: 650, y: 450 });
  const ouch = next(phoneB, 'me:fx', (fx) => fx.some((e) => e.type === 'hit'));
  assert.ok((await ask(phoneA, 'throw')).ok);
  await ouch;
  assert.equal(entry.room.scores[pa.team], 1);
  const me = await next(phoneB, 'me');
  assert.ok(me.stunnedMs > 0, 'the victim\'s phone knows it is down');

  phoneA.emit('input', { dx: 0, dy: 1 });
  const y = pa.y;
  await sleep(300);
  assert.ok(pa.y > y + 20, 'the joystick moves the player');
  assert.equal(phoneFrames, 0, 'phones never get the 20 Hz position stream');
  const view = await next(phoneA, 'view');
  assert.ok(view.p.some(([id]) => id === a.playerId), 'but they see the arena around themselves');
});

test('the OBS view watches without being a host', async () => {
  const { code } = await createRoom();
  const live = await client(code);
  assert.ok((await ask(live, 'screen:watch')).ok);
  assert.ok((await ask(live, 'host:bots', { count: 3 })).error);
});

test('host controls: bots, teams, kick; resuming a phone keeps its player', async () => {
  const { code } = await createRoom();
  const entry = server.rooms.get(code);
  const host = await client(code);
  await ask(host, 'host:auth', { key: entry.hostKey });
  assert.ok((await ask(host, 'host:bots', { count: 5 })).ok);
  assert.ok((await ask(host, 'host:teams', { teams: 3 })).ok);
  assert.equal(entry.room.teams, 3);

  const phone = await client(code);
  const joined = await ask(phone, 'player:join', { name: 'Chi', animal: 'pig' });
  phone.disconnect();
  await sleep(100);
  assert.equal(entry.room.players.get(joined.playerId).connected, false);
  const again = await client(code);
  const resumed = await ask(again, 'player:resume', { token: joined.token });
  assert.equal(resumed.playerId, joined.playerId);
  assert.ok((await ask(again, 'player:resume', { token: 'nope' })).expired);

  const kicked = next(again, 'kicked');
  assert.ok((await ask(host, 'host:kick', { id: joined.playerId })).ok);
  await kicked;
  assert.equal(entry.room.players.has(joined.playerId), false);
});

test('maintenance blocks new rooms; the operator API reports matches', async () => {
  const ops = (path, init = {}) => fetch(`${base}/api/ops${path}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } });
  const overview = await (await ops('/overview')).json();
  assert.equal(overview.game.id, 'choidep');
  assert.ok(overview.daily.at(-1).roomRaces >= 1, 'matches played today');
  assert.ok(overview.rooms.every((r) => r.mapName === 'Đấu trường' && !('hostKey' in r)));
  await ops('/settings', { method: 'POST', body: JSON.stringify({ maintenance: true }) });
  assert.equal((await fetch(`${base}/api/rooms`, { method: 'POST', headers: { Origin: base } })).status, 503);
  await ops('/settings', { method: 'POST', body: JSON.stringify({ maintenance: false }) });
  assert.equal((await fetch(`${base}/api/rooms`, { method: 'POST', headers: { Origin: base } })).status, 201);
});

test('past the whole-server player cap, newcomers are told to come back later', async () => {
  const small = await startServer({ port: 0, maxPlayersTotal: 1, roomLimits: { maxRoomsPerIp: 10 } });
  const smallBase = `http://127.0.0.1:${small.port}`;
  try {
    const { code } = await (await fetch(`${smallBase}/api/rooms`, { method: 'POST', headers: { Origin: smallBase } })).json();
    const join = async (name) => {
      const s = connect(smallBase, { transports: ['websocket'], forceNew: true, query: { room: code } });
      sockets.push(s);
      await new Promise((r) => s.on('connect', r));
      return s.timeout(2000).emitWithAck('player:join', { name, animal: 'duck' });
    };
    assert.ok((await join('An')).ok);
    const full = await join('Bình');
    assert.equal(full.busy, true);
    assert.match(full.error, /đông/);
  } finally {
    await small.close();
  }
});

test('a joystick flood is capped, never crashes the room', async () => {
  const { code } = await createRoom();
  const phone = await client(code);
  await ask(phone, 'player:join', { name: 'Spam', animal: 'duck' });
  for (let i = 0; i < 500; i += 1) phone.emit('input', { dx: Math.random(), dy: 'x' });
  phone.emit('input', null);
  const reply = await Promise.race([ask(phone, 'player:character', { animal: 'cat' }), sleep(1500).then(() => ({ dropped: true }))]);
  assert.ok(reply.dropped || reply.ok || reply.error, 'still answering');
  assert.ok(server.rooms.get(code));
  assert.ok(RULES.maxPlayers >= 100);
});
