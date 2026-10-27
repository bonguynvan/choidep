// Every Socket.IO event. One room per socket (query ?room=CODE); nothing crosses between rooms.
// Big screens (host page, OBS view) join `${code}:screen` and get positions 20x a second;
// phones only get their own state a few times a second, so 100 players stay light on the network.
import QRCode from 'qrcode';
import { PHASES, RULES } from '../shared/rules.js';

const MAX_EVENTS_PER_SEC = 40; // a joystick sends ~15 inputs a second
const AUTH_MAX_FAILURES = 5;
const AUTH_LOCKOUT_MS = 60000;
const ME_EVERY_TICKS = 5; // phones: own state 4x a second
const VIEW_EVERY_TICKS = 2; // phones: the arena around them 10x a second
const JOINS_PER_MINUTE = 10;

const asObject = (v) => (v && typeof v === 'object' ? v : {});
const asCallback = (fn) => (typeof fn === 'function' ? fn : () => {});
const screenOf = (code) => `${code}:screen`;

/** Client IP; behind our own reverse proxy (Caddy) the real one is in X-Forwarded-For. */
export function clientIp(headers, remoteAddress, trustProxy) {
  const forwarded = trustProxy ? String(headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
  const ip = forwarded || remoteAddress || 'unknown';
  // IPv6: one household / phone network gets a whole /64, so limits count the /64 as one client.
  return ip.includes(':') && !ip.startsWith('::ffff:') ? ip.split(':').slice(0, 4).join(':') : ip;
}

/** Base URL players should open (QR code / share links). */
export function publicBaseUrl(headers, { publicUrl, trustProxy }) {
  if (publicUrl) return publicUrl.replace(/\/+$/, '');
  const proto = trustProxy && headers['x-forwarded-proto'] ? String(headers['x-forwarded-proto']).split(',')[0] : 'http';
  return `${proto}://${headers.host ?? 'localhost'}`;
}

export const roomLinks = (base, code, hostKey) => ({
  playerUrl: `${base}/r/${code}`,
  hostUrl: `${base}/r/${code}/host?key=${hostKey}`,
  liveUrl: `${base}/r/${code}/live`,
});

function socketsIn(io, code) {
  const ids = io.sockets.adapter.rooms.get(code) ?? new Set();
  return [...ids].map((id) => io.sockets.sockets.get(id)).filter(Boolean);
}

/** Close one room now: tell everyone, then disconnect them. */
export function closeRoom(io, rooms, code) {
  const sockets = socketsIn(io, code);
  if (!rooms.close(code)) return false;
  sockets.forEach((s) => {
    s.emit('room:closed');
    s.disconnect(true);
  });
  return true;
}

export function sweepRooms(io, rooms, now) {
  const closed = rooms.sweep(now);
  closed.forEach((code) => socketsIn(io, code).forEach((s) => s.disconnect(true)));
  for (const entry of rooms.rooms.values()) if (entry.room.sweep(now)) entry.dirty = true;
  return closed;
}

/** Everyone playing in every room right now. */
const totalPlayers = (rooms) => [...rooms.rooms.values()].reduce((n, e) => n + e.room.players.size, 0);

export function registerSockets(io, rooms, { buildId, trustProxy, publicUrl, maxSocketsPerIp, maxPlayersTotal = Infinity, onMatchStart = () => {} }) {
  const socketsPerIp = new Map();
  const authFailures = new Map(); // "ip|room" -> { count, lockedUntil }

  io.use((socket, next) => {
    const entry = rooms.get(socket.handshake.query.room);
    if (!entry) return next(new Error('ROOM_NOT_FOUND'));
    const ip = clientIp(socket.handshake.headers, socket.handshake.address, trustProxy);
    const count = socketsPerIp.get(ip) ?? 0;
    if (count >= maxSocketsPerIp) return next(new Error('TOO_MANY_CONNECTIONS'));
    socketsPerIp.set(ip, count + 1);
    socket.data.ip = ip;
    socket.data.code = entry.code;
    socket.once('disconnect', () => {
      const left = (socketsPerIp.get(ip) ?? 1) - 1;
      if (left <= 0) socketsPerIp.delete(ip);
      else socketsPerIp.set(ip, left);
    });
    next();
  });

  io.on('connection', (socket) => {
    const code = socket.data.code;
    const entry = rooms.get(code);
    if (!entry) return socket.disconnect(true);
    const arena = entry.room;
    socket.join(code);
    rooms.connect(entry, Date.now());
    const changed = () => {
      entry.dirty = true;
      rooms.touch(entry, Date.now());
    };

    socket.emit('hello', { build: buildId, code });
    socket.emit('state', arena.snapshot(Date.now()));

    let windowStart = 0;
    let windowCount = 0;
    socket.use((packet, next) => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        windowCount = 0;
      }
      windowCount += 1;
      if (windowCount <= MAX_EVENTS_PER_SEC) return next();
      const ack = packet[packet.length - 1];
      if (typeof ack === 'function') ack({ error: 'Chậm lại chút nhé' });
    });

    let joinTimes = [];
    const joinAllowed = () => {
      const now = Date.now();
      joinTimes = [...joinTimes.filter((t) => now - t < 60000), now];
      return joinTimes.length <= JOINS_PER_MINUTE;
    };
    const bind = (player) => {
      socket.data.playerId = player.id;
      socket.emit('state', arena.snapshot(Date.now())); // the phone sees itself before the ack lands
      changed();
      return { ok: true, playerId: player.id, token: player.token };
    };

    // ---------- phones ----------
    socket.on('player:join', (data, cb) => {
      const reply = asCallback(cb);
      const existing = arena.players.get(socket.data.playerId);
      if (existing) return reply({ ok: true, playerId: existing.id, token: existing.token });
      if (!joinAllowed()) return reply({ error: 'Vào ra nhiều quá, đợi một phút nhé' });
      // Whole-server safety valve: past this, newcomers wait instead of everyone getting a laggy game.
      if (totalPlayers(rooms) >= maxPlayersTotal) return reply({ error: 'Máy chủ đang rất đông, thử lại sau ít phút nhé', busy: true });
      const { name, animal } = asObject(data);
      const result = arena.join(name, animal);
      return reply(result.error ? result : bind(result.player));
    });

    socket.on('player:resume', (data, cb) => {
      const reply = asCallback(cb);
      if (!joinAllowed()) return reply({ error: 'Vào ra nhiều quá, đợi một phút nhé' });
      const player = arena.resume(asObject(data).token);
      return reply(player ? bind(player) : { error: 'Phiên đã hết hạn', expired: true });
    });

    socket.on('player:character', (data, cb) => {
      const result = arena.setCharacter(socket.data.playerId, asObject(data).animal);
      if (!result.error) changed();
      asCallback(cb)(result);
    });

    socket.on('player:leave', (cb) => {
      if (socket.data.playerId) arena.remove(socket.data.playerId);
      socket.data.playerId = null;
      changed();
      asCallback(cb)({ ok: true });
    });

    // Joystick: fire and forget, many per second.
    socket.on('input', (data) => {
      const { dx, dy } = asObject(data);
      arena.setInput(socket.data.playerId, Number(dx), Number(dy));
    });

    socket.on('throw', (cb) => {
      asCallback(cb)(arena.throwFrom(socket.data.playerId, Date.now()));
    });

    // ---------- big screens ----------
    socket.on('screen:watch', (cb) => {
      socket.join(screenOf(code));
      asCallback(cb)({ ok: true });
    });

    socket.on('host:auth', async (data, cb) => {
      const reply = asCallback(cb);
      const failKey = `${socket.data.ip}|${code}`;
      const failures = authFailures.get(failKey) ?? { count: 0, lockedUntil: 0 };
      if (Date.now() < failures.lockedUntil) return reply({ error: 'Thử sai quá nhiều, đợi 1 phút' });
      if (!rooms.isHostKey(entry, asObject(data).key)) {
        const count = failures.count + 1;
        authFailures.set(failKey, count >= AUTH_MAX_FAILURES ? { count: 0, lockedUntil: Date.now() + AUTH_LOCKOUT_MS } : { count, lockedUntil: 0 });
        return reply({ error: 'Sai link host' });
      }
      authFailures.delete(failKey);
      socket.data.isHost = true;
      rooms.claim?.(entry, Date.now());
      socket.join(screenOf(code));
      const links = roomLinks(publicBaseUrl(socket.handshake.headers, { publicUrl, trustProxy }), code, entry.hostKey);
      let qr = null;
      try {
        qr = await QRCode.toDataURL(links.playerUrl, { margin: 1, width: 360 });
      } catch {
        // the link still works without a QR
      }
      return reply({ ok: true, code, joinUrl: links.playerUrl, liveUrl: links.liveUrl, qr });
    });

    const hostAction = (event, action) => {
      socket.on(event, (data, cb) => {
        const reply = asCallback(typeof data === 'function' ? data : cb);
        if (!socket.data.isHost) return reply({ error: 'Chỉ host mới làm được' });
        const result = action(asObject(data));
        reply(result.error ? result : { ok: true });
        if (!result.error) changed();
      });
    };
    hostAction('host:start', () => {
      const result = arena.start(Date.now());
      if (!result.error) onMatchStart(arena.players.size);
      return result;
    });
    hostAction('host:lobby', () => arena.backToLobby());
    hostAction('host:teams', ({ teams }) => arena.setTeams(Number(teams)));
    hostAction('host:shuffle', () => arena.shuffle());
    hostAction('host:duration', ({ seconds }) => arena.setDuration(Number(seconds)));
    hostAction('host:title', ({ title }) => arena.setTitle(title));
    hostAction('host:bots', ({ count }) => arena.addBots(Number(count)));
    hostAction('host:removeBots', () => arena.removeBots());
    hostAction('host:kick', ({ id }) => {
      const result = arena.kick(id);
      if (!result.error) {
        socketsIn(io, code).filter((s) => s.data.playerId === id).forEach((s) => {
          s.data.playerId = null;
          s.emit('kicked');
        });
      }
      return result;
    });

    socket.on('disconnect', () => {
      rooms.disconnect(entry, Date.now());
      const id = socket.data.playerId;
      if (!id) return;
      const stillHere = socketsIn(io, code).some((s) => s !== socket && s.data.playerId === id);
      if (!stillHere && arena.disconnect(id, Date.now())) changed();
    });
  });

  return {
    prune(now) {
      for (const [key, f] of authFailures) if (f.lockedUntil < now) authFailures.delete(key);
    },
  };
}

