// One room's match: lobby -> countdown -> playing -> finished. The server owns the simulation;
// phones only send a direction and "throw", the big screen draws what step()/frame() report.
import { randomBytes } from 'node:crypto';
import { ANIMALS, FACE_COLORS, findAnimal, initialsOf } from '../../shared/catalog.js';
import { ARENA, FLAGS, PHASES, PICKUPS, RULES, TEAMS, fieldFor } from '../../shared/rules.js';
import { sanitizeText } from '../text.js';

const BOT_NAMES = ['Bông', 'Mít', 'Su Su', 'Bắp', 'Tôm', 'Kem', 'Na', 'Cốm', 'Xoài', 'Mochi', 'Gấu', 'Tí', 'Tèo', 'Bin', 'Bơ'];
const AIM_COS = Math.cos(((RULES.aimConeDeg / 2) * Math.PI) / 180);
const R = RULES.playerRadius;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

export const sanitizeName = (raw) => sanitizeText(raw, { maxLength: RULES.nameMaxLength, requireLetter: true });

/** The strip of the field a team starts in: vertical strips from left to right. */
function teamZone(team, teams, field) {
  const w = field.width / teams;
  return { x0: team * w + R * 2, x1: (team + 1) * w - R * 2, y0: RULES.topMargin + R, y1: field.height - R * 2 };
}

export class Arena {
  /** @param {{ rng?: () => number }} [opts] rng: inject a seeded one in tests */
  constructor({ rng = Math.random } = {}) {
    this.rng = rng;
    this.phase = PHASES.LOBBY;
    this.mapId = 'arena';
    this.field = { ...ARENA }; // set for each match by the number of players (fieldFor)
    this.title = '';
    this.teams = 2;
    this.durationSec = RULES.defaultDurationSec;
    this.players = new Map();
    this.projectiles = [];
    this.pickups = [];
    this.scores = [0, 0, 0, 0];
    this.startsAt = null;
    this.endsAt = null;
    this.results = null;
    this.seq = 0;
    this.nextPickupAt = 0;
  }

  // ---------------- people ----------------

  #newId(prefix) {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }

