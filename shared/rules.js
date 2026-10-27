// Game rules shared by the server (simulation) and the browsers (drawing, controller hints).

export const ARENA = Object.freeze({ width: 1600, height: 900 });

export const TEAMS = Object.freeze([
  { id: 0, name: 'Đỏ', color: '#e63946' },
  { id: 1, name: 'Xanh', color: '#2d7ff9' },
  { id: 2, name: 'Vàng', color: '#f4b400' },
  { id: 3, name: 'Tím', color: '#8e44ad' },
]);

export const RULES = Object.freeze({
  tickMs: 50, // server simulation + broadcast: 20 per second
  playerRadius: 24, // every character shares one hitbox, whatever its drawing
  topMargin: 90, // positions are the feet: keep room above for the character's body and head
  speed: 240, // units per second
  throwCooldownMs: 800,
  projectileSpeed: 720,
  projectileTtlMs: 1300,
  projectileRadius: 12,
  throwRange: 760,
  aimConeDeg: 80, // auto-aim looks for enemies within this cone ahead
  stunMs: 1800,
  shieldMs: 1000, // after getting up: can't be hit again straight away
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
});

export const PICKUPS = Object.freeze([
  { id: 'triple', icon: '🩴', name: 'Dép tổ ong', hint: 'Lần ném tới bay 3 chiếc' },
  { id: 'balloon', icon: '🎈', name: 'Bóng nước', hint: 'Lần ném tới nổ cả một vùng' },
  { id: 'helmet', icon: '⛑️', name: 'Mũ bảo hiểm', hint: 'Đỡ được 1 lần trúng' },
  { id: 'tea', icon: '🧋', name: 'Trà sữa', hint: 'Chạy nhanh trong 5 giây' },
]);

/** Bit flags of a player in the compact frame (see Arena#frame). */
export const FLAGS = Object.freeze({ stunned: 1, shielded: 2, left: 4, moving: 8, helmet: 16, tea: 32, triple: 64, balloon: 128 });

export const PHASES = Object.freeze({ LOBBY: 'lobby', COUNTDOWN: 'countdown', PLAYING: 'playing', FINISHED: 'finished' });