/**
 * One tick for every room: advance the match, send positions to big screens, effects to whoever
 * they concern, a phone's own state now and then, and the roster when it changed.
 */
export function tickRooms(io, rooms, now, tick) {
  for (const entry of rooms.rooms.values()) {
    const arena = entry.room;
    const before = arena.phase;
    const live = arena.phase === PHASES.COUNTDOWN || arena.phase === PHASES.PLAYING;
    if (live) {
      const events = arena.step(now, RULES.tickMs / 1000);
      io.to(screenOf(entry.code)).volatile.emit('frame', arena.frame(now));
      if (events.length > 0) {
        io.to(screenOf(entry.code)).emit('fx', events);
        // A team out / a zone taken: every phone shows the banner, and the timer may have been cut short.
        const forAll = events.filter((e) => e.type === 'wipe' || e.type === 'capture');
        if (forAll.length > 0) entry.dirty = true;
        const touched = new Set(events.flatMap((e) => [e.to, e.from]).filter(Boolean));
        if (touched.size > 0 || forAll.length > 0) {
          socketsIn(io, entry.code).forEach((s) => {
            const id = s.data.playerId;
            if (!id) return;
            const mine = events.filter((e) => forAll.includes(e) || e.to === id || e.from === id);
            if (mine.length > 0) s.emit('me:fx', mine);
          });
        }
      }
    }
    if (live && tick % VIEW_EVERY_TICKS === 0) {
      socketsIn(io, entry.code).forEach((s) => {
        if (s.data.playerId) s.volatile.emit('view', arena.viewFor(s.data.playerId, now));
      });
    }
    if (arena.phase !== before) entry.dirty = true;
    if (tick % ME_EVERY_TICKS === 0 && (live || entry.dirty)) {
      socketsIn(io, entry.code).forEach((s) => {
        if (s.data.playerId) s.volatile.emit('me', arena.controllerState(s.data.playerId, now));
      });
    }
    if (entry.dirty) {
      entry.dirty = false;
      io.to(entry.code).emit('state', arena.snapshot(now));
    }
  }
}
