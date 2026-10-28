// Home: create a room (the big screen) or join one with its code.
import { onStatus } from './statusBanner.js';
import { track } from './analytics.js';
import { el } from './ui.js';
import { loadSavedRooms, rememberRoom, saveRooms } from './myRooms.js';

const $ = (id) => document.getElementById(id);

// ---------- "Phòng của tôi": rooms created in this browser, still open ----------
// Only a 404 means closed: a hiccup (5xx, 429, offline) must not drop a live room from the list.
const roomExists = (code) => fetch(`/r/${code}`, { method: 'HEAD' }).then((r) => r.status !== 404).catch(() => true);

async function renderMyRooms() {
  const saved = loadSavedRooms();
  const open = (await Promise.all(saved.map(async (r) => ((await roomExists(r.code)) ? r : null)))).filter(Boolean);
  if (open.length !== saved.length) saveRooms(open); // closed rooms drop off the list
  $('my-rooms').hidden = open.length === 0;
  $('my-rooms-list').replaceChildren(...open.map(({ code }) => el('li', {},
    el('span', { class: 'code' }, code),
    el('small', {}, 'Đang mở'),
    el('a', { class: 'btn btn-primary', href: `/r/${code}/host` }, 'Màn hình host'), // the key is in this browser already
    el('a', { class: 'btn btn-ghost', href: `/r/${code}` }, 'Link người chơi'))));
}

async function createRoom() {
  const button = $('create-room');
  button.disabled = true;
  $('create-error').hidden = true;
  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? 'Không tạo được phòng, thử lại nhé');
    saveRooms(rememberRoom(loadSavedRooms(), body, Date.now()));
    track('room_create');
    location.assign(body.hostUrl); // the host link carries the key once; host.js stores it
  } catch (error) {
    $('create-error').textContent = error.message;
    $('create-error').hidden = false;
    button.disabled = false;
  }
}

$('create-room').addEventListener('click', createRoom);
$('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const code = $('join-code').value.trim().toUpperCase();
  if (/^[A-Z0-9]{6}$/.test(code)) location.assign(`/r/${code}`);
});
renderMyRooms();
onStatus(({ maintenance }) => {
  $('create-room').disabled = maintenance;
});
