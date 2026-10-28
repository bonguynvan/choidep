// OBS browser source: the arena, scores and timer only. No controls, no sound (OBS mixes its own audio).
import { request, roomCode, socket } from './net.js';
import { ArenaView } from './arenaView.js';
import { renderScores, resultsCard, timerText } from './hud.js';

const $ = (id) => document.getElementById(id);
const view = new ArenaView($('arena'));
let state = null;
let clockOffset = 0;

$('mini-qr').src = `/r/${roomCode}/qr.svg`;
$('mini-code').textContent = roomCode;

socket.on('connect', () => request('screen:watch'));
socket.on('state', (next) => {
  state = next;
  clockOffset = next.serverNow - Date.now();
  view.setState(next);
  renderScores($('scores'), next.teams, next.scores, { inMatch: next.phase !== 'lobby' });
  $('results').hidden = next.phase !== 'finished' || !next.results;
  if (!$('results').hidden) $('results').replaceChildren(resultsCard(next.results));
});
socket.on('frame', (frame) => {
  view.pushFrame(frame);
  if (state) renderScores($('scores'), state.teams, frame.sc);
});
socket.on('fx', (events) => view.addEffects(events));
setInterval(() => { $('timer').textContent = timerText(state, clockOffset); }, 250);
