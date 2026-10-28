// The phone: join with a name and a character, then it becomes a controller (joystick + THROW).
import { ANIMALS, findAnimal } from '/shared/catalog.js';
import { MODES, PICKUPS, RULES, TEAMS } from '/shared/rules.js';
import { request, roomStorage, socket, toast } from './net.js';
import { paintAnimalCard } from './draw.js';
import { ArenaView } from './arenaView.js';

const $ = (id) => document.getElementById(id);
const INPUT_EVERY_MS = 60;
const STICK_RADIUS = 60; // px of drag for full speed
const PICKUP_ICON = Object.fromEntries(PICKUPS.map((p) => [p.id, p.icon]));
const buzz = (pattern) => navigator.vibrate?.(pattern);
const hearts = (n, max = RULES.lives) => '❤️'.repeat(Math.max(0, n)) + '🤍'.repeat(Math.max(0, max - n));
const note = (title, small) => [document.createTextNode(title), Object.assign(document.createElement('small'), { textContent: small })];

let state = null;
let myId = null;
let mine = null; // the latest 'me' (lives, out, watching…)
// The phone shows the arena around its own player (the server sends only what is nearby).
const view = new ArenaView($('view'), { follow: () => myId });
// A real keyboard and mouse: show the key hint instead of the touch joystick.
if (matchMedia('(hover: hover) and (pointer: fine)').matches) $('pad').classList.add('desktop');
let characterIndex = Math.floor(Math.random() * ANIMALS.length);

// ---------- join ----------
function showCharacter() {
  const animal = ANIMALS[characterIndex];
  $('character-name').textContent = animal.name;
  paintAnimalCard($('preview'), animal, { initials: initialsPreview(), color: '#ff5a36' });
}
const initialsPreview = () => {
  const words = $('name').value.trim().split(/\s+/).filter(Boolean);
  return words.length ? (words.length === 1 ? [words[0]] : [words[0], words.at(-1)]).map((w) => Array.from(w)[0].toUpperCase()).join('') : '?';
};
$('prev').addEventListener('click', () => { characterIndex = (characterIndex + ANIMALS.length - 1) % ANIMALS.length; showCharacter(); });
$('next').addEventListener('click', () => { characterIndex = (characterIndex + 1) % ANIMALS.length; showCharacter(); });
$('name').addEventListener('input', showCharacter);

function bind(reply) {
  myId = reply.playerId;
  roomStorage.set('token', reply.token);
  $('join-view').hidden = true;
  $('pad').hidden = false;
  render();
}

$('join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('join-error').hidden = true;
  const reply = await request('player:join', { name: $('name').value, animal: ANIMALS[characterIndex].id });
  if (reply.error) {
    $('join-error').textContent = reply.error;
    $('join-error').hidden = false;
    return;
  }
  bind(reply);
});

socket.on('connect', async () => {
  const token = roomStorage.get('token');
  if (token) {
    const reply = await request('player:resume', { token });
    if (reply.ok) return bind(reply);
    roomStorage.remove('token');
  }
  myId = null;
  $('pad').hidden = true;
  $('join-view').hidden = false;
  showCharacter();
});
socket.on('kicked', () => {
  roomStorage.remove('token');
  myId = null;
  toast('Host đã mời bạn ra khỏi phòng');
  $('pad').hidden = true;
  $('join-view').hidden = false;
});

// ---------- the controller ----------
function render() {
  if (!state || !myId) return;
  const me = state.players.find((p) => p.id === myId);
  if (!me) return;
  const team = TEAMS[me.team];
  $('pad-bar').style.background = team.color;
  $('me-name').textContent = `${me.name} · Đội ${team.name}`;
  const waiting = $('waiting');
  const out = Boolean(mine?.dead) && state.phase !== 'lobby';
  $('pad').classList.toggle('out', out && state.phase !== 'finished');
  waiting.classList.remove('spectate');
  waiting.hidden = false;
  if (state.phase === 'lobby') {
    const mode = MODES.find((m) => m.id === state.mode) ?? MODES[0];
    waiting.replaceChildren(...note(`Bạn ở đội ${team.name}!`, `Chế độ ${mode.name}: ${mode.hint} Chỉ chạy trong khu đội mình. Chờ host bấm bắt đầu nhé.`));
  } else if (state.phase === 'finished' && state.results) {
    const rank = state.results.teams.findIndex((t) => t.id === me.team) + 1;
    const headline = state.results.draw && rank <= 2 ? '🤝 Hòa!' : rank === 1 ? '🏆 Đội bạn thắng!' : `Đội bạn hạng ${rank}`;
    const kills = mine?.kills ?? me.kills;
    waiting.replaceChildren(...note(headline, state.mode === 'infect'
      ? `Bạn kéo ${kills} người về đội, ném trúng ${mine?.hits ?? me.hits} lần.`
      : `Bạn hạ ${kills} người, ném trúng ${mine?.hits ?? me.hits} lần.`));
  } else if (out) {
    waiting.classList.add('spectate');
    const watching = mine.watching ? `Đang xem ${mine.watching} chơi.` : 'Đang xem trận đấu.';
    waiting.replaceChildren(...note(mine.late ? '⏳ Trận đang diễn ra' : '💥 Bạn bị loại!', mine.late ? `Bạn sẽ vào trận sau. ${watching}` : `${watching} Cổ vũ đồng đội nào!`));
  } else {
    waiting.hidden = true;
  }
}