  /** Smallest team first (ties: lowest id), so teams stay even as people drop in. */
  #pickTeam() {
    const counts = Array.from({ length: this.teams }, (_, t) => [...this.players.values()].filter((p) => p.team === t).length);
    return counts.indexOf(Math.min(...counts));
  }

  #spawn(player) {
    const zone = teamZone(player.team, this.teams, this.field);
    player.x = zone.x0 + this.rng() * (zone.x1 - zone.x0);
    player.y = zone.y0 + this.rng() * (zone.y1 - zone.y0);
    player.fx = player.team < this.teams / 2 ? 1 : -1; // face the middle of the field
    player.fy = 0;
  }

  #create(name, animal, extra = {}) {
    const player = {
      id: this.#newId(extra.isBot ? 'b' : 'p'),
      token: randomBytes(16).toString('hex'),
      name,
      initials: initialsOf(name),
      color: FACE_COLORS[this.seq % FACE_COLORS.length],
      animal: findAnimal(animal) ? animal : ANIMALS[Math.floor(this.rng() * ANIMALS.length)].id,
      team: this.#pickTeam(),
      connected: true,
      disconnectedAt: null,
      isBot: false,
      x: 0, y: 0, fx: 1, fy: 0, dx: 0, dy: 0,
      stunnedUntil: 0, shieldUntil: 0, cooldownUntil: 0, teaUntil: 0,
      helmet: false, power: null,
      hits: 0, hitsTaken: 0,
      ...extra,
    };
    this.#spawn(player);
    this.players.set(player.id, player);
    return player;
  }

  join(rawName, animal) {
    const name = sanitizeName(rawName);
    if (!name) return { error: 'Tên cần có chữ hoặc số (tối đa 16 ký tự)' };
    if (this.players.size >= RULES.maxPlayers) return { error: 'Phòng đã đầy' };
    if ([...this.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase())) return { error: 'Tên này có người dùng rồi' };
    return { player: this.#create(name, animal) };
  }

  resume(token) {
    const player = typeof token === 'string' ? [...this.players.values()].find((p) => p.token === token && !p.isBot) : null;
    if (!player) return null;
    player.connected = true;
    player.disconnectedAt = null;
    return player;
  }

  disconnect(id, now) {
    const player = this.players.get(id);
    if (!player) return false;
    player.connected = false;
    player.disconnectedAt = now;
    player.dx = 0;
    player.dy = 0;
    return true;
  }

  remove(id) {
    return this.players.delete(id);
  }

  /** Lobby clean-up: phones gone for a long time leave for good. */
  sweep(now) {
    if (this.phase !== PHASES.LOBBY) return false;
    let changed = false;
    for (const p of this.players.values()) {
      if (!p.connected && now - p.disconnectedAt > RULES.lobbyGraceMs) changed = this.players.delete(p.id) || changed;
    }
    return changed;
  }

  setCharacter(id, animal) {
    const player = this.players.get(id);
    if (!player || !findAnimal(animal)) return { error: 'Nhân vật không hợp lệ' };
    player.animal = animal;
    return { ok: true };
  }

  addBots(count) {
    const bots = [...this.players.values()].filter((p) => p.isBot).length;
    const n = clamp(Math.floor(count) || 0, 0, RULES.maxBots - bots);
    if (n === 0) return { error: `Tối đa ${RULES.maxBots} bot` };
    for (let i = 0; i < n; i += 1) {
      if (this.players.size >= RULES.maxPlayers) break;
      const name = `${BOT_NAMES[(bots + i) % BOT_NAMES.length]} 🤖${bots + i + 1}`;
      this.#create(name, null, { isBot: true });
    }
    return { ok: true };
  }

  removeBots() {
    for (const p of this.players.values()) if (p.isBot) this.players.delete(p.id);
    return { ok: true };
  }

  kick(id) {
    return this.players.delete(id) ? { ok: true } : { error: 'Không tìm thấy người chơi' };
  }

  // ---------------- host settings ----------------

  #inLobby() {
    return this.phase === PHASES.LOBBY || this.phase === PHASES.FINISHED;
  }

  setTeams(n) {
    if (!RULES.teamChoices.includes(n)) return { error: 'Số đội không hợp lệ' };
    if (!this.#inLobby()) return { error: 'Đang chơi, đổi sau nhé' };
    this.teams = n;
    return this.shuffle();
  }

  /** Deal everyone into teams again, evenly and at random. */
  shuffle() {
    if (!this.#inLobby()) return { error: 'Đang chơi, đổi sau nhé' };
    const list = [...this.players.values()];
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.rng() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    list.forEach((p, i) => {
      p.team = i % this.teams;
      this.#spawn(p);
    });
    return { ok: true };
  }

  setDuration(sec) {
    if (!RULES.durationChoices.includes(sec)) return { error: 'Thời lượng không hợp lệ' };
    if (!this.#inLobby()) return { error: 'Đang chơi, đổi sau nhé' };
    this.durationSec = sec;
    return { ok: true };
  }

  setTitle(raw) {
    if (raw === '' || raw === null) {
      this.title = '';
      return { ok: true };
    }
    const title = sanitizeText(raw, { maxLength: RULES.titleMaxLength });
    if (!title) return { error: 'Tên trận không hợp lệ' };
    this.title = title;
    return { ok: true };
  }

  // ---------------- match flow ----------------

  start(now) {
    if (!this.#inLobby()) return { error: 'Trận đang diễn ra' };
    if (this.players.size < 2) return { error: 'Cần ít nhất 2 người (có thể thêm bot)' };
    this.field = fieldFor(this.players.size);
    this.phase = PHASES.COUNTDOWN;
    this.startsAt = now + RULES.countdownMs;
    this.endsAt = this.startsAt + this.durationSec * 1000;
    this.scores = [0, 0, 0, 0];
    this.results = null;
    this.projectiles = [];
    this.pickups = [];
    this.nextPickupAt = this.startsAt + RULES.pickupEveryMs;
    for (const p of this.players.values()) {
      Object.assign(p, { hits: 0, hitsTaken: 0, stunnedUntil: 0, shieldUntil: 0, cooldownUntil: 0, teaUntil: 0, helmet: false, power: null, dx: 0, dy: 0 });
      this.#spawn(p);
    }
    return { ok: true };
  }

  backToLobby() {
    this.phase = PHASES.LOBBY;
    this.projectiles = [];
    this.pickups = [];
    return { ok: true };
  }

  setInput(id, dx, dy) {
    const player = this.players.get(id);
    if (!player) return false;
    const x = Number.isFinite(dx) ? dx : 0;
    const y = Number.isFinite(dy) ? dy : 0;
    const len = Math.hypot(x, y);
    const k = len > 1 ? 1 / len : 1; // a joystick never runs faster than full speed
    player.dx = x * k;
    player.dy = y * k;
    if (len > 0.2) {
      player.fx = x / len;
      player.fy = y / len;
    }
    return true;
  }

  /** Auto-aim: the nearest enemy that can be hit, within range and ahead; else straight ahead. */
  #aim(player) {
    let best = null;
    let bestD = RULES.throwRange ** 2;
    for (const other of this.players.values()) {
      if (other.team === player.team || !this.#hittable(other, this.now)) continue;
      const d = dist2(player, other);
      if (d >= bestD || d === 0) continue;
      const len = Math.sqrt(d);
      if (((other.x - player.x) * player.fx + (other.y - player.y) * player.fy) / len < AIM_COS) continue;
      best = other;
      bestD = d;
    }
    if (!best) return { x: player.fx, y: player.fy };
    // Lead the target a little: aim where they will be halfway through the flight.
    const flight = Math.sqrt(bestD) / RULES.projectileSpeed;
    const tx = best.x + best.dx * RULES.speed * flight * 0.5 - player.x;
    const ty = best.y + best.dy * RULES.speed * flight * 0.5 - player.y;
    const len = Math.hypot(tx, ty) || 1;
    return { x: tx / len, y: ty / len };
  }

  #hittable(player, now) {
    return now >= player.stunnedUntil && now >= player.shieldUntil;
  }

  throwFrom(id, now) {
    const player = this.players.get(id);
    if (!player) return { error: 'Không tìm thấy người chơi' };
    if (this.phase !== PHASES.PLAYING) return { error: 'Chưa vào trận' };
    if (now < player.stunnedUntil) return { error: 'Đang choáng' };
    if (now < player.cooldownUntil) return { error: 'Từ từ nào' };
    player.cooldownUntil = now + RULES.throwCooldownMs;
    this.now = now;
    const dir = this.#aim(player);
    const kind = player.power === 'balloon' ? 'balloon' : 'shoe';
    const angles = player.power === 'triple' ? [-RULES.tripleSpread, 0, RULES.tripleSpread] : [0];
    player.power = null;
    for (const a of angles) {
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const vx = (dir.x * cos - dir.y * sin) * RULES.projectileSpeed;
      const vy = (dir.x * sin + dir.y * cos) * RULES.projectileSpeed;
      this.projectiles.push({ id: this.#newId('s'), owner: player.id, team: player.team, kind, x: player.x, y: player.y - R * 0.6, vx, vy, bornAt: now });
    }
    return { ok: true, kind, count: angles.length };
  }

  /** Hit one target; returns the event, or null if the helmet took it. */
  #hit(projectile, target, now, events) {
    if (target.helmet) {
      target.helmet = false;
      events.push({ type: 'block', to: target.id, x: target.x, y: target.y });
      return;
    }
    target.stunnedUntil = now + RULES.stunMs;
    target.shieldUntil = target.stunnedUntil + RULES.shieldMs;
    target.dx = 0;
    target.dy = 0;
    target.hitsTaken += 1;
    const thrower = this.players.get(projectile.owner);
    if (thrower) thrower.hits += 1;
    this.scores[projectile.team] += 1;
    events.push({ type: 'hit', from: projectile.owner, to: target.id, team: projectile.team, kind: projectile.kind, x: target.x, y: target.y });
  }

  #splash(projectile, now, events) {
    events.push({ type: 'splash', x: projectile.x, y: projectile.y });
    for (const other of this.players.values()) {
      if (other.team !== projectile.team && this.#hittable(other, now) && dist2(other, projectile) <= RULES.splashRadius ** 2) {
        this.#hit(projectile, other, now, events);
      }
    }
  }

  #botThink(bot, now) {
    if (now < bot.stunnedUntil) return;
    // Wander towards the nearest enemy, sideways a bit, and throw when one is ahead.
    let target = null;
    let best = Infinity;
    for (const other of this.players.values()) {
      if (other.team === bot.team) continue;
      const d = dist2(bot, other);
      if (d < best) {
        best = d;
        target = other;
      }
    }
    if (!target) return;
    const wobble = Math.sin(now / 700 + bot.seed) * 0.8;
    const away = best < 220 ** 2 ? -1 : 1; // keep some distance
    this.setInput(bot.id, (target.x - bot.x) * away + (target.y - bot.y) * wobble * 0.3, (target.y - bot.y) * away - (target.x - bot.x) * wobble * 0.3);
    if (best < (RULES.throwRange * 0.8) ** 2 && this.rng() < 0.08) this.throwFrom(bot.id, now);
  }

  /**
   * Advance the match to `now` by `dt` seconds. Returns what happened (for sounds, effects, vibration).
   * @returns {{ type: string, [k: string]: any }[]}
   */
  step(now, dt = RULES.tickMs / 1000) {
    this.now = now;
    const events = [];
    if (this.phase === PHASES.COUNTDOWN && now >= this.startsAt) {
      this.phase = PHASES.PLAYING;
      events.push({ type: 'go' });
    }
    if (this.phase !== PHASES.PLAYING) return events;
    if (now >= this.endsAt) {
      this.#finish();
      events.push({ type: 'end' });
      return events;
    }

    for (const p of this.players.values()) {
      if (p.isBot) {
        p.seed ??= this.rng() * 100;
        this.#botThink(p, now);
      }
      if (now < p.stunnedUntil) continue;
      const speed = RULES.speed * (now < p.teaUntil ? RULES.teaBoost : 1) * dt;
      p.x = clamp(p.x + p.dx * speed, R, this.field.width - R);
      p.y = clamp(p.y + p.dy * speed, RULES.topMargin, this.field.height - R);
      // Pick-ups lying around.
      const found = this.pickups.findIndex((k) => dist2(p, k) <= (RULES.pickupRadius + R) ** 2);
      if (found >= 0) {
        const [pickup] = this.pickups.splice(found, 1);
        if (pickup.type === 'helmet') p.helmet = true;
        else if (pickup.type === 'tea') p.teaUntil = now + RULES.teaMs;
        else p.power = pickup.type;
        events.push({ type: 'pickup', to: p.id, pickup: pickup.type, x: pickup.x, y: pickup.y });
      }
    }

    const alive = [];
    for (const s of this.projectiles) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      const out = s.x < 0 || s.x > this.field.width || s.y < 0 || s.y > this.field.height || now - s.bornAt > RULES.projectileTtlMs;
      let target = null;
      if (!out) {
        for (const other of this.players.values()) {
          if (other.team !== s.team && this.#hittable(other, now) && dist2(other, { x: s.x, y: s.y + R * 0.6 }) <= (R + RULES.projectileRadius) ** 2) {
            target = other;
            break;
          }
        }
      }
      if (target) {
        if (s.kind === 'balloon') this.#splash(s, now, events);
        else this.#hit(s, target, now, events);
      } else if (out) {
        if (s.kind === 'balloon') this.#splash(s, now, events); // bursts where it lands
      } else {
        alive.push(s);
      }
    }
    this.projectiles = alive;

    if (now >= this.nextPickupAt) {
      this.nextPickupAt = now + RULES.pickupEveryMs;
      // A bigger field holds more pick-ups (same density).
      const max = Math.round(RULES.maxPickups * (this.field.width / ARENA.width) ** 2);
      if (this.pickups.length < max) {
        const type = PICKUPS[Math.floor(this.rng() * PICKUPS.length)].id;
        this.pickups.push({ id: this.#newId('k'), type, x: 120 + this.rng() * (this.field.width - 240), y: RULES.topMargin + this.rng() * (this.field.height - RULES.topMargin - 100) });
      }
    }
    return events;
  }

  #finish() {
    this.phase = PHASES.FINISHED;
    this.projectiles = [];
    this.pickups = [];
    const players = [...this.players.values()];
    const teams = Array.from({ length: this.teams }, (_, t) => ({ ...TEAMS[t], score: this.scores[t], players: players.filter((p) => p.team === t).length }))
      .sort((a, b) => b.score - a.score);
    const top = (key) => {
      const best = players.reduce((a, b) => (b[key] > (a?.[key] ?? 0) ? b : a), null);
      return best ? { id: best.id, name: best.name, team: best.team, value: best[key] } : null;
    };
    this.results = {
      teams,
      draw: teams.length > 1 && teams[0].score === teams[1].score,
      thrower: top('hits'), // "Thánh ném"
      sandbag: top('hitsTaken'), // "Bao cát"
    };
  }

  // ---------------- what clients see ----------------

  /** Roster + match state: sent when something changes (not every tick). */
  snapshot(now) {
    return {
      phase: this.phase,
      title: this.title,
      teams: this.teams,
      field: this.field,
      durationSec: this.durationSec,
      startsAt: this.startsAt,
      endsAt: this.endsAt,
      serverNow: now,
      scores: this.scores.slice(0, this.teams),
      results: this.results,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, initials: p.initials, color: p.color, animal: p.animal, team: p.team,
        connected: p.connected, isBot: p.isBot, hits: p.hits, hitsTaken: p.hitsTaken,
      })),
    };
  }

  /** Positions for the big screen, 20 times a second: compact arrays, integers only. */
  frame(now, near = () => true) {
    const p = [];
    for (const pl of this.players.values()) {
      if (!near(pl)) continue;
      let flags = 0;
      if (now < pl.stunnedUntil) flags |= FLAGS.stunned;
      else if (now < pl.shieldUntil) flags |= FLAGS.shielded;
      if (pl.fx < 0) flags |= FLAGS.left;
      if (pl.dx !== 0 || pl.dy !== 0) flags |= FLAGS.moving;
      if (pl.helmet) flags |= FLAGS.helmet;
      if (now < pl.teaUntil) flags |= FLAGS.tea;
      if (pl.power === 'triple') flags |= FLAGS.triple;
      if (pl.power === 'balloon') flags |= FLAGS.balloon;
      p.push([pl.id, Math.round(pl.x), Math.round(pl.y), flags]);
    }
    return {
      t: now,
      p,
      s: this.projectiles.filter(near).map((s) => [s.id, Math.round(s.x), Math.round(s.y), s.kind === 'balloon' ? 1 : 0, s.team]),
      k: this.pickups.filter(near).map((k) => [k.id, Math.round(k.x), Math.round(k.y), k.type]),
      sc: this.scores.slice(0, this.teams),
    };
  }

  /** A phone's own view: the same frame, cut down to what is around its player (much less traffic). */
  viewFor(id, now) {
    const me = this.players.get(id);
    if (!me) return null;
    const near = (o) => Math.abs(o.x - me.x) <= RULES.viewHalfWidth && Math.abs(o.y - me.y) <= RULES.viewHalfHeight;
    return this.frame(now, near);
  }

  /** What one phone needs about its own player (cooldown, stun, power-up). */
  controllerState(id, now) {
    const p = this.players.get(id);
    if (!p) return null;
    return {
      stunnedMs: Math.max(0, p.stunnedUntil - now),
      cooldownMs: Math.max(0, p.cooldownUntil - now),
      power: p.power,
      helmet: p.helmet,
      teaMs: Math.max(0, p.teaUntil - now),
      hits: p.hits,
      hitsTaken: p.hitsTaken,
    };
  }
}
