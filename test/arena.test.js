// The match rules: teams, moving, auto-aimed throws, stuns, power-ups, timer and results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Arena } from '../src/game/arena.js';
import { ARENA, FLAGS, PHASES, RULES, fieldFor } from '../shared/rules.js';

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
  a.x = 800;
  a.y = 450;
  arena.setInput(a.id, 10, 0); // over-long input is normalised
  run(arena, now, 1000);
  assert.ok(Math.abs(a.x - (800 + RULES.speed)) < 1);
  arena.setInput(a.id, 0, -1);
  run(arena, now + 1000, 5000);
  assert.equal(a.y, RULES.topMargin, 'stops near the top edge, head still on the field');
  arena.setInput(a.id, Number.NaN, 'x');
  assert.equal(a.dx, 0);
});

test('throws auto-aim at an enemy ahead: a hit stuns, scores, and the victim gets a short shield', () => {
  const { arena, players: [a, b], now } = playing();
  Object.assign(a, { x: 300, y: 450, fx: 1, fy: 0 });
  Object.assign(b, { x: 700, y: 520 }); // ahead, slightly off-axis
  assert.ok(arena.throwFrom(a.id, now).ok);
  assert.ok(arena.throwFrom(a.id, now + 100).error, 'cooldown');
  const { events, now: later } = run(arena, now, 800);
  const hit = events.find((e) => e.type === 'hit');
  assert.ok(hit, 'the slipper found its target');
  assert.equal(hit.from, a.id);
  assert.equal(arena.scores[a.team], 1);
  assert.equal(a.hits, 1);
  assert.equal(b.hitsTaken, 1);
  // Stunned: can't move or throw, and can't be hit again until the shield is over.
  arena.setInput(b.id, 1, 0);
  const x = b.x;
  run(arena, later, 500);
  assert.equal(b.x, x);
  assert.ok(arena.throwFrom(b.id, later + 500).error);
  assert.equal(arena.frame(later + 500).p.find(([id]) => id === b.id)[3] & FLAGS.stunned, FLAGS.stunned);
  assert.equal(arena.frame(b.stunnedUntil + 10).p.find(([id]) => id === b.id)[3] & FLAGS.shielded, FLAGS.shielded);
});

test('no aiming backwards and no friendly fire', () => {
  const { arena, players: [a, b, c], now } = playing(['An', 'Bình', 'Chi']);
  assert.equal(a.team, c.team);
  Object.assign(a, { x: 800, y: 450, fx: 1, fy: 0 });
  Object.assign(b, { x: 400, y: 450 }); // enemy behind
  Object.assign(c, { x: 1000, y: 450 }); // teammate ahead
  arena.throwFrom(a.id, now);
  const [shot] = arena.projectiles;
  assert.ok(shot.vx > 0 && Math.abs(shot.vy) < 1, 'straight ahead, not back at the enemy');
  const { events } = run(arena, now, 1500);
  assert.equal(events.filter((e) => e.type === 'hit').length, 0);
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
  Object.assign(b, { x: 600, y: 450 });
  Object.assign(d, { x: 640, y: 500 });
  assert.notEqual(b.team, a.team);
  assert.notEqual(d.team, a.team);
  a.power = 'balloon';
  arena.throwFrom(a.id, now + 1000);
  const { events } = run(arena, now + 1000, 800);
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
  Object.assign(b, { x: 600, y: 450, helmet: true });
  arena.throwFrom(a.id, now);
  const { events, now: later } = run(arena, now, 800);
  assert.deepEqual(events.map((e) => e.type), ['block']);
  assert.equal(b.helmet, false);
  assert.equal(b.stunnedUntil, 0);
  arena.throwFrom(a.id, later);
  assert.ok(run(arena, later, 800).events.some((ev) => ev.type === 'hit'));
});

test('pick-ups appear over time, at most a few at once', () => {
  const { arena, now } = playing();
  run(arena, now, RULES.pickupEveryMs * 10);
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
  arena.backToLobby();
  arena.removeBots();
  assert.equal(arena.players.size, 1);
});

test('results name the winning team, the best thrower and the favourite target', () => {
  const { arena, players: [a, b], now } = playing();
  Object.assign(a, { x: 300, y: 450, fx: 1, fy: 0 });
  Object.assign(b, { x: 600, y: 450 });
  arena.throwFrom(a.id, now);
  run(arena, now, 800);
  arena.step(arena.endsAt);
  assert.equal(arena.results.teams[0].id, a.team);
  assert.equal(arena.results.thrower.name, 'An');
  assert.equal(arena.results.sandbag.name, 'Bình');
  assert.equal(arena.results.draw, false);
});

test('the field grows with the crowd, up to a cap, same shape', () => {
  assert.deepEqual(fieldFor(2), ARENA);
  assert.deepEqual(fieldFor(30), ARENA);
  const big = fieldFor(150);
  assert.ok(big.width > ARENA.width * 2 && big.width <= ARENA.width * 2.25);
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
  assert.deepEqual(Object.keys(frame), ['t', 'p', 's', 'k', 'sc']);
  assert.ok(frame.p.every(([id, x, y, f]) => typeof id === 'string' && Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(f)));
  arena.throwFrom(a.id, now);
  assert.ok(arena.controllerState(a.id, now).cooldownMs > 0);
  assert.equal(arena.controllerState('nobody', now), null);
});
