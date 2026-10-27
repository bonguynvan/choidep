// The match rules: teams and their strips, moving, auto-aimed throws, lives, power-ups, timer and results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Arena } from '../src/game/arena.js';
import { ARENA, FLAGS, FREE_ZONE, PHASES, RULES, fieldFor } from '../shared/rules.js';
import { zoneAt, zonePolygon } from '../shared/zones.js';

/** Deterministic rng for repeatable tests. */
function seeded(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const TICK = RULES.tickMs;

/** Arena already playing, with players placed by hand. */
function playing(names = ['An', 'Bình']) {
  const arena = new Arena({ rng: seeded() });
  const players = names.map((n) => arena.join(n, 'duck').player);
  arena.start(0);
  arena.step(RULES.countdownMs);
  assert.equal(arena.phase, PHASES.PLAYING);
  return { arena, players, now: RULES.countdownMs };
}

/** Run the simulation for `ms`, collecting events. */
function run(arena, from, ms) {
  const events = [];
  for (let t = from + TICK; t <= from + ms; t += TICK) events.push(...arena.step(t));
  return { events, now: from + ms };
}

test('joining: names are cleaned, unique, and teams stay even', () => {
  const arena = new Arena({ rng: seeded() });
  assert.ok(arena.join('   ', 'duck').error);
  assert.equal(arena.join('  Minh   Anh ', 'duck').player.name, 'Minh Anh');
  assert.ok(arena.join('minh anh', 'cat').error, 'same name, any case');
  ['B', 'C', 'D', 'E'].forEach((n) => arena.join(n, 'cat'));
  const counts = [0, 1].map((t) => [...arena.players.values()].filter((p) => p.team === t).length);
  assert.deepEqual(counts, [3, 2]);
  assert.ok(arena.join('X', 'not-a-character').player.animal, 'unknown characters get a random one');
});

test('teams can be reshuffled into 2, 3 or 4, evenly, only between matches', () => {
  const arena = new Arena({ rng: seeded() });
  for (let i = 0; i < 10; i += 1) arena.join(`P${i}`, 'cat');
  assert.ok(arena.setTeams(3).ok);
  const counts = [0, 1, 2].map((t) => [...arena.players.values()].filter((p) => p.team === t).length);
  assert.deepEqual(counts.sort(), [3, 3, 4]);
  assert.ok(arena.setTeams(5).error);
  arena.start(0);
  assert.ok(arena.setTeams(2).error, 'not mid-match');
  assert.ok(arena.setDuration(120).error);
});

test('a match needs two people, counts down, plays for the set time and ends with results', () => {
  const arena = new Arena({ rng: seeded() });
  arena.join('An', 'cat');
  assert.ok(arena.start(0).error);
  arena.join('Bình', 'dog');
  arena.setDuration(60);
  assert.ok(arena.start(0).ok);
  assert.equal(arena.phase, PHASES.COUNTDOWN);
  assert.deepEqual(arena.step(1000), []);
  assert.deepEqual(arena.step(RULES.countdownMs).map((e) => e.type), ['go']);
  assert.deepEqual(arena.step(RULES.countdownMs + 60000).map((e) => e.type), ['end']);
  assert.equal(arena.phase, PHASES.FINISHED);
  assert.equal(arena.results.teams.length, 2);
  assert.equal(arena.results.draw, true);
});

test('players run where the joystick points, never off the field, never faster than full speed', () => {
  const { arena, players: [a], now } = playing();
  a.x = 200;
  a.y = 450;
  arena.setInput(a.id, 10, 0); // over-long input is normalised
  run(arena, now, 1000);
  assert.ok(Math.abs(a.x - (200 + RULES.speed)) < 1);
  arena.setInput(a.id, 0, -1);
  run(arena, now + 1000, 5000);
  assert.equal(a.y, RULES.topMargin, 'stops near the top edge, head still on the field');
  arena.setInput(a.id, Number.NaN, 'x');
  assert.equal(a.dx, 0);
});

test('throws auto-aim at an enemy ahead: a hit takes a life, the victim flinches and gets a short shield', () => {
  const { arena, players: [a, b], now } = playing();
  Object.assign(a, { x: 300, y: 450, fx: 1, fy: 0 });
  Object.assign(b, { x: 900, y: 520 }); // ahead, slightly off-axis
  assert.ok(arena.throwFrom(a.id, now).ok);
  assert.ok(arena.throwFrom(a.id, now + 100).error, 'cooldown');
  const { events, now: later } = run(arena, now, 1500);
  const hit = events.find((e) => e.type === 'hit');
  assert.ok(hit, 'the slipper found its target');
  assert.equal(hit.from, a.id);
  assert.equal(hit.lives, RULES.lives - 1);
  assert.equal(b.lives, RULES.lives - 1);
  assert.equal(a.hits, 1);
  // Flinching: can't move or throw for a moment.
  const at = b.stunnedUntil - RULES.hitFreezeMs;
  arena.setInput(b.id, 1, 0);
  const x = b.x;
  arena.step(at + 100);
  assert.equal(b.x, x);
  assert.ok(arena.throwFrom(b.id, at + 100).error);
  assert.equal(arena.frame(at + 100).p.find(([id]) => id === b.id)[3] & FLAGS.stunned, FLAGS.stunned);
  // Then runs again, still shielded for a bit, and shows the lives left.
  const after = arena.frame(b.stunnedUntil + 10).p.find(([id]) => id === b.id);
  assert.equal(after[3] & FLAGS.shielded, FLAGS.shielded);
  assert.equal(after[4], RULES.lives - 1);
  assert.ok(later > 0);
});

test('three hits and you are out: off the field, no throwing, the thrower gets the knock-out', () => {
  const { arena, players: [a, b], now } = playing(['An', 'Bình', 'Chi', 'Dũng']);
  Object.assign(a, { x: 300, y: 450, fx: 1, fy: 0 });
  Object.assign(b, { x: 900, y: 450 });
  let t = now;
  const events = [];
  for (let i = 0; i < RULES.lives; i += 1) {
    a.cooldownUntil = 0;
    arena.throwFrom(a.id, t);
    const r = run(arena, t, 2000); // longer than the shield
    events.push(...r.events);
    t = r.now;
  }
  assert.deepEqual(events.filter((e) => e.to === b.id).map((e) => e.type), ['hit', 'hit', 'out']);
  assert.equal(b.dead, true);
  assert.equal(a.kills, 1);
  assert.ok(arena.throwFrom(b.id, t).error);
  assert.ok(!arena.frame(t).p.some(([id]) => id === b.id), 'knocked-out players leave the field');
  assert.equal(arena.aliveCounts()[b.team], 1);
  assert.equal(arena.phase, PHASES.PLAYING, 'a teammate still stands');
});

test('no aiming backwards and no friendly fire', () => {
  const { arena, players: [a, b, c], now } = playing(['An', 'Bình', 'Chi']);
  assert.equal(a.team, c.team);
  Object.assign(a, { x: 700, y: 450, fx: -1, fy: 0 }); // facing away from the enemies' strip
  Object.assign(b, { x: 1200, y: 450 }); // enemy behind
  Object.assign(c, { x: 300, y: 450 }); // teammate ahead
  arena.throwFrom(a.id, now);
  const [shot] = arena.projectiles;
  assert.ok(shot.vx < 0 && Math.abs(shot.vy) < 1, 'straight ahead, not back at the enemy');
  const { events } = run(arena, now, 1500);
  assert.equal(events.filter((e) => e.type === 'hit').length, 0);
  assert.equal(c.lives, RULES.lives, 'slippers fly through teammates');
});

test('power-ups: triple slippers, a splashing balloon, a helmet that blocks, tea for speed', () => {
  const { arena, players: [a, b, c, d], now } = playing(['An', 'Bình', 'Chi', 'Dũng']);
  // triple
  Object.assign(a, { x: 200, y: 450, fx: 1, fy: 0, power: 'triple' });
  arena.throwFrom(a.id, now);
  assert.equal(arena.projectiles.length, 3);
  assert.equal(a.power, null);
  arena.projectiles = [];
  // balloon splashes everyone around the target
  Object.assign(b, { x: 860, y: 450 });
  Object.assign(d, { x: 900, y: 500 });
  assert.notEqual(b.team, a.team);
  assert.notEqual(d.team, a.team);
  a.power = 'balloon';
  arena.throwFrom(a.id, now + 1000);
  const { events } = run(arena, now + 1000, 1500);
  assert.ok(events.some((e) => e.type === 'splash'));
  assert.equal(events.filter((e) => e.type === 'hit').length, 2);
  // tea (the helmet has its own test below)
  Object.assign(c, { x: 200, y: 200, fx: 1, fy: 0 });
  const t0 = now + 5000;
  arena.pickups.push({ id: 'k1', type: 'tea', x: c.x, y: c.y });
  arena.setInput(c.id, 1, 0);
  const { events: picked } = run(arena, t0, TICK);
  assert.ok(picked.some((ev) => ev.type === 'pickup' && ev.pickup === 'tea'));
  const x = c.x;
  run(arena, t0 + TICK, 1000);
  assert.ok(c.x - x > RULES.speed * 1.4, 'faster than normal');
});

test('a helmet takes one hit instead of the player', () => {
  const { arena, players: [a, b], now } = playing();
  Object.assign(a, { x: 300, y: 450, fx: 1, fy: 0 });
  Object.assign(b, { x: 900, y: 450, helmet: true });
  arena.throwFrom(a.id, now);
  const { events, now: later } = run(arena, now, 2000);
  assert.deepEqual(events.map((e) => e.type), ['block']);
  assert.equal(b.helmet, false);
  assert.equal(b.lives, RULES.lives);
  arena.throwFrom(a.id, later);
  assert.ok(run(arena, later, 1500).events.some((ev) => ev.type === 'hit'));
});

test('pick-ups appear over time, at most a few at once', () => {
  const { arena, now } = playing();
  run(arena, now, RULES.pickupEveryMs * 10);
  assert.equal(arena.phase, PHASES.PLAYING);
  assert.ok(arena.pickups.length > 0 && arena.pickups.length <= RULES.maxPickups);
  for (const k of arena.pickups) assert.ok(k.x > 0 && k.x < ARENA.width && k.y > 0 && k.y < ARENA.height);
});

test('bots join the fun: they move and throw on their own, and the host can remove them', () => {
  const arena = new Arena({ rng: seeded(3) });
  arena.join('An', 'cat');
  assert.ok(arena.addBots(9).ok);
  assert.equal(arena.players.size, 10);
  assert.ok(arena.addBots(RULES.maxBots).ok);
  assert.equal([...arena.players.values()].filter((p) => p.isBot).length, RULES.maxBots);
  assert.ok(arena.addBots(1).error);
  arena.start(0);
  const { events } = run(arena, 0, RULES.countdownMs + 20000);
  assert.ok(events.some((e) => e.type === 'hit'), 'bots hit each other');
  assert.ok(events.some((e) => e.type === 'out'), 'and knock each other out');
  arena.backToLobby();
  arena.removeBots();
  assert.equal(arena.players.size, 1);
});

test('time up: most people standing wins, then most lives left; awards for the thrower and the survivor', () => {
  const { arena, players: [a, b, c, d], now } = playing(['An', 'Bình', 'Chi', 'Dũng']);
  Object.assign(a, { x: 300, y: 450, fx: 1, fy: 0 });
  Object.assign(b, { x: 900, y: 450 });
  arena.throwFrom(a.id, now);
  run(arena, now, 1500);
  assert.equal(b.lives, RULES.lives - 1);
  arena.step(arena.endsAt);
  assert.equal(arena.phase, PHASES.FINISHED);
  const [first, second] = arena.results.teams;
  assert.equal(first.id, a.team, 'same people standing, more lives left');
  assert.deepEqual([first.alive, first.lives, second.alive, second.lives], [2, 6, 2, 5]);
  assert.equal(arena.results.draw, false);
  assert.equal(arena.results.thrower, null, 'nobody was knocked out');
  assert.ok([a.id, c.id].includes(arena.results.survivor.id) && arena.results.survivor.value === RULES.lives);
  assert.ok(d);
});

test('the last team standing wins straight away', () => {
  const { arena, players: [a, b], now } = playing();
  Object.assign(a, { x: 300, y: 450, fx: 1, fy: 0 });
  Object.assign(b, { x: 900, y: 450 });
  b.lives = 1;
  arena.throwFrom(a.id, now);
  const { events, now: later } = run(arena, now, 1500);
  assert.deepEqual(events.filter((e) => e.type !== 'pickup').map((e) => e.type), ['out', 'wipe']);
  assert.equal(arena.phase, PHASES.PLAYING, 'a short pause so everyone sees it');
  const { events: end } = run(arena, later, RULES.finishDelayMs);
  assert.ok(end.some((e) => e.type === 'end'));
  assert.equal(arena.results.teams[0].id, a.team);
  assert.equal(arena.results.thrower.name, 'An');
  assert.equal(arena.results.survivor.name, 'An');
});



test('an empty team\'s zone is free from the start; a match needs two teams with people', () => {
  const arena = new Arena({ rng: seeded() });
  arena.join('An', 'duck');
  arena.join('Bình', 'duck');
  arena.teams = 3; // as if the third team emptied out after shuffling
  arena.zones = [0, 1, 2];
  assert.ok(arena.start(0).ok);
  assert.deepEqual(arena.zones, [0, 1, FREE_ZONE]);
  arena.backToLobby();
  for (const p of arena.players.values()) p.team = 0;
  assert.ok(arena.start(0).error);
});

test('joining mid-match waits for the next one; knocked-out phones watch a teammate', () => {
  const { arena, players: [a, b, c], now } = playing(['An', 'Bình', 'Chi']);
  const late = arena.join('Muộn', 'cat').player;
  assert.equal(late.dead, true);
  assert.ok(arena.throwFrom(late.id, now).error);
  assert.equal(arena.controllerState(late.id, now).late, true);
  assert.ok(!arena.frame(now).p.some(([id]) => id === late.id));
  // A knocked out: the phone follows teammate C.
  assert.equal(a.team, c.team);
  a.dead = true;
  a.lives = 0;
  assert.equal(arena.viewFor(a.id, now).f, c.id);
  assert.equal(arena.controllerState(a.id, now).watching, 'Chi');
  assert.equal(arena.viewFor(b.id, now).f, b.id);
  // Next match: everyone plays, with full lives.
  arena.step(arena.endsAt);
  arena.start(arena.endsAt);
  assert.ok([...arena.players.values()].every((p) => !p.dead && !p.late && p.lives === RULES.lives));
});

test('the field grows with the crowd, up to a cap, same shape', () => {
  assert.deepEqual(fieldFor(2), ARENA);
  assert.deepEqual(fieldFor(20), ARENA);
  const big = fieldFor(150);
  assert.ok(big.width > ARENA.width * 2.5 - 1 && big.width <= ARENA.width * 2.5);
  assert.equal(Math.round((big.width / big.height) * 100), Math.round((ARENA.width / ARENA.height) * 100));
  assert.deepEqual(fieldFor(1000), fieldFor(500), 'capped');
  const arena = new Arena({ rng: seeded() });
  arena.addBots(RULES.maxBots);
  arena.start(0);
  assert.deepEqual(arena.snapshot(0).field, fieldFor(RULES.maxBots));
  assert.ok([...arena.players.values()].some((p) => p.x > ARENA.width), 'players spread over the bigger field');
});

test('a phone only receives what is around its player', () => {
  const { arena, players: [a, b], now } = playing();
  Object.assign(a, { x: 200, y: 450 });
  Object.assign(b, { x: 1500, y: 450 });
  arena.pickups.push({ id: 'k1', type: 'tea', x: 300, y: 500 }, { id: 'k2', type: 'tea', x: 1400, y: 500 });
  const view = arena.viewFor(a.id, now);
  assert.deepEqual(view.p.map(([id]) => id), [a.id]);
  assert.deepEqual(view.k.map(([id]) => id), ['k1']);
  assert.equal(arena.viewFor('nobody', now), null);
  assert.equal(arena.frame(now).p.length, 2, 'the big screen still sees everyone');
});

test('the frame is compact and the controller state is per player', () => {
  const { arena, players: [a], now } = playing();
  const frame = arena.frame(now);
  assert.deepEqual(Object.keys(frame), ['t', 'p', 's', 'k', 'sc', 'z']);
  assert.ok(frame.p.every(([id, x, y, f, lives]) => typeof id === 'string' && [x, y, f, lives].every(Number.isInteger)));
  assert.deepEqual(frame.sc, [1, 1], 'people standing per team');
  arena.throwFrom(a.id, now);
  assert.ok(arena.controllerState(a.id, now).cooldownMs > 0);
  assert.equal(arena.controllerState('nobody', now), null);
});

test('teams knocked out rank by how long they lasted', () => {
  const arena = new Arena({ rng: seeded() });
  ['An', 'Bình', 'Chi'].forEach((n) => arena.join(n, 'duck'));
  arena.setTeams(3);
  arena.start(0);
  arena.step(RULES.countdownMs);
  const byTeam = (t) => [...arena.players.values()].find((p) => p.team === t);
  // Team 0 goes first, then team 1: team 2 wins, team 1 is second.
  Object.assign(byTeam(0), { dead: true, lives: 0 });
  run(arena, RULES.countdownMs, TICK);
  Object.assign(byTeam(1), { dead: true, lives: 0 });
  run(arena, RULES.countdownMs + TICK, RULES.finishDelayMs + TICK);
  assert.equal(arena.phase, PHASES.FINISHED);
  assert.deepEqual(arena.results.teams.map((t) => t.id), [2, 1, 0]);
});

/** Area of a polygon (shoelace). */
const area = (pts) => Math.abs(pts.reduce((sum, a, i) => {
  const b = pts[(i + 1) % pts.length];
  return sum + a.x * b.y - b.x * a.y;
}, 0)) / 2;

test('zones are symmetric: halves, a Y for three teams, quarters for four, all the same size', () => {
  const F = ARENA;
  const total = F.width * F.height;
  for (const teams of [2, 3, 4]) {
    for (let i = 0; i < teams; i += 1) {
      assert.ok(Math.abs(area(zonePolygon(i, teams, F)) - total / teams) < 1, `${teams} teams, zone ${i}`);
    }
  }
  const at = (teams, x, y) => zoneAt(x * F.width, y * F.height, teams, F);
  assert.deepEqual([at(2, 0.1, 0.5), at(2, 0.9, 0.5)], [0, 1]);
  assert.deepEqual([at(3, 0.1, 0.1), at(3, 0.9, 0.1), at(3, 0.5, 0.95)], [0, 1, 2]);
  assert.deepEqual([at(4, 0.1, 0.1), at(4, 0.9, 0.1), at(4, 0.9, 0.9), at(4, 0.1, 0.9)], [0, 1, 2, 3]);
  // Mirror image: the Y is symmetric left/right.
  assert.equal(at(3, 0.2, 0.65), 0);
  assert.equal(at(3, 0.8, 0.65), 1);
});

test('each team runs only inside its own zone and stops at the fence', () => {
  const { arena, players: [a, b], now } = playing();
  Object.assign(a, { x: 700, y: 450 });
  Object.assign(b, { x: 900, y: 450 });
  arena.setInput(a.id, 1, 0);
  arena.setInput(b.id, -1, 0);
  run(arena, now, 2000);
  assert.ok(Math.abs(a.x - (ARENA.width / 2 - RULES.playerRadius)) < 1);
  assert.ok(Math.abs(b.x - (ARENA.width / 2 + RULES.playerRadius)) < 1);
  // Pushing diagonally into the fence slides along it.
  arena.setInput(a.id, 1, 1);
  const y = a.y;
  run(arena, now + 2000, 500);
  assert.ok(a.y > y + 50 && a.x < ARENA.width / 2);
  assert.deepEqual(arena.snapshot(now).zones, [0, 1]);
});

test('everyone starts inside their own zone, three or four teams', () => {
  for (const teams of [3, 4]) {
    const arena = new Arena({ rng: seeded(teams) });
    for (let i = 0; i < 24; i += 1) arena.join(`P${i}`, 'cat');
    arena.setTeams(teams);
    arena.start(0);
    for (const p of arena.players.values()) assert.equal(zoneAt(p.x, p.y, teams, arena.field), p.team);
  }
});

test('four teams: a wiped-out quarter goes to the first team next to it, never the one across', () => {
  const arena = new Arena({ rng: seeded() });
  ['An', 'Bình', 'Chi', 'Dũng'].forEach((n) => arena.join(n, 'duck'));
  arena.setTeams(4);
  arena.start(0);
  let now = RULES.countdownMs;
  arena.step(now);
  const byTeam = (t) => [...arena.players.values()].find((p) => p.team === t);
  const [tl, tr, br, bl] = [0, 1, 2, 3].map(byTeam);
  Object.assign(tl, { dead: true, lives: 0 });
  ({ now } = run(arena, now, TICK));
  assert.deepEqual(arena.zones, [FREE_ZONE, 1, 2, 3]);
  Object.assign(tr, { x: 1000, y: 300 });
  Object.assign(br, { x: 900, y: 550 });
  Object.assign(bl, { x: 400, y: 600 });
  // Bottom-right (across the centre) can't get in; bottom-left (next door) runs up and takes it.
  arena.setInput(br.id, -1, -1);
  arena.setInput(bl.id, 0, -1);
  const { events, now: later } = run(arena, now, 1000);
  const capture = events.find((e) => e.type === 'capture');
  assert.deepEqual([capture.team, capture.zone], [bl.team, 0]);
  assert.deepEqual(arena.zones, [3, 1, 2, 3]);
  assert.equal(zoneAt(br.x, br.y, 4, arena.field), 2, 'still in its own quarter');
  // Top-right is now shut out of the taken quarter.
  arena.setInput(tr.id, -1, 0);
  run(arena, later, 2000);
  assert.ok(tr.x >= ARENA.width / 2 + RULES.playerRadius - 1);
  assert.ok(bl.y < ARENA.height / 2, 'bottom-left runs in both its quarters');
});

test('three teams: the first team in takes the free zone', () => {
  const arena = new Arena({ rng: seeded() });
  ['An', 'Bình', 'Chi'].forEach((n) => arena.join(n, 'duck'));
  arena.setTeams(3);
  arena.start(0);
  let now = RULES.countdownMs;
  arena.step(now);
  const byTeam = (t) => [...arena.players.values()].find((p) => p.team === t);
  const [left, right, bottom] = [0, 1, 2].map(byTeam);
  Object.assign(bottom, { dead: true, lives: 0 });
  ({ now } = run(arena, now, TICK));
  assert.deepEqual(arena.zones, [0, 1, FREE_ZONE]);
  Object.assign(left, { x: 400, y: 560 }); // just above the bottom zone's fence
  Object.assign(right, { x: 1300, y: 300 }); // further away
  arena.setInput(left.id, 0, 1);
  arena.setInput(right.id, 0, 1);
  const { events } = run(arena, now, 1500);
  const capture = events.find((e) => e.type === 'capture');
  assert.deepEqual([capture.team, capture.zone], [left.team, 2]);
  assert.equal(zoneAt(right.x, right.y, 3, arena.field), 1, 'right stays out');
});
