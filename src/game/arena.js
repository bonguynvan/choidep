// One room's match: lobby -> countdown -> playing -> finished. The server owns the simulation;
// phones only send a direction and "throw", the big screen draws what step()/frame() report.
// Rules: everyone has RULES.lives lives, a slipper from another team takes one, the last one puts you out.
// Each team runs only in its own zone of the field (see shared/zones.js); the last team with someone standing wins.
import { randomBytes } from 'node:crypto';
import { ANIMALS, FACE_COLORS, findAnimal, initialsOf } from '../../shared/catalog.js';
import { ARENA, FLAGS, FREE_ZONE, PHASES, PICKUPS, RULES, TEAMS, fieldFor } from '../../shared/rules.js';
import { canStand, freeNeighbours, freeZonesOf, initialZones, zoneAt, zoneGeometry } from '../../shared/zones.js';
import { sanitizeText } from '../text.js';

const BOT_NAMES = ['Bông', 'Mít', 'Su Su', 'Bắp', 'Tôm', 'Kem', 'Na', 'Cốm', 'Xoài', 'Mochi', 'Gấu', 'Tí', 'Tèo', 'Bin', 'Bơ'];
const AIM_COS = Math.cos(((RULES.aimConeDeg / 2) * Math.PI) / 180);
const R = RULES.playerRadius;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

export const sanitizeName = (raw) => sanitizeText(raw, { maxLength: RULES.nameMaxLength, requireLetter: true });

