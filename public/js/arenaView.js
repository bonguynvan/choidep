// The big screen: the arena from above, each team in its own zone, slippers in team colours flying.
// The server sends positions 20 times a second; this view blends between them for smooth 60 fps.
import { ANIMALS, findAnimal } from '/shared/catalog.js';
import { ARENA, FLAGS, FREE_ZONE, PICKUPS, RULES, TEAMS } from '/shared/rules.js';
import { EMOJI_FONT, FONT, INK } from './draw.js';
import { SpriteCache } from './spriteCache.js';
import { zoneGeometry, zonePolygon } from '/shared/zones.js';

const DELAY_MS = 110; // draw slightly in the past: there are always two frames to blend between
const CHAR_SIZE = 60; // world units (the hitbox is 40 wide): small enough that a crowd stays readable
const FX_MS = 900;
const GO_MS = 900;
const BANNER_MS = 2200;
const PIP = 7; // radius of a life dot under a character
const PICKUP_ICON = Object.fromEntries(PICKUPS.map((p) => [p.id, p.icon]));
// Follow camera (phones): how much of the field is visible, in world units.
const FOLLOW_WIDTH_LANDSCAPE = 1100;
const FOLLOW_WIDTH_PORTRAIT = 620;
const CAMERA_EASE = 8; // 1/s

const lerp = (a, b, k) => a + (b - a) * k;

