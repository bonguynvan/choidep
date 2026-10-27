// The field is cut into one zone per team, all meeting at the centre: halves for 2 teams, a "Y" for 3
// (top-left, top-right, bottom: equal areas), quarters for 4. Zones are bounded by rays from the centre to
// the edge. A team only runs inside the zones it owns. When a team is wiped out its zones become free, and
// the first team next door to run in takes them. Used by the server (movement) and the browsers (drawing).
import { FREE_ZONE } from './rules.js';

/** Boundary rays as points on the field edge (fractions of the field), clockwise (y points down). */
const RAYS = {
  2: [[0.5, 1], [0.5, 0]], // left | right
  3: [[0, 5 / 6], [0.5, 0], [1, 5 / 6]], // top-left, top-right, bottom
  4: [[0, 0.5], [0.5, 0], [1, 0.5], [0.5, 1]], // top-left, top-right, bottom-right, bottom-left
};
const TAU = Math.PI * 2;
const norm = (a) => ((a % TAU) + TAU) % TAU;
const cache = new Map();

/** Centre, ray ends and angles for `teams` zones on this field (cached). */
export function zoneGeometry(teams, field) {
  const key = `${teams}|${field.width}|${field.height}`;
  let g = cache.get(key);
  if (g) return g;
  const center = { x: field.width / 2, y: field.height / 2 };
  const ends = (RAYS[teams] ?? RAYS[2]).map(([fx, fy]) => ({ x: fx * field.width, y: fy * field.height }));
  const angles = ends.map((e) => Math.atan2(e.y - center.y, e.x - center.x));
  const spans = angles.map((a, i) => norm(angles[(i + 1) % angles.length] - a) || TAU);
  g = { center, ends, angles, spans };
  g.centres = ends.map((_, i) => zoneCentre(g, i, field));
  cache.set(key, g);
  return g;
}

/** Which zone a point is in. */
export function zoneAt(x, y, teams, field) {
  const g = zoneGeometry(teams, field);
  const a = Math.atan2(y - g.center.y, x - g.center.x);
  const i = g.angles.findIndex((start, k) => norm(a - start) < g.spans[k]);
  return Math.max(0, i);
}

/** A zone's outline: the centre, its first ray end, the field corners in between, its last ray end. */
export function zonePolygon(i, teams, field) {
  const g = zoneGeometry(teams, field);
  const corners = [[0, 0], [field.width, 0], [field.width, field.height], [0, field.height]]
    .map(([x, y]) => ({ x, y, d: norm(Math.atan2(y - g.center.y, x - g.center.x) - g.angles[i]) }))
    .filter((c) => c.d > 0 && c.d < g.spans[i])
    .sort((a, b) => a.d - b.d);
  return [g.center, g.ends[i], ...corners, g.ends[(i + 1) % g.ends.length]];
}

/** Rough middle of a zone (for labels and for bots heading into it): the average of a grid of points inside. */
function zoneCentre(g, i, field) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let x = field.width / 40; x < field.width; x += field.width / 20) {
    for (let y = field.height / 24; y < field.height; y += field.height / 12) {
      const a = Math.atan2(y - g.center.y, x - g.center.x);
      if (norm(a - g.angles[i]) >= g.spans[i]) continue;
      sx += x;
      sy += y;
      n += 1;
    }
  }
  return { x: sx / n, y: sy / n };
}

export const initialZones = (teams) => Array.from({ length: teams }, (_, i) => i);

/** Zones sharing a border with zone i (two teams: the other one; diagonal quarters don't touch). */
export const neighbours = (i, n) => (n === 2 ? [1 - i] : [(i + n - 1) % n, (i + 1) % n]);

/** Free zones next to a team's own (the ones it may run into and take). */
export function freeNeighbours(team, zones) {
  const free = new Set();
  zones.forEach((owner, i) => {
    if (owner !== team) return;
    for (const j of neighbours(i, zones.length)) if (zones[j] === FREE_ZONE) free.add(j);
  });
  return [...free];
}

/** A wiped-out team's zones are up for grabs. */
export const freeZonesOf = (team, zones) => zones.map((owner) => (owner === team ? FREE_ZONE : owner));

function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const k = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - (a.x + k * dx), p.y - (a.y + k * dy));
}

/**
 * Can a player of `team` stand at (x, y)? Inside a zone it owns or a free one next door, and at least
 * `margin` away from every border it may not cross (so two teams never stand on top of each other at a fence).
 */
export function canStand(x, y, team, zones, field, margin = 0) {
  const free = freeNeighbours(team, zones);
  const allowed = (z) => zones[z] === team || free.includes(z);
  if (!allowed(zoneAt(x, y, zones.length, field))) return false;
  if (margin <= 0) return true;
  const g = zoneGeometry(zones.length, field);
  const n = zones.length;
  // Ray i lies between zone i-1 and zone i: a wall when exactly one side is allowed.
  return g.ends.every((end, i) => allowed((i + n - 1) % n) === allowed(i) || distToSegment({ x, y }, g.center, end) >= margin);
}