const SAMPLE_TRIES = 60; // random points tried when looking for a spot inside a zone

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
    this.zones = initialZones(this.teams); // owner team of each zone of the field, FREE_ZONE when nobody's
    this.outTeams = new Set(); // teams wiped out this match, in the order they went
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

  /** A random spot on the field (inside the edges) that passes `ok`, or null. */
  #randomSpot(ok) {
    const F = this.field;
    for (let i = 0; i < SAMPLE_TRIES; i += 1) {
      const x = R * 2 + this.rng() * (F.width - R * 4);
      const y = RULES.topMargin + R + this.rng() * (F.height - RULES.topMargin - R * 3);
      if (ok(x, y)) return { x, y };
    }
    return null;
  }

  /** Somewhere in the team's own zone, clear of the fences, facing the middle of the field. */
  #spawn(player) {
    const own = initialZones(this.teams);
    const spot = this.#randomSpot((x, y) => canStand(x, y, player.team, own, this.field, R * 2))
      ?? zoneGeometry(this.teams, this.field).centres[player.team];
    player.x = spot.x;
    player.y = spot.y;
    player.fx = player.x < this.field.width / 2 ? 1 : -1;
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
      lives: RULES.lives, dead: false,
      // Joined during a match: watches until the next one (it would be unfair to drop in fresh mid-fight).
      late: this.phase === PHASES.COUNTDOWN || this.phase === PHASES.PLAYING,
      hits: 0, kills: 0,
      ...extra,
    };
    if (player.late) Object.assign(player, { lives: 0, dead: true });
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
    this.zones = initialZones(n);
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
    const manned = new Set([...this.players.values()].map((p) => p.team));
    if (manned.size < 2) return { error: 'Cần ít nhất 2 đội có người (bấm Xáo đội)' };
    this.field = fieldFor(this.players.size);
    this.phase = PHASES.COUNTDOWN;
    this.startsAt = now + RULES.countdownMs;
    this.endsAt = this.startsAt + this.durationSec * 1000;
    this.results = null;
    // An empty team's zone is free from the start.
    this.outTeams = new Set(Array.from({ length: this.teams }, (_, t) => t).filter((t) => !manned.has(t)));
    this.zones = initialZones(this.teams).map((t) => (this.outTeams.has(t) ? FREE_ZONE : t));
    this.projectiles = [];
    this.pickups = [];
    this.nextPickupAt = this.startsAt + RULES.pickupEveryMs;
    for (const p of this.players.values()) {
      Object.assign(p, {
        lives: RULES.lives, dead: false, late: false, watching: null, hits: 0, kills: 0,
        stunnedUntil: 0, shieldUntil: 0, cooldownUntil: 0, teaUntil: 0, helmet: false, power: null, dx: 0, dy: 0,
      });
      this.#spawn(p);
    }
    return { ok: true };
  }

  backToLobby() {
    this.phase = PHASES.LOBBY;
    this.zones = initialZones(this.teams);
    this.outTeams = new Set();
    for (const p of this.players.values()) Object.assign(p, { lives: RULES.lives, dead: false, late: false });
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
      if (other.team === player.team || !this.#hittable(other, this.now)) continue; // never your own team
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
    return !player.dead && now >= player.shieldUntil;
  }

  throwFrom(id, now) {
    const player = this.players.get(id);
    if (!player) return { error: 'Không tìm thấy người chơi' };
    if (this.phase !== PHASES.PLAYING) return { error: 'Chưa vào trận' };
    if (player.dead) return { error: player.late ? 'Chờ trận sau nhé' : 'Bạn đã bị loại' };
    if (now < player.stunnedUntil) return { error: 'Đang khựng' };
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

  /** One slipper lands on one enemy: the helmet takes it, else a life goes (the last one puts them out). */
  #hit(projectile, target, now, events) {
    if (target.helmet) {
      target.helmet = false;
      target.shieldUntil = now + RULES.shieldMs;
      events.push({ type: 'block', to: target.id, x: target.x, y: target.y });
      return;
    }
    target.lives -= 1;
    target.dx = 0;
    target.dy = 0;
    const thrower = this.players.get(projectile.owner);
    if (thrower) thrower.hits += 1;
    const where = { from: projectile.owner, to: target.id, team: projectile.team, kind: projectile.kind, x: target.x, y: target.y };
    if (target.lives <= 0) {
      target.dead = true;
      target.power = null;
      target.helmet = false;
      if (thrower) thrower.kills += 1;
      events.push({ type: 'out', ...where });
      return;
    }
    target.stunnedUntil = now + RULES.hitFreezeMs;
    target.shieldUntil = now + RULES.shieldMs;
    events.push({ type: 'hit', ...where, lives: target.lives });
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
    if (bot.dead || now < bot.stunnedUntil) return;
    // Half the bots go and take a free zone next door; the rest (and everyone else afterwards) hunt.
    const [free] = freeNeighbours(bot.team, this.zones);
    if (free !== undefined && bot.seed < 50) {
      const goal = zoneGeometry(this.teams, this.field).centres[free];
      this.setInput(bot.id, goal.x - bot.x, goal.y - bot.y);
      return;
    }
    // Wander towards the nearest enemy, sideways a bit, and throw when one is ahead.
    let target = null;
    let best = Infinity;
    for (const other of this.players.values()) {
      if (other.team === bot.team || other.dead) continue;
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
    if (best < (RULES.throwRange * 0.8) ** 2 && this.rng() < 0.05) this.throwFrom(bot.id, now);
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
      if (p.dead) continue;
      if (p.isBot) {
        p.seed ??= this.rng() * 100;
        this.#botThink(p, now);
      }
      if (now < p.stunnedUntil) continue;
      this.#move(p, RULES.speed * (now < p.teaUntil ? RULES.teaBoost : 1) * dt, events);
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
    this.#checkTeams(now, events);

    if (now >= this.nextPickupAt) {
      this.nextPickupAt = now + RULES.pickupEveryMs;
      // A bigger field holds more pick-ups (same density).
      const max = Math.round(RULES.maxPickups * (this.field.width / ARENA.width) ** 2);
      // Only where a team lives (a pick-up in a free zone could never be reached by most), clear of fences.
      const spot = this.pickups.length < max && this.#randomSpot((x, y) => {
        const owner = this.zones[zoneAt(x, y, this.teams, this.field)];
        return owner !== FREE_ZONE && canStand(x, y, owner, this.zones, this.field, RULES.pickupRadius + R);
      });
      if (spot) {
        const type = PICKUPS[Math.floor(this.rng() * PICKUPS.length)].id;
        this.pickups.push({ id: this.#newId('k'), type, ...spot });
      }
    }
    return events;
  }

  /** Run, but only inside the team's zones (taking a free one next door by stepping into it); pick things up. */
  #move(p, speed, events) {
    if (p.dx !== 0 || p.dy !== 0) this.#run(p, speed, events);
    // Pick-ups lying around.
    const found = this.pickups.findIndex((k) => dist2(p, k) <= (RULES.pickupRadius + R) ** 2);
    if (found >= 0) {
      const [pickup] = this.pickups.splice(found, 1);
      if (pickup.type === 'helmet') p.helmet = true;
      else if (pickup.type === 'tea') p.teaUntil = this.now + RULES.teaMs;
      else p.power = pickup.type;
      events.push({ type: 'pickup', to: p.id, pickup: pickup.type, x: pickup.x, y: pickup.y });
    }
  }

  /** One step of running: pushing into a fence slides along it, a straight push gets as close as it allows. */
  #run(p, speed, events) {
    const inField = (x, y) => ({ x: clamp(x, R, this.field.width - R), y: clamp(y, RULES.topMargin, this.field.height - R) });
    const fits = (q, margin) => canStand(q.x, q.y, p.team, this.zones, this.field, margin);
    const tries = [
      inField(p.x + p.dx * speed, p.y + p.dy * speed),
      inField(p.x + p.dx * speed, p.y),
      inField(p.x, p.y + p.dy * speed),
    ].filter((q) => q.x !== p.x || q.y !== p.y);
    // Stuck within a fence's margin (a zone next door was just taken): any move that stays in our zones is fine.
    const margin = fits(p, R) ? R : 0;
    let next = tries.find((q) => fits(q, margin));
    if (!next && tries.length > 0) {
      // Head-on into a fence: go as far as it allows.
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 6; i += 1) {
        const mid = (lo + hi) / 2;
        if (fits({ x: p.x + (tries[0].x - p.x) * mid, y: p.y + (tries[0].y - p.y) * mid }, margin)) lo = mid;
        else hi = mid;
      }
      next = { x: p.x + (tries[0].x - p.x) * lo, y: p.y + (tries[0].y - p.y) * lo };
    }
    if (!next) return;
    p.x = next.x;
    p.y = next.y;
    const zone = zoneAt(p.x, p.y, this.teams, this.field);
    if (this.zones[zone] === FREE_ZONE) {
      this.zones = this.zones.map((owner, i) => (i === zone ? p.team : owner));
      events.push({ type: 'capture', team: p.team, zone, to: p.id });
    }
  }

  /** People standing per team (late joiners and the knocked-out don't count). */
  aliveCounts() {
    const counts = Array.from({ length: this.teams }, () => 0);
    for (const p of this.players.values()) if (!p.dead && p.team < this.teams) counts[p.team] += 1;
    return counts;
  }

  /** A team with nobody standing is out (its zones go free); with one team left the match ends soon. */
  #checkTeams(now, events) {
    const counts = this.aliveCounts();
    counts.forEach((n, team) => {
      if (n > 0 || this.outTeams.has(team)) return;
      this.outTeams = new Set([...this.outTeams, team]); // insertion order = order of elimination
      this.zones = freeZonesOf(team, this.zones);
      events.push({ type: 'wipe', team });
    });
    if (counts.filter((n) => n > 0).length <= 1) this.endsAt = Math.min(this.endsAt, now + RULES.finishDelayMs);
  }

  #finish() {
    this.phase = PHASES.FINISHED;
    this.projectiles = [];
    this.pickups = [];
    const players = [...this.players.values()].filter((p) => !p.late);
    const alive = this.aliveCounts();
    // Most people standing wins; a tie goes to the team with more lives left, then to whoever lasted longer.
    const order = [...this.outTeams];
    const lasted = (t) => (order.includes(t) ? order.indexOf(t) : order.length);
    const teams = Array.from({ length: this.teams }, (_, t) => {
      const members = players.filter((p) => p.team === t);
      return {
        ...TEAMS[t],
        alive: alive[t],
        lives: members.reduce((n, p) => n + (p.dead ? 0 : p.lives), 0),
        kills: members.reduce((n, p) => n + p.kills, 0),
        players: members.length,
      };
    }).sort((a, b) => b.alive - a.alive || b.lives - a.lives || lasted(b.id) - lasted(a.id));
    const best = (list, better) => list.reduce((a, b) => (a === null || better(b, a) ? b : a), null);
    const thrower = best(players.filter((p) => p.kills > 0), (b, a) => b.kills > a.kills || (b.kills === a.kills && b.hits > a.hits));
    const survivor = best(players.filter((p) => !p.dead), (b, a) => b.lives > a.lives || (b.lives === a.lives && b.kills > a.kills));
    const brief = (p, value) => (p ? { id: p.id, name: p.name, team: p.team, value } : null);
    this.results = {
      teams,
      draw: teams.length > 1 && teams[0].alive === teams[1].alive && teams[0].lives === teams[1].lives,
      thrower: brief(thrower, thrower?.kills), // "Thánh ném": put the most people out
      survivor: brief(survivor, survivor?.lives), // "Người sống sót": still standing, most lives left
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
      zones: this.zones,
      durationSec: this.durationSec,
      startsAt: this.startsAt,
      endsAt: this.endsAt,
      serverNow: now,
      scores: this.aliveCounts(), // people standing per team
      results: this.results,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, initials: p.initials, color: p.color, animal: p.animal, team: p.team,
        connected: p.connected, isBot: p.isBot, hits: p.hits, kills: p.kills, lives: p.lives, dead: p.dead, late: p.late,
      })),
    };
  }

  /** Positions for the big screen, 20 times a second: compact arrays, integers only. The knocked-out aren't in it. */
  frame(now, near = () => true) {
    const p = [];
    for (const pl of this.players.values()) {
      if (pl.dead || !near(pl)) continue;
      let flags = 0;
      if (now < pl.stunnedUntil) flags |= FLAGS.stunned;
      else if (now < pl.shieldUntil) flags |= FLAGS.shielded;
      if (pl.fx < 0) flags |= FLAGS.left;
      if (pl.dx !== 0 || pl.dy !== 0) flags |= FLAGS.moving;
      if (pl.helmet) flags |= FLAGS.helmet;
      if (now < pl.teaUntil) flags |= FLAGS.tea;
      if (pl.power === 'triple') flags |= FLAGS.triple;
      if (pl.power === 'balloon') flags |= FLAGS.balloon;
      p.push([pl.id, Math.round(pl.x), Math.round(pl.y), flags, pl.lives]);
    }
    return {
      t: now,
      p,
      s: this.projectiles.filter(near).map((s) => [s.id, Math.round(s.x), Math.round(s.y), s.kind === 'balloon' ? 1 : 0, s.team]),
      k: this.pickups.filter(near).map((k) => [k.id, Math.round(k.x), Math.round(k.y), k.type]),
      sc: this.aliveCounts(),
      z: this.zones,
    };
  }

  /**
   * A phone's own view: the same frame, cut down to what is around its player (much less traffic).
   * Once out (or waiting for the next match) the phone follows a teammate still standing: `f` says whom.
   */
  viewFor(id, now) {
    const me = this.players.get(id);
    if (!me) return null;
    const focus = me.dead ? this.#watch(me) : me;
    const near = (o) => Math.abs(o.x - focus.x) <= RULES.viewHalfWidth && Math.abs(o.y - focus.y) <= RULES.viewHalfHeight;
    return { ...this.frame(now, near), f: focus.id };
  }

  /** Who a knocked-out player watches: the same teammate while they stand, else the nearest one standing. */
  #watch(me) {
    const current = this.players.get(me.watching);
    if (current && !current.dead) return current;
    let best = null;
    let bestD = Infinity;
    for (const p of this.players.values()) {
      if (p.dead) continue;
      const d = dist2(me, p) + (p.team === me.team ? 0 : 1e12); // teammates first
      if (d < bestD) {
        best = p;
        bestD = d;
      }
    }
    me.watching = best?.id ?? null;
    return best ?? me;
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
      lives: p.lives,
      dead: p.dead,
      late: p.late,
      hits: p.hits,
      kills: p.kills,
      watching: p.dead ? (this.players.get(p.watching)?.name ?? null) : null,
    };
  }
}
