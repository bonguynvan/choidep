// Little synthesized sound effects for the big screen (no audio files). Browsers only allow sound after
// a click/tap on the page, so the first interaction unlocks it.
const KEY = 'peti.choidep.sound';
let ctx = null;
let enabled = (() => {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
})();
let lastBonk = 0;

function audio() {
  if (!ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
['pointerdown', 'keydown'].forEach((type) => document.addEventListener(type, () => enabled && audio(), { passive: true }));

function tone(freq, { at = 0, dur = 0.12, type = 'square', gain = 0.08, slide = 0 } = {}) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + at;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

const SOUNDS = {
  bonk: () => tone(220, { type: 'triangle', dur: 0.14, gain: 0.12, slide: -120 }),
  splash: () => { tone(900, { type: 'sine', dur: 0.25, slide: -700, gain: 0.08 }); tone(500, { at: 0.05, type: 'sine', dur: 0.2, slide: -300, gain: 0.06 }); },
  block: () => tone(1500, { type: 'square', dur: 0.08, gain: 0.05 }),
  out: () => { tone(330, { type: 'sawtooth', dur: 0.35, gain: 0.08, slide: -260 }); tone(160, { at: 0.1, type: 'triangle', dur: 0.3, gain: 0.1, slide: -100 }); },
  wipe: () => [392, 330, 262].forEach((f, i) => tone(f, { at: i * 0.14, dur: 0.2, type: 'square', gain: 0.06 })),
  capture: () => [523, 784].forEach((f, i) => tone(f, { at: i * 0.1, dur: 0.16, type: 'triangle', gain: 0.09 })),
  pickup: () => { tone(660, { dur: 0.08 }); tone(990, { at: 0.08, dur: 0.1 }); },
  go: () => tone(440, { type: 'sawtooth', dur: 0.5, gain: 0.07, slide: 220 }),
  end: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, { at: i * 0.12, dur: 0.18, type: 'triangle', gain: 0.09 })),
  beep: () => tone(880, { dur: 0.1, gain: 0.06 }),
};

export function play(name) {
  if (!enabled) return;
  if (name === 'bonk') {
    const now = performance.now();
    if (now - lastBonk < 90) return; // a big brawl would otherwise be one long buzz
    lastBonk = now;
  }
  SOUNDS[name]?.();
}

/** Sounds for a batch of server events. */
export function playEvents(events) {
  for (const e of events) {
    if (e.type === 'hit') play(e.kind === 'balloon' ? 'splash' : 'bonk');
    else if (e.type === 'splash') play('splash');
    else if (e.type === 'block') play('block');
    else if (e.type === 'out' || e.type === 'wipe' || e.type === 'capture') play(e.type);
    else if (e.type === 'pickup') play('pickup');
    else if (e.type === 'go') play('go');
    else if (e.type === 'end') play('end');
  }
}

export const soundOn = () => enabled;
export function toggleSound() {
  enabled = !enabled;
  try { localStorage.setItem(KEY, enabled ? 'on' : 'off'); } catch { /* ignore */ }
  if (enabled) audio();
  return enabled;
}
