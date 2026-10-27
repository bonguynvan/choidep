// Home: create a room (the big screen) or join one with its code.
import { onStatus } from './statusBanner.js';
import { track } from './analytics.js';

const $ = (id) => document.getElementById(id);

async function createRoom() {
  const button = $('create-room');
  button.disabled = true;
  $('create-error').hidden = true;
  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? 'Không tạo được phòng, thử lại nhé');
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
onStatus(({ maintenance }) => {
  $('create-room').disabled = maintenance;
});
