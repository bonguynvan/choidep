// Big screen + host controls: the lobby (QR, teams, settings), then the arena during a match.
import { MODES, RULES, TEAMS } from '/shared/rules.js';
import { el, request, roomCode, roomStorage, socket, toast } from './net.js';
import { ArenaView } from './arenaView.js';
import { renderScores, resultsCard, timerText } from './hud.js';
import { playEvents, soundOn, toggleSound } from './sfx.js';
import { track } from './analytics.js';

const $ = (id) => document.getElementById(id);
const view = new ArenaView($('arena'));
let state = null;
let clockOffset = 0;
let liveUrl = '';
let lastScores = '';

// The host key arrives once in the link (?key=…): keep it for this room and wipe it from the address bar.
const urlKey = new URLSearchParams(location.search).get('key');
if (urlKey) {
  roomStorage.set('hostKey', urlKey);
  history.replaceState(null, '', location.pathname);
}

async function act(event, data) {
  const reply = await request(event, data);
  if (reply.error) toast(reply.error);
  return reply;
}

async function auth() {
  const reply = await request('host:auth', { key: roomStorage.get('hostKey') });
  if (reply.error) {
    document.body.replaceChildren(el('main', { class: 'room-missing' },
      el('h1', {}, 'Không mở được màn hình host'),
      el('p', {}, `${reply.error}. Hãy mở đúng link host bạn nhận khi tạo phòng (link có ?key=…).`),
      el('a', { class: 'btn btn-primary', href: `/r/${roomCode}` }, 'Vào chơi như người thường')));
    return;
  }
  $('qr').src = reply.qr;
  $('code').textContent = reply.code;
  $('join-url').textContent = reply.joinUrl.replace(/^https?:\/\//, '');
  $('mini-qr').src = `/r/${reply.code}/qr.svg`;
  $('mini-code').textContent = reply.code;
  liveUrl = reply.liveUrl;
}
socket.on('connect', auth);

// ---------- lobby ----------
const segment = (container, choices, label, onPick) => choices.map((value) => {
  const button = el('button', { type: 'button', role: 'radio', onclick: () => onPick(value) }, label(value));
  container.append(button);
  return { value, button };
});
const modeButtons = segment($('mode'), MODES.map((m) => m.id), (id) => MODES.find((m) => m.id === id).name, (mode) => act('host:mode', { mode }));
const teamButtons = segment($('teams'), RULES.teamChoices, (n) => `${n} đội`, (teams) => act('host:teams', { teams }));
const durationButtons = segment($('duration'), RULES.durationChoices, (s) => `${s / 60} phút`, (seconds) => act('host:duration', { seconds }));

function renderLobby() {
  modeButtons.forEach(({ value, button }) => button.setAttribute('aria-checked', String(value === state.mode)));
  $('mode-hint').textContent = MODES.find((m) => m.id === state.mode)?.hint ?? '';
  teamButtons.forEach(({ value, button }) => button.setAttribute('aria-checked', String(value === state.teams)));
  durationButtons.forEach(({ value, button }) => button.setAttribute('aria-checked', String(value === state.durationSec)));
  if (document.activeElement !== $('title')) $('title').value = state.title;
  $('team-cols').replaceChildren(...Array.from({ length: state.teams }, (_, t) => {
    const members = state.players.filter((p) => p.team === t);
    return el('div', { class: 'team-col' },
      el('h3', { style: { background: TEAMS[t].color } }, `Đội ${TEAMS[t].name}`, el('span', {}, String(members.length))),
      el('ul', {}, members.map((p) => el('li', { class: `chip${p.connected ? '' : ' off'}` },
        `${p.isBot ? '🤖 ' : ''}${p.name}`,
        el('button', { type: 'button', title: `Mời ${p.name} ra`, 'aria-label': `Mời ${p.name} ra`, onclick: () => act('host:kick', { id: p.id }) }, '×')))));
  }));
  const people = state.players.length;
  $('count').textContent = `${people} người · tối đa ${RULES.maxPlayers}`;
  $('start').disabled = people < 2;
}

function render() {
  const inMatch = state.phase !== 'lobby';
  $('lobby').hidden = inMatch;
  $('arena-wrap').hidden = !inMatch;
  $('join-hint').hidden = !inMatch;
  $('end-match').hidden = !(state.phase === 'countdown' || state.phase === 'playing');
  if (!inMatch) renderLobby();
  renderScores($('scores'), state.teams, state.scores, { inMatch: state.phase !== 'lobby' });
  lastScores = state.scores.join();
  $('results').hidden = state.phase !== 'finished' || !state.results;
  if (state.phase === 'finished' && state.results) {
    $('results').replaceChildren(resultsCard(state.results, [
      el('button', { class: 'btn btn-primary', type: 'button', onclick: () => startMatch() }, '🔁 Đấu lại'),
      el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => act('host:lobby') }, 'Về sảnh'),
    ]));
  }
}

function startMatch() {
  track('match_start', { players: state?.players.length ?? 0, mode: state?.mode ?? 'classic' });
  return act('host:start');
}

socket.on('state', (next) => {
  state = next;
  clockOffset = next.serverNow - Date.now();
  view.setState(next);
  render();
});
socket.on('frame', (frame) => {
  view.pushFrame(frame);
  const scores = frame.sc.join();
  if (scores !== lastScores && state) {
    lastScores = scores;
    renderScores($('scores'), state.teams, frame.sc);
  }
});
socket.on('fx', (events) => {
  view.addEffects(events);
  playEvents(events);
});

setInterval(() => { $('timer').textContent = timerText(state, clockOffset); }, 250);

$('start').addEventListener('click', startMatch);
$('end-match').addEventListener('click', () => act('host:lobby'));
// Close the room for good: a second click within a few seconds confirms (no browser dialog).
const CLOSE_CONFIRM_MS = 4000;
let closeArmedUntil = 0;
$('close-room').addEventListener('click', () => {
  if (Date.now() > closeArmedUntil) {
    closeArmedUntil = Date.now() + CLOSE_CONFIRM_MS;
    $('close-room').textContent = 'Bấm lần nữa để đóng';
    setTimeout(() => {
      if (Date.now() >= closeArmedUntil) $('close-room').textContent = 'Đóng phòng';
    }, CLOSE_CONFIRM_MS);
    return;
  }
  act('host:close');
});
$('shuffle').addEventListener('click', () => act('host:shuffle'));
$('add-bots').addEventListener('click', () => act('host:bots', { count: 5 }));
$('remove-bots').addEventListener('click', () => act('host:removeBots'));
$('title').addEventListener('change', () => act('host:title', { title: $('title').value.trim() }));
$('copy-live').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(liveUrl);
    toast('Đã copy link OBS: thêm vào OBS dạng Browser Source');
  } catch {
    toast(liveUrl);
  }
});
$('fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => toast('Trình duyệt không cho toàn màn hình'));
});
const renderSound = () => { $('sound').textContent = soundOn() ? '🔊' : '🔇'; };
$('sound').addEventListener('click', () => {
  toggleSound();
  renderSound();
});
renderSound();
