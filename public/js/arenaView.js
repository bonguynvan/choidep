// The big screen: the arena from above, characters in team colours, slippers flying.
// The server sends positions 20 times a second; this view blends between them for smooth 60 fps.
import { ANIMALS, findAnimal } from '/shared/catalog.js';
import { ARENA, FLAGS, PICKUPS, TEAMS } from '/shared/rules.js';
import { EMOJI_FONT, FONT, INK } from './draw.js';
import { SpriteCache } from './spriteCache.js';

const DELAY_MS = 110; // draw slightly in the past: there are always two frames to blend between
const CHAR_SIZE = 72; // world units (the hitbox is 48 wide)
const FX_MS = 900;
const GO_MS = 900;
const PICKUP_ICON = Object.fromEntries(PICKUPS.map((p) => [p.id, p.icon]));

const lerp = (a, b, k) => a + (b - a) * k;

export class ArenaView {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sprites = new SpriteCache();
    this.glyphs = new Map();
    this.frames = []; // { t, p: Map(id -> [x, y, flags]), s: Map(id -> [x, y, kind, team]), k: [...] }
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
    this.sprites.warmList = [...new Set(state.players.map((p) => p.animal))].map((id) => findAnimal(id) ?? ANIMALS[0]);
  }

  pushFrame(frame) {
    const now = performance.now();
    const estimate = frame.t - now;
    // The least-delayed frame gives the best clock estimate; drift slowly so a lag spike doesn't stick.
    this.offset = this.offset === null || estimate > this.offset ? estimate : this.offset - 0.5;
    this.frames.push({
      t: frame.t,
      p: new Map(frame.p.map(([id, x, y, f]) => [id, [x, y, f]])),
      s: new Map(frame.s.map(([id, x, y, kind, team]) => [id, [x, y, kind, team]])),
      k: frame.k,
    });
    if (this.frames.length > 30) this.frames.shift();
  }

  /** Visual effects for hits, splashes, blocks and pick-ups (from the server's 'fx' events). */
  addEffects(events) {
    const born = performance.now();
    for (const e of events) {
      if (e.type === 'hit') this.fx.push({ type: 'text', text: e.kind === 'balloon' ? 'ƯỚT!' : 'BỐP!', color: '#ffd23f', x: e.x, y: e.y - 70, born });
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

  #floor(ctx, teams) {
    ctx.fillStyle = '#7cc35a';
    ctx.fillRect(0, 0, ARENA.width, ARENA.height);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
    for (let x = 0; x < ARENA.width; x += 200) ctx.fillRect(x, 0, 100, ARENA.height); // mowed stripes
    const strip = ARENA.width / teams;
    for (let t = 0; t < teams; t += 1) {
      ctx.fillStyle = TEAMS[t].color;
      ctx.globalAlpha = 0.13;
      ctx.fillRect(t * strip, 0, strip, ARENA.height);
      ctx.globalAlpha = 1;
      if (t > 0) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
        ctx.lineWidth = 6;
        ctx.setLineDash([24, 18]);
        ctx.beginPath();
        ctx.moveTo(t * strip, 0);
        ctx.lineTo(t * strip, ARENA.height);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(ARENA.width / 2, ARENA.height / 2, 110, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, ARENA.width - 10, ARENA.height - 10);
  }

  #players(ctx, pair, now, dt) {
    const list = [];
    for (const [id, b] of pair.b.p) {
      const a = pair.a.p.get(id) ?? b;
      list.push({ id, x: lerp(a[0], b[0], pair.k), y: lerp(a[1], b[1], pair.k), flags: b[2] });
    }
    list.sort((p, q) => p.y - q.y); // nearer the bottom = in front
    this.sprites.beginFrame();
    for (const { id, x, y, flags } of list) {
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
      ctx.ellipse(x, y, 32, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const items = [];
      if (flags & FLAGS.helmet) items.push('⛑️');
      if (flags & FLAGS.tea) items.push('🧋');
      if (flags & FLAGS.triple) items.push('🩴');
      if (flags & FLAGS.balloon) items.push('🎈');
      ctx.globalAlpha = flags & FLAGS.shielded && Math.floor(now / 110) % 2 ? 0.4 : 1;
      this.sprites.draw(ctx, findAnimal(pl.animal) ?? ANIMALS[0], {
        x, y, size: CHAR_SIZE, phase, moving, items,
        face: { initials: pl.initials, color: team.color },
        tilt: stunned ? -1.3 : 0,
        flip: Boolean(flags & FLAGS.left),
      });
      ctx.globalAlpha = 1;
      if (stunned) {
        const star = this.#glyph('⭐', 18);
        for (let i = 0; i < 3; i += 1) {
          const ang = now / 160 + (i * Math.PI * 2) / 3;
          ctx.drawImage(star, x - 30 + Math.cos(ang) * 26 - 12, y - 44 + Math.sin(ang) * 9 - 12, 24, 24);
        }
      }
    }
    if (this.sprites.warmList) this.sprites.warm(this.sprites.warmList, { size: CHAR_SIZE, scale: ctx.getTransform().a });
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
      const glyph = this.#glyph(b[2] === 1 ? '🎈' : '🩴', 34);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((now / 70) % (Math.PI * 2));
      ctx.drawImage(glyph, -22, -22, 44, 44);
      ctx.restore();
    }
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
      } else {
        const size = 34 * (1 + Math.sin(Math.min(1, k * 4) * Math.PI) * 0.3);
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

  #draw(now) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const { w, h } = this.#resize();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    if (w === 0) return;
    const scale = Math.min(w / ARENA.width, h / ARENA.height);
    ctx.save();
    ctx.translate((w - ARENA.width * scale) / 2, (h - ARENA.height * scale) / 2);
    ctx.scale(scale, scale);
    this.#floor(ctx, this.state?.teams ?? 2);
    const pair = this.offset === null ? null : this.#pair(now + this.offset - DELAY_MS);
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
