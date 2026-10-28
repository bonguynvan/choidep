// Load test: fake phones (socket.io clients) per room, each steering 15x a second and throwing about once a
// second, plus one big screen per room. The server runs as its own process so the fake phones don't skew its
// CPU numbers; its health comes from the operator API (CPU %, event-loop lag).
// Usage: node tools/loadtest.js [playersPerRoom=150] [rooms=1] [seconds=40]
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

const [PLAYERS = 150, ROOMS = 1, SECONDS = 40] = process.argv.slice(2).map(Number);
const PORT = 3099;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'l'.repeat(40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (list, p) => (list.length ? [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * p))] : 0);

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
  env: {
    ...process.env, PORT: String(PORT), OPS_TOKEN: TOKEN, DB_PATH: ':memory:', NODE_ENV: 'development',
    MAX_SOCKETS_PER_IP: '100000', MAX_ROOMS_PER_IP: '1000', ROOMS_CREATE_PER_MINUTE: '1000', MAX_PLAYERS_TOTAL: '100000',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const stop = () => server.kill();
process.on('exit', stop);

async function waitUp() {
  for (let i = 0; i < 50; i += 1) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch { /* not yet */ }
    await sleep(200);
  }
  throw new Error('server did not start');
}

const health = async () => (await fetch(`${BASE}/api/ops/overview`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();

function connect(code) {
  const socket = io(BASE, { transports: ['websocket'], forceNew: true, query: { room: code }, reconnection: false });
  socket.bytes = 0;
  socket.on('connect', () => socket.io.engine.on('packet', (p) => { socket.bytes += typeof p.data === 'string' ? p.data.length : 0; }));
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

const stats = { joined: 0, joinErrors: 0, connectErrors: 0, throwRtt: [], throws: 0, throwErrors: 0 };
const phones = [];
const screens = [];

async function room(r) {
  const { code, hostUrl } = await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { Origin: BASE } })).json();
  const key = new URL(hostUrl).searchParams.get('key');
  const screen = await connect(code);
  await screen.timeout(5000).emitWithAck('host:auth', { key });
  await screen.timeout(5000).emitWithAck('host:duration', { seconds: 300 });
  screens.push(screen);
  // People arrive in waves, like a streamer's audience scanning the QR.
  for (let i = 0; i < PLAYERS; i += 1) {
    connect(code).then(async (phone) => {
      const reply = await phone.timeout(10000).emitWithAck('player:join', { name: `R${r}P${i}`, animal: 'duck' }).catch(() => ({ error: 'timeout' }));
      if (reply.error) {
        stats.joinErrors += 1;
        return;
      }
      stats.joined += 1;
      phones.push(phone);
    }).catch(() => { stats.connectErrors += 1; });
    if (i % 25 === 24) await sleep(250);
  }
  await sleep(3000);
  await screen.timeout(5000).emitWithAck('host:start');
}

function play(phone) {
  let angle = Math.random() * Math.PI * 2;
  phone.steer = setInterval(() => {
    if (Math.random() < 0.07) angle = Math.random() * Math.PI * 2;
    phone.emit('input', { dx: Math.cos(angle), dy: Math.sin(angle) });
  }, 66);
  const throwLoop = () => {
    phone.thrower = setTimeout(async () => {
      const t0 = performance.now();
      const reply = await phone.timeout(5000).emitWithAck('throw').catch(() => ({ error: 'timeout' }));
      stats.throws += 1;
      if (reply.error === 'timeout') stats.throwErrors += 1;
      else stats.throwRtt.push(performance.now() - t0);
      throwLoop();
    }, 800 + Math.random() * 700);
  };
  throwLoop();
}

await waitUp();
console.log(`Load test: ${ROOMS} room(s) x ${PLAYERS} phones, ${SECONDS}s of play`);
await health(); // reset the server's counters
await Promise.all(Array.from({ length: ROOMS }, (_, r) => room(r)));
console.log(`joined ${stats.joined}/${PLAYERS * ROOMS} (join errors ${stats.joinErrors}, connect errors ${stats.connectErrors})`);
phones.forEach(play);
await sleep(4000); // countdown
phones.forEach((s) => { s.bytes = 0; });
screens.forEach((s) => { s.bytes = 0; });
stats.throwRtt = [];

const samples = [];
for (let t = 0; t < SECONDS; t += 5) {
  await sleep(5000);
  const h = await health();
  samples.push(h.health);
  console.log(`t=${t + 5}s cpu ${h.health.cpuPercent}% · loop lag p99 ${h.health.loopLagP99Ms} ms (max ${h.health.loopLagMaxMs}) · mem ${h.memoryMb} MB · players ${h.live.players} · matches ${h.daily.at(-1).roomRaces}`);
}

const phoneKBs = phones.reduce((n, s) => n + s.bytes, 0) / phones.length / SECONDS / 1024;
const screenKBs = screens.reduce((n, s) => n + s.bytes, 0) / screens.length / SECONDS / 1024;
const totalMbps = ((phones.reduce((n, s) => n + s.bytes, 0) + screens.reduce((n, s) => n + s.bytes, 0)) * 8) / SECONDS / 1e6;
console.log('\n=== Result ===');
console.log(`server CPU avg ${Math.round(samples.reduce((n, s) => n + s.cpuPercent, 0) / samples.length)}% · max ${Math.max(...samples.map((s) => s.cpuPercent))}% (100% = one core)`);
console.log(`event-loop lag p99 worst ${Math.max(...samples.map((s) => s.loopLagP99Ms))} ms · max ${Math.max(...samples.map((s) => s.loopLagMaxMs))} ms`);
console.log(`throw round trip p50 ${pct(stats.throwRtt, 0.5).toFixed(1)} ms · p99 ${pct(stats.throwRtt, 0.99).toFixed(1)} ms · timeouts ${stats.throwErrors}/${stats.throws}`);
console.log(`download per phone ${phoneKBs.toFixed(1)} KB/s · per big screen ${screenKBs.toFixed(1)} KB/s · server upload total ${totalMbps.toFixed(1)} Mbit/s`);

phones.forEach((s) => { clearInterval(s.steer); clearTimeout(s.thrower); s.disconnect(); });
screens.forEach((s) => s.disconnect());
stop();
process.exit(0);