export class ArenaView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ follow?: () => string | null }} [opts] follow: a player id to keep in the middle (the phone view);
   *   without it the whole field is fitted on screen (big screen / OBS).
   */
  constructor(canvas, { follow = null } = {}) {
    this.canvas = canvas;
    this.follow = follow;
    this.camera = null;
    this.ctx = canvas.getContext('2d');
    this.sprites = new SpriteCache();
    this.glyphs = new Map();
    this.frames = []; // { t, p: Map(id -> [x, y, flags, lives]), s: Map(id -> [x, y, kind, team]), k: [...] }
    this.zones = null; // owner team of each zone (FREE_ZONE = up for grabs)
    this.focus = null; // phones: whom the server centres the view on (me, or a teammate once I'm out)
    this.banner = null;
    this.offset = null; // server clock minus performance.now(), from the freshest frames
    this.roster = new Map();
    this.phases = new Map(); // walk-cycle phase per player
    this.fx = [];
    this.state = null;
    this.clockOffset = 0;
    this.last = performance.now();
    const loop = (t) => {
      requestAnimationFrame(loop);
      try {
        this.#draw(t);
      } catch (error) {
        console.error('[ArenaView]', error);
      }
    };
    requestAnimationFrame(loop);
  }

  setState(state) {
    if (state.startsAt !== this.state?.startsAt) this.frames = [];
    this.state = state;
    this.clockOffset = state.serverNow - Date.now();
    this.roster = new Map(state.players.map((p) => [p.id, p]));
    this.zones = state.zones ?? null;
    this.sprites.warmList = [...new Set(state.players.map((p) => p.animal))].map((id) => findAnimal(id) ?? ANIMALS[0]);
  }

  pushFrame(frame) {
    const now = performance.now();
    const estimate = frame.t - now;
    // The least-delayed frame gives the best clock estimate; drift slowly so a lag spike doesn't stick.
    this.offset = this.offset === null || estimate > this.offset ? estimate : this.offset - 0.5;
    this.frames.push({
      t: frame.t,
      p: new Map(frame.p.map(([id, x, y, f, lives]) => [id, [x, y, f, lives]])),
      s: new Map(frame.s.map(([id, x, y, kind, team]) => [id, [x, y, kind, team]])),
      k: frame.k,
    });
    if (this.frames.length > 30) this.frames.shift();
    if (frame.z) this.zones = frame.z;
    if (frame.f) this.focus = frame.f;
  }

  /** Visual effects for hits, splashes, blocks and pick-ups (from the server's 'fx' events). */
  addEffects(events) {
    const born = performance.now();
    for (const e of events) {
      if (e.type === 'hit') {
        this.fx.push({ type: 'text', text: e.kind === 'balloon' ? 'ƯỚT!' : 'BỐP!', color: TEAMS[e.team]?.color ?? '#ffd23f', x: e.x, y: e.y - 70, born });
        this.fx.push({ type: 'glyph', icon: '💔', x: e.x + 34, y: e.y - 110, born });
      } else if (e.type === 'out') {
        this.fx.push({ type: 'puff', x: e.x, y: e.y - 30, born });
        this.fx.push({ type: 'text', text: 'LOẠI!', color: '#ff4d6d', big: true, x: e.x, y: e.y - 80, born });
      } else if (e.type === 'wipe') this.banner = { text: `Đội ${TEAMS[e.team].name} bị loại!`, color: TEAMS[e.team].color, born };
      else if (e.type === 'capture') this.banner = { text: `Đội ${TEAMS[e.team].name} chiếm thêm khu!`, color: TEAMS[e.team].color, born };
      else if (e.type === 'block') this.fx.push({ type: 'text', text: 'KENG!', color: '#d6dbe4', x: e.x, y: e.y - 70, born });
      else if (e.type === 'splash') this.fx.push({ type: 'splash', x: e.x, y: e.y, born });
      else if (e.type === 'pickup') this.fx.push({ type: 'text', text: `+${PICKUP_ICON[e.pickup] ?? ''}`, color: '#fff', x: e.x, y: e.y - 40, born });
      else if (e.type === 'go') this.goAt = born;
    }
    if (this.fx.length > 80) this.fx.splice(0, this.fx.length - 80);
  }

  #resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  #glyph(icon, px) {
    const key = `${icon}|${px}`;
    let glyph = this.glyphs.get(key);
    if (!glyph) {
      glyph = document.createElement('canvas');
      glyph.width = Math.ceil(px * 1.3);
      glyph.height = Math.ceil(px * 1.3);
      const g = glyph.getContext('2d');
      g.font = `${px}px ${EMOJI_FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(icon, glyph.width / 2, glyph.height / 2);
      this.glyphs.set(key, glyph);
    }
    return glyph;
  }

  /** The two frames around render time `t` and how far between them we are. */
  #pair(t) {
    const frames = this.frames;
    if (frames.length === 0) return null;
    if (frames.length === 1 || t <= frames[0].t) return { a: frames[0], b: frames[0], k: 0 };
    for (let i = frames.length - 1; i > 0; i -= 1) {
      if (frames[i - 1].t <= t) {
        const a = frames[i - 1];
        const b = frames[i];
        return { a, b, k: b.t === a.t ? 1 : Math.min(1, (t - a.t) / (b.t - a.t)) };
      }
    }
    const last = frames.at(-1);
    return { a: last, b: last, k: 0 };
  }

  /** Grass, one tinted zone per team (hatched when free), fences where owners change. */
  #floor(ctx) {
    const F = this.#field();
    const zones = this.zones ?? Array.from({ length: this.state?.teams ?? 2 }, (_, i) => i);
    const n = zones.length;
    ctx.fillStyle = '#7cc35a';
    ctx.fillRect(0, 0, F.width, F.height);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
    for (let x = 0; x < F.width; x += 200) ctx.fillRect(x, 0, 100, F.height); // mowed stripes
    const g = zoneGeometry(n, F);
    zones.forEach((owner, i) => {
      const outline = zonePolygon(i, n, F);
      ctx.beginPath();
      outline.forEach((pt, k) => (k === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
      ctx.closePath();
      if (owner === FREE_ZONE) {
        this.#freeZone(ctx, F, g.centres[i]);
        return;
      }
      ctx.fillStyle = TEAMS[owner].color;
      ctx.globalAlpha = 0.24;
      ctx.fill();
      ctx.globalAlpha = 1;
    });
    // Whose ground is whose, in big faded letters (a purple tint alone barely shows on grass).
    ctx.font = `800 ${Math.round(F.height * 0.11)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = 0.3;
    zones.forEach((owner, i) => {
      if (owner === FREE_ZONE) return;
      ctx.fillStyle = TEAMS[owner].color;
      ctx.fillText(`ĐỘI ${TEAMS[owner].name.toUpperCase()}`, g.centres[i].x, g.centres[i].y);
    });
    ctx.globalAlpha = 1;
    // Ray i runs between zone i-1 and zone i: a fence unless one team owns both.
    g.ends.forEach((end, i) => {
      if (zones[(i + n - 1) % n] === zones[i]) return;
      ctx.beginPath();
      ctx.moveTo(g.center.x, g.center.y);
      ctx.lineTo(end.x, end.y);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 16;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.strokeStyle = '#fff6e5';
      ctx.lineWidth = 8;
      ctx.setLineDash([36, 14]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineCap = 'butt';
    });
    ctx.strokeStyle = INK;
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, F.width - 10, F.height - 10);
  }

  /** A wiped-out team's zone (the current path): hatched, with a note that it's up for grabs. */
  #freeZone(ctx, F, centre) {
    ctx.save();
    ctx.clip();
    ctx.fillStyle = 'rgba(60, 48, 30, 0.22)';
    ctx.fillRect(0, 0, F.width, F.height);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 18;
    for (let d = -F.height; d < F.width; d += 70) {
      ctx.beginPath();
      ctx.moveTo(d, F.height);
      ctx.lineTo(d + F.height, 0);
      ctx.stroke();
    }
    ctx.restore();
    ctx.font = `800 44px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 8;
    ctx.strokeStyle = INK;
    ctx.fillStyle = '#fff6e5';
    for (const [text, dy] of [['KHU TRỐNG', -28], ['Vào trước thì chiếm!', 26]]) {
      ctx.strokeText(text, centre.x, centre.y + dy);
      ctx.fillText(text, centre.x, centre.y + dy);
    }
  }

  #players(ctx, pair, now, dt) {
    const list = [];
    for (const [id, b] of pair.b.p) {
      const a = pair.a.p.get(id) ?? b;
      list.push({ id, x: lerp(a[0], b[0], pair.k), y: lerp(a[1], b[1], pair.k), flags: b[2], lives: b[3] });
    }
    list.sort((p, q) => p.y - q.y); // nearer the bottom = in front
    this.sprites.beginFrame();
    for (const { id, x, y, flags, lives } of list) {
      const pl = this.roster.get(id);
      if (!pl) continue;
      const team = TEAMS[pl.team] ?? TEAMS[0];
      const stunned = Boolean(flags & FLAGS.stunned);
      const moving = Boolean(flags & FLAGS.moving) && !stunned;
      const phase = (this.phases.get(id) ?? Math.random() * 6) + (moving ? dt * 14 : 0);
      this.phases.set(id, phase);
      ctx.fillStyle = team.color;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(x, y, 27, 10, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      this.#lives(ctx, x, y + 21, lives);
      const items = [];
      if (flags & FLAGS.helmet) items.push('⛑️');
      if (flags & FLAGS.tea) items.push('🧋');
      if (flags & FLAGS.triple) items.push('🩴');
      if (flags & FLAGS.balloon) items.push('🎈');
      ctx.globalAlpha = flags & FLAGS.shielded && Math.floor(now / 110) % 2 ? 0.4 : 1;
      this.sprites.draw(ctx, findAnimal(pl.animal) ?? ANIMALS[0], {
        x, y, size: CHAR_SIZE, phase, moving, items,
        face: { initials: pl.initials, color: team.color },
        tilt: stunned ? -0.55 : 0, // a flinch, not a knock-down
        flip: Boolean(flags & FLAGS.left),
      });
      ctx.globalAlpha = 1;
      if (this.follow && id === this.follow()) this.#meMarker(ctx, x, y, team.color, now, 'BẠN');
      else if (this.follow && id === this.focus) this.#meMarker(ctx, x, y, team.color, now, 'ĐANG XEM');
      if (stunned) ctx.drawImage(this.#glyph('💢', 30), x + 6, y - CHAR_SIZE * 1.25, 38, 38);
    }
    if (this.sprites.warmList) this.sprites.warm(this.sprites.warmList, { size: CHAR_SIZE, scale: ctx.getTransform().a });
  }

  /** This match's field size (it grows with the crowd); the default before any match. */
  #field() {
    return this.state?.field ?? ARENA;
  }

  /** Lives left as dots under the feet: full ones red, lost ones pale. */
  #lives(ctx, x, y, lives = RULES.lives) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = INK;
    for (let i = 0; i < RULES.lives; i += 1) {
      ctx.fillStyle = i < lives ? '#ff4d6d' : 'rgba(255, 255, 255, 0.55)';
      ctx.beginPath();
      ctx.arc(x + (i - (RULES.lives - 1) / 2) * PIP * 2.6, y, PIP, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  /** "BẠN" (or "ĐANG XEM") and a bobbing arrow over the character the phone follows. */
  #meMarker(ctx, x, y, color, now, label) {
    const top = y - CHAR_SIZE * 1.45 + Math.sin(now / 180) * 5;
    ctx.fillStyle = color;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x - 16, top);
    ctx.lineTo(x + 16, top);
    ctx.lineTo(x, top + 20);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.font = `800 24px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 6;
    ctx.strokeText(label, x, top - 4);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x, top - 4);
  }

  /** Where my own player (or the teammate I watch once out) is right now, for the follow camera. */
  #myPosition(pair) {
    const id = this.focus ?? this.follow?.();
    const b = id && pair?.b.p.get(id);
    if (!b) return null;
    const a = pair.a.p.get(id) ?? b;
    return { x: lerp(a[0], b[0], pair.k), y: lerp(a[1], b[1], pair.k) };
  }

  #projectiles(ctx, pair, now) {
    for (const [id, b] of pair.b.s) {
      const a = pair.a.s.get(id) ?? b;
      const x = lerp(a[0], b[0], pair.k);
      const y = lerp(a[1], b[1], pair.k);
      ctx.fillStyle = 'rgba(29, 26, 47, 0.2)';
      ctx.beginPath();
      ctx.ellipse(x, y + 34, 12, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      const sprite = this.#missile(b[2] === 1 ? 'balloon' : 'shoe', TEAMS[b[3]]?.color ?? '#fff');
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(b[2] === 1 ? Math.sin(now / 90) * 0.3 : (now / 70) % (Math.PI * 2));
      ctx.drawImage(sprite, -26, -26, 52, 52);
      ctx.restore();
    }
  }

  /** A slipper or a water balloon in the thrower's team colour (drawn once, then reused). */
  #missile(kind, color) {
    const key = `${kind}|${color}`;
    let sprite = this.glyphs.get(key);
    if (sprite) return sprite;
    sprite = document.createElement('canvas');
    sprite.width = 104;
    sprite.height = 104;
    const g = sprite.getContext('2d');
    g.scale(2, 2);
    g.lineJoin = 'round';
    g.strokeStyle = INK;
    g.lineWidth = 3;
    g.fillStyle = color;
    if (kind === 'balloon') {
      g.beginPath();
      g.arc(26, 24, 17, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.beginPath();
      g.moveTo(22, 43);
      g.lineTo(30, 43);
      g.lineTo(26, 39);
      g.closePath();
      g.fill();
      g.stroke();
      g.fillStyle = 'rgba(255, 255, 255, 0.7)';
      g.beginPath();
      g.ellipse(20, 17, 4, 6, -0.6, 0, Math.PI * 2);
      g.fill();
    } else {
      // Flip-flop seen from above: a sole and a white V strap.
      g.beginPath();
      g.ellipse(26, 26, 22, 11, 0, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.strokeStyle = '#fff6e5';
      g.lineWidth = 4;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(14, 26);
      g.lineTo(28, 18);
      g.moveTo(14, 26);
      g.lineTo(28, 34);
      g.stroke();
      g.fillStyle = INK;
      g.beginPath();
      g.arc(14, 26, 2.5, 0, Math.PI * 2);
      g.fill();
    }
    this.glyphs.set(key, sprite);
    return sprite;
  }

  #pickups(ctx, pair, now) {
    for (const [, x, y, type] of pair.b.k) {
      const bob = Math.sin(now / 250 + x) * 5;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, 28, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.drawImage(this.#glyph(PICKUP_ICON[type] ?? '❓', 34), x - 22, y - 24 + bob, 44, 44);
    }
  }

  #effects(ctx, now) {
    this.fx = this.fx.filter((f) => now - f.born < FX_MS);
    for (const f of this.fx) {
      const k = (now - f.born) / FX_MS;
      ctx.globalAlpha = 1 - k * k;
      if (f.type === 'splash') {
        ctx.strokeStyle = '#7ec8f2';
        ctx.lineWidth = 10 * (1 - k);
        ctx.beginPath();
        ctx.arc(f.x, f.y, 30 + k * 110, 0, Math.PI * 2);
        ctx.stroke();
      } else if (f.type === 'puff') {
        // Knocked out: a cloud of dust where the character stood.
        ctx.fillStyle = '#efe6d2';
        ctx.strokeStyle = INK;
        ctx.lineWidth = 3;
        for (let i = 0; i < 7; i += 1) {
          const ang = (i * Math.PI * 2) / 7;
          ctx.beginPath();
          ctx.arc(f.x + Math.cos(ang) * (14 + k * 60), f.y + Math.sin(ang) * (10 + k * 34), 22 * (1 - k * 0.6), 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      } else if (f.type === 'glyph') {
        ctx.drawImage(this.#glyph(f.icon, 30), f.x - 19, f.y - 19 - k * 40, 38, 38);
      } else {
        const size = (f.big ? 52 : 34) * (1 + Math.sin(Math.min(1, k * 4) * Math.PI) * 0.3);
        ctx.font = `800 ${size}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 7;
        ctx.strokeStyle = INK;
        ctx.strokeText(f.text, f.x, f.y - k * 50);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, f.y - k * 50);
      }
    }
    ctx.globalAlpha = 1;
  }

  #overlay(ctx, w, h, now) {
    const s = this.state;
    let text = null;
    if (s?.phase === 'countdown') {
      const left = s.startsAt - (Date.now() + this.clockOffset);
      text = left > 0 ? String(Math.ceil(left / 1000)) : null;
    }
    if (!text && this.goAt && now - this.goAt < GO_MS) text = 'NÉM!';
    this.#banner(ctx, w, h, now);
    if (!text) return;
    const size = Math.min(w, h) * 0.28;
    ctx.font = `800 ${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = size * 0.08;
    ctx.strokeStyle = INK;
    ctx.strokeText(text, w / 2, h / 2);
    ctx.fillStyle = text === 'NÉM!' ? '#ff5a36' : '#ffd23f';
    ctx.fillText(text, w / 2, h / 2);
  }

  /** "Đội X bị loại!" / "Đội X chiếm thêm khu!" across the top for a moment. */
  #banner(ctx, w, h, now) {
    const b = this.banner;
    if (!b || now - b.born > BANNER_MS) return;
    const k = (now - b.born) / BANNER_MS;
    const size = Math.max(22, Math.min(w, h) * (this.follow ? 0.06 : 0.075));
    const y = h * 0.2 - Math.max(0, 0.15 - k) * 200; // drops in, then stays
    ctx.globalAlpha = k > 0.8 ? (1 - k) * 5 : 1;
    ctx.font = `800 ${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const pad = size * 0.5;
    const width = ctx.measureText(b.text).width + pad * 2;
    ctx.fillStyle = b.color;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.roundRect(w / 2 - width / 2, y - size * 0.75, width, size * 1.5, size * 0.4);
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = size * 0.12;
    ctx.strokeText(b.text, w / 2, y);
    ctx.fillStyle = '#fff';
    ctx.fillText(b.text, w / 2, y);
    ctx.globalAlpha = 1;
  }

  #draw(now) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const { w, h } = this.#resize();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    if (w === 0) return;
    const pair = this.offset === null ? null : this.#pair(now + this.offset - DELAY_MS);
    ctx.save();
    if (this.follow) {
      // Phone: a close-up that follows my player; beyond the field edge is plain background.
      const visible = w >= h ? FOLLOW_WIDTH_LANDSCAPE : FOLLOW_WIDTH_PORTRAIT;
      const scale = Math.max(w / visible, h / (RULES.viewHalfHeight * 2));
      const me = this.#myPosition(pair) ?? this.camera ?? { x: this.#field().width / 2, y: this.#field().height / 2 };
      const target = { x: me.x, y: me.y - CHAR_SIZE * 0.5 };
      this.camera = this.camera ? {
        x: lerp(this.camera.x, target.x, Math.min(1, dt * CAMERA_EASE)),
        y: lerp(this.camera.y, target.y, Math.min(1, dt * CAMERA_EASE)),
      } : target;
      ctx.fillStyle = '#e9dcc0';
      ctx.fillRect(0, 0, w, h);
      ctx.translate(w / 2 - this.camera.x * scale, h / 2 - this.camera.y * scale);
      ctx.scale(scale, scale);
    } else {
      const F = this.#field();
      const scale = Math.min(w / F.width, h / F.height);
      ctx.translate((w - F.width * scale) / 2, (h - F.height * scale) / 2);
      ctx.scale(scale, scale);
    }
    this.#floor(ctx);
    if (pair) {
      this.#pickups(ctx, pair, now);
      this.#players(ctx, pair, now, dt);
      this.#projectiles(ctx, pair, now);
    }
    this.#effects(ctx, now);
    ctx.restore();
    this.#overlay(ctx, w, h, now);
  }
}
