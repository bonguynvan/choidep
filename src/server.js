import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import QRCode from 'qrcode';
import { Server } from 'socket.io';
import { RoomManager } from './rooms/roomManager.js';
import { openDatabase } from './db.js';
import { clientIp, closeRoom, publicBaseUrl, registerSockets, roomLinks, sweepRooms, tickRooms } from './sockets.js';
import { isGa4Id } from '../shared/analyticsUrl.js';
import { RULES } from '../shared/rules.js';
import { DailyStats } from './stats.js';
import { Settings } from './settings.js';
import { registerOps } from './ops.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const SWEEP_MS = 60 * 1000;
const CREATE_WINDOW_MS = 60 * 1000;
const MAINTENANCE_MESSAGE = 'Đang bảo trì: tạm thời chưa tạo được phòng mới. Phòng đang chơi vẫn chơi bình thường.';

// Google Analytics hosts, allowed only when a GA4_ID is configured.
const GA_SCRIPT = 'https://www.googletagmanager.com';
const GA_HOSTS = 'https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com';
const cspFor = (analytics) => [
  "default-src 'self'",
  `script-src 'self'${analytics ? ` ${GA_SCRIPT}` : ''}`,
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  `img-src 'self' data:${analytics ? ` ${GA_HOSTS}` : ''}`,
  "media-src 'self' blob:",
  `connect-src 'self' ws: wss:${analytics ? ` ${GA_HOSTS}` : ''}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = (csp) => (_req, res, next) => {
  res.set({
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', // keeps ?key=… host links out of Referer headers
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
};

/** Reject cross-site WebSocket/polling requests (another site's page driving our sockets). */
function sameOriginSocket(req, cb) {
  const origin = req.headers.origin;
  if (!origin) return cb(null, true); // non-browser clients
  try {
    cb(null, new URL(origin).host === req.headers.host);
  } catch {
    cb(null, false);
  }
}

/** State-changing requests must come from our own pages. */
export function isSameOrigin(req) {
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function createLimiter(maxPerWindow) {
  const hits = new Map();
  const allow = (ip, now) => {
    const slot = hits.get(ip);
    if (!slot || now - slot.start >= CREATE_WINDOW_MS) {
      hits.set(ip, { start: now, count: 1 });
      return true;
    }
    slot.count += 1;
    return slot.count <= maxPerWindow;
  };
  allow.prune = (now) => {
    for (const [ip, slot] of hits) if (now - slot.start >= CREATE_WINDOW_MS) hits.delete(ip);
  };
  return allow;
}

/**
 * @param {{ port?: number, publicUrl?: string, trustProxy?: boolean, roomLimits?: object, maxSocketsPerIp?: number,
 *   createPerMinute?: number, createRoom?: () => import('./game/arena.js').Arena, db?: import('node:sqlite').DatabaseSync,
 *   ga4Id?: string, opsToken?: string }} [opts]
 */
export async function startServer({
  port = 3000,
  publicUrl = '',
  trustProxy = false,
  roomLimits = {},
  maxSocketsPerIp = 10,
  createPerMinute = 5,
  createRoom,
  db = openDatabase(':memory:'),
  ga4Id = '',
  opsToken = '',
} = {}) {
  const analyticsId = isGa4Id(ga4Id) ? ga4Id : null;
  const rooms = new RoomManager({ ...roomLimits, createRoom });
  const baseUrl = (req) => publicBaseUrl(req.headers, { publicUrl, trustProxy });
  const allowCreate = createLimiter(createPerMinute);
  const stats = new DailyStats(db);
  const settings = new Settings(db);
  const buildId = randomBytes(4).toString('hex'); // open tabs reload when the server restarts with a new one

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders(cspFor(Boolean(analyticsId))));
  app.get('/analytics-config.js', (_req, res) => {
    res.type('application/javascript').set('Cache-Control', 'no-cache').send(`export const GA4_ID = ${JSON.stringify(analyticsId)};\n`);
  });

  // Static assets only (pages are served by the routes below, never by path).
  const noCache = (res) => res.set('Cache-Control', 'no-cache');
  for (const dir of ['css', 'js']) app.use(`/${dir}`, express.static(path.join(PUBLIC, dir), { setHeaders: noCache, index: false }));
  app.use('/shared', express.static(path.join(ROOT, 'shared'), { setHeaders: noCache, index: false }));
  app.get('/favicon.svg', (_req, res) => res.set('Cache-Control', 'public, max-age=86400').sendFile(path.join(PUBLIC, 'favicon.svg')));
  app.get('/favicon.ico', (_req, res) => res.redirect(301, '/favicon.svg'));

  const page = (file) => (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(PUBLIC, file));
  const notFound = (res) => res.status(404).set('Cache-Control', 'no-cache').sendFile(path.join(PUBLIC, 'missing.html'));
  const roomPage = (file) => (req, res) => (rooms.get(req.params.code) ? page(file)(req, res) : notFound(res));

  app.get('/', page('home.html'));
  app.get('/dieu-khoan', page('terms.html'));
  app.get('/quyen-rieng-tu', page('privacy.html'));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/r/:code', roomPage('play.html')); // phone controller
  app.get('/r/:code/host', roomPage('host.html')); // big screen + host controls
  app.get('/r/:code/live', roomPage('live.html')); // OBS browser source: arena only
  app.get('/r/:code/qr.svg', async (req, res) => {
    const entry = rooms.get(req.params.code);
    if (!entry) return res.status(404).end();
    const svg = await QRCode.toString(`${baseUrl(req)}/r/${entry.code}`, { type: 'svg', margin: 1 });
    return res.type('image/svg+xml').set('Cache-Control', 'no-cache').send(svg);
  });

  app.get('/api/status', (_req, res) => res.set('Cache-Control', 'no-store').json(settings.get()));
  app.post('/api/rooms', (req, res) => {
    const now = Date.now();
    if (!isSameOrigin(req)) return res.status(403).json({ error: 'Yêu cầu không hợp lệ' });
    if (settings.get().maintenance) return res.status(503).json({ error: MAINTENANCE_MESSAGE, maintenance: true });
    const ip = clientIp(req.headers, req.socket.remoteAddress, trustProxy);
    if (!allowCreate(ip, now)) return res.status(429).json({ error: 'Tạo phòng nhanh quá, đợi một phút nhé' });
    const result = rooms.create({ ip, now });
    if (result.error) return res.status(result.status).json({ error: result.error });
    stats.add('roomsCreated', 1, now);
    const { code, hostKey } = result.entry;
    return res.status(201).json({ code, ...roomLinks(baseUrl(req), code, hostKey) });
  });

  const httpServer = createServer(app);
  const io = new Server(httpServer, { serveClient: true, maxHttpBufferSize: 4096, allowRequest: sameOriginSocket });
  const startedAt = Date.now();
  const sockets = registerSockets(io, rooms, {
    buildId, trustProxy, publicUrl, maxSocketsPerIp,
    onMatchStart: (players) => {
      const now = Date.now();
      stats.add('roomRaces', 1, now); // the dashboard's "races" are matches here
      stats.add('roomRacers', players, now);
    },
  });
  registerOps(app, {
    token: opsToken,
    game: { id: 'choidep', name: 'Chọi dép', url: publicUrl },
    rooms,
    closeRoom: (code) => closeRoom(io, rooms, code),
    stats,
    settings,
    onSettings: (next) => io.emit('status', next),
    startedAt,
  });
  app.use((_req, res) => notFound(res));

  let tick = 0;
  const ticker = setInterval(() => {
    tick += 1;
    tickRooms(io, rooms, Date.now(), tick);
  }, RULES.tickMs);
  const sweeper = setInterval(() => {
    const now = Date.now();
    sweepRooms(io, rooms, now);
    stats.peak('peakPlayers', rooms.list(now).reduce((n, r) => n + r.players, 0), now);
    allowCreate.prune(now);
    sockets.prune(now);
  }, SWEEP_MS);

  await new Promise((resolve) => httpServer.listen(port, '0.0.0.0', resolve));
  return {
    port: httpServer.address().port,
    rooms,
    io,
    stats,
    settings,
    close: () => new Promise((resolve) => {
      clearInterval(ticker);
      clearInterval(sweeper);
      io.close(() => resolve());
    }),
  };
}