socket.on('state', (next) => {
  state = next;
  view.setState(next);
  render();
});
socket.on('view', (frame) => {
  if (frame) view.pushFrame(frame);
});
socket.on('me', (me) => {
  if (!me) return;
  const changed = mine?.dead !== me.dead || mine?.watching !== me.watching;
  mine = me;
  $('pad').classList.toggle('stunned', me.stunnedMs > 0);
  $('throw').style.setProperty('--cd', String(Math.min(1, me.cooldownMs / RULES.throwCooldownMs)));
  $('power').textContent = [me.power && PICKUP_ICON[me.power], me.helmet && '⛑️', me.teaMs > 0 && '🧋'].filter(Boolean).join('');
  $('me-lives').textContent = me.late ? '⏳' : hearts(me.lives, state?.mode === 'infect' ? RULES.infectLives : RULES.lives);
  $('me-stats').textContent = `🎯 ${me.kills}`;
  if (changed) render();
});
socket.on('me:fx', (events) => {
  view.addEffects(events);
  for (const e of events) {
    if (e.type === 'hit' && e.to === myId) {
      buzz([140, 60, 140]);
      toast(state?.mode === 'infect' ? '💥 Nứt đầu rồi! Trúng thêm 1 lần là bị kéo sang đội kia' : `💔 Còn ${e.lives} mạng!`);
    }
    else if (e.type === 'out' && e.to === myId) buzz([300, 80, 300]);
    else if (e.type === 'hit' && e.from === myId) { buzz(40); toast('🎯 Trúng rồi!'); }
    else if (e.type === 'out' && e.from === myId) { buzz([60, 40, 60]); toast('💥 Hạ gục 1 người!'); }
    else if (e.type === 'infect' && e.to === myId) { buzz([200, 60, 200]); toast(`🧟 Bạn bị lây! Giờ bạn ở đội ${TEAMS[e.team].name}`); }
    else if (e.type === 'infect' && e.from === myId) { buzz([60, 40, 60]); toast('🧟 Kéo được 1 người về đội!'); }
    else if (e.type === 'capture' && e.to === myId) toast('🚩 Bạn chiếm được khu mới cho đội!');
    else if (e.type === 'block' && e.to === myId) { buzz(60); toast('⛑️ Mũ đã đỡ giúp bạn!'); }
    else if (e.type === 'pickup' && e.to === myId) toast(`Nhặt được ${PICKUP_ICON[e.pickup] ?? ''} ${PICKUPS.find((p) => p.id === e.pickup)?.hint ?? ''}`);
  }
});

// Joystick: wherever the thumb lands is the centre.
let origin = null;
let input = { dx: 0, dy: 0 };
let sentAt = 0;
let sent = '';
function send(force = false) {
  const now = performance.now();
  const key = `${input.dx.toFixed(2)},${input.dy.toFixed(2)}`;
  if (key === sent || (!force && now - sentAt < INPUT_EVERY_MS)) return;
  sent = key;
  sentAt = now;
  socket.emit('input', input);
}
setInterval(() => send(true), INPUT_EVERY_MS); // the last move always gets through

const zone = $('stick-zone');
zone.addEventListener('pointerdown', (event) => {
  zone.setPointerCapture(event.pointerId);
  const box = zone.getBoundingClientRect();
  origin = { x: event.clientX, y: event.clientY, left: box.left, top: box.top };
  Object.assign($('stick').style, { left: `${event.clientX - box.left}px`, top: `${event.clientY - box.top}px` });
  $('stick').hidden = false;
});
zone.addEventListener('pointermove', (event) => {
  if (!origin) return;
  let dx = (event.clientX - origin.x) / STICK_RADIUS;
  let dy = (event.clientY - origin.y) / STICK_RADIUS;
  const len = Math.hypot(dx, dy);
  if (len > 1) { dx /= len; dy /= len; }
  input = { dx, dy };
  $('knob').style.transform = `translate(${dx * STICK_RADIUS}px, ${dy * STICK_RADIUS}px)`;
  send();
});
const release = () => {
  origin = null;
  input = { dx: 0, dy: 0 };
  $('stick').hidden = true;
  $('knob').style.transform = '';
  send(true);
};
zone.addEventListener('pointerup', release);
zone.addEventListener('pointercancel', release);

const throwSlipper = () => {
  if (!myId || mine?.dead) return; // out (or waiting for the next match): nothing to throw
  socket.emit('throw');
  buzz(15);
};
$('throw').addEventListener('pointerdown', (event) => {
  event.preventDefault();
  throwSlipper();
});

// Keyboard (testing on a laptop): WASD / arrows to run, Space to throw.
const keys = new Set();
const KEYMAP = { ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] };
const fromKeys = () => {
  const v = [...keys].reduce((acc, k) => [acc[0] + KEYMAP[k][0], acc[1] + KEYMAP[k][1]], [0, 0]);
  input = { dx: v[0], dy: v[1] };
  send(true);
};
document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.code === 'Space') { event.preventDefault(); throwSlipper(); }
  if (KEYMAP[event.code] && !keys.has(event.code)) { keys.add(event.code); fromKeys(); }
});
document.addEventListener('keyup', (event) => {
  if (keys.delete(event.code)) fromKeys();
});

// Keep the screen awake while playing (where the browser supports it).
document.addEventListener('pointerdown', () => navigator.wakeLock?.request('screen').catch(() => {}), { once: true });
showCharacter();
