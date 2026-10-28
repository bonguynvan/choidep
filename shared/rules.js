// Game rules shared by the server (simulation) and the browsers (drawing, controller hints).

export const ARENA = Object.freeze({ width: 1600, height: 900 }); // the field for up to ~20 players

/**
 * The field grows with the crowd (same 16:9 shape): room to run, and each phone's nearby-only view stays
 * small, so a streamer's 150 fans don't flood the network. Area per player stays about the same.
 */
export function fieldFor(players) {
  const k = Math.min(2.5, Math.max(1, Math.sqrt(players / 20)));
  return { width: Math.round(ARENA.width * k), height: Math.round(ARENA.height * k) };
}

export const TEAMS = Object.freeze([
  { id: 0, name: 'Đỏ', color: '#e63946' },
  { id: 1, name: 'Xanh', color: '#2d7ff9' },
  { id: 2, name: 'Vàng', color: '#f4b400' },
  { id: 3, name: 'Tím', color: '#8e44ad' },
]);

export const RULES = Object.freeze({
  tickMs: 50, // server simulation + broadcast: 20 per second
  playerRadius: 20, // every character shares one hitbox, whatever its drawing
  topMargin: 90, // positions are the feet: keep room above for the character's body and head
  speed: 300, // units per second: quicker than before, so dodging works
  throwCooldownMs: 900,
  projectileSpeed: 540, // slow enough to see a slipper coming and step aside
  projectileTtlMs: 1500,
  projectileRadius: 12,
  throwRange: 760,
  aimConeDeg: 80, // auto-aim looks for enemies within this cone ahead
  lives: 3, // hit three times = out of the match
  hitFreezeMs: 600, // a hit makes you flinch (no running, no throwing) this long
  shieldMs: 1400, // after a hit: can't be hit again straight away (counted from the hit)
  finishDelayMs: 1800, // one team left: the match ends this long after, so everyone sees the last "LOẠI!"
  countdownMs: 3000,
  durationChoices: [60, 120, 180, 300],
  defaultDurationSec: 180,
  teamChoices: [2, 3, 4],
  maxPlayers: 150,
  maxBots: 40,
  nameMaxLength: 16,
  titleMaxLength: 60,
  pickupEveryMs: 5000,
  maxPickups: 4,
  pickupRadius: 28,
  teaMs: 5000,
  teaBoost: 1.6,
  splashRadius: 120,
  tripleSpread: 0.3, // radians between the three slippers
  lobbyGraceMs: 10 * 60 * 1000, // a phone that drops in the lobby keeps its place this long
  // A phone shows the arena around its own player: it only gets what lies within this box (world units).
  viewHalfWidth: 600,
  viewHalfHeight: 560,
});

/** Game modes the host picks in the lobby. */
export const MODES = Object.freeze([
  { id: 'classic', name: 'Né dép', hint: `Mỗi người ${RULES.lives} mạng, hết mạng thì bị loại. Đội cuối cùng còn người thắng.` },
  { id: 'infect', name: 'Lây nhiễm', hint: 'Trúng dép thì đổi sang đội của người ném. Cả sân một màu thì thắng.' },
]);

export const PICKUPS = Object.freeze([
  { id: 'triple', icon: '🩴', name: 'Dép tổ ong', hint: 'Lần ném tới bay 3 chiếc' },
  { id: 'balloon', icon: '🎈', name: 'Bóng nước', hint: 'Lần ném tới nổ cả một vùng' },
  { id: 'helmet', icon: '⛑️', name: 'Mũ bảo hiểm', hint: 'Đỡ được 1 lần trúng' },
  { id: 'tea', icon: '🧋', name: 'Trà sữa', hint: 'Chạy nhanh trong 5 giây' },
]);

/** Bit flags of a player in the compact frame (see Arena#frame); stunned = flinching after a hit (RULES.hitFreezeMs). */
export const FLAGS = Object.freeze({ stunned: 1, shielded: 2, left: 4, moving: 8, helmet: 16, tea: 32, triple: 64, balloon: 128 });

export const PHASES = Object.freeze({ LOBBY: 'lobby', COUNTDOWN: 'countdown', PLAYING: 'playing', FINISHED: 'finished' });

/** A zone of the field nobody owns: its team was wiped out, the first team to run in takes it. */
export const FREE_ZONE = -1;
