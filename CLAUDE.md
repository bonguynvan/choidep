# Chọi Dép Peti — project notes for Claude

Team slipper-throwing party game: the **big screen** (host page / OBS view) is the arena, every **phone is a
controller** (joystick + THROW). Part of the Peti family (`peti.vn` hub, `duavit.peti.vn`, admin at `admin.peti.vn`),
same sticker style (thick ink outlines, hard shadows, Baloo 2 + Be Vietnam Pro, cream/tomato/sun palette).
The user writes in **Vietnamese**; answer in Vietnamese. All UI text is Vietnamese. Live at **https://choidep.peti.vn**.

## Commands
```bash
npm install
npm run dev     # node --watch src/index.js
npm test        # node:test, test/*.test.js
```

## Architecture
- `shared/rules.js` — arena size, teams, all tuning numbers (`RULES`), pick-ups, frame flags. Used by server and browsers.
- `shared/catalog.js` — the character cast, **copied from bonguynvan/duavit** (with `public/js/paint.js`,
  `painters*.js`, `draw.js`, `spriteCache.js`). Keep in sync when duavit adds characters.
- `src/game/arena.js` — one room's match: lobby → countdown → playing → finished. Server-authoritative simulation
  (`step(now, dt)` at 20 Hz): movement, auto-aim (`#aim`: nearest hittable enemy inside the cone ahead, slight lead),
  projectiles, lives (`RULES.lives`; a hit = flinch + short shield, 0 lives = out and gone from frames), team zones
  (`zones`, see `shared/zones.js`: halves / a Y / quarters meeting at the centre; a team runs only in its zones,
  sliding along fences; a wiped-out team's zones are free and the first
  team next door to step in takes them), last team standing wins (`#checkTeams`), late joiners wait (`late`),
  pick-ups, bots (`#botThink`). Knocked-out phones follow a teammate (`viewFor` adds `f`).
  Modes (`MODES`, `arena.mode`, host picks in the lobby): `classic` (lives) and `infect` (a hit moves the target to
  the thrower's team and respawns it on that team's ground, `#infect`; `homeTeam` restores teams at the next start).
  `frame()` = compact positions for big screens,
  `controllerState(id)` = one phone's own state, `viewFor(id)` = the frame cut to the box around that player
  (`RULES.viewHalfWidth/Height`), `snapshot()` = roster/scores/field (sent when `entry.dirty`).
  The field grows with the crowd at each start (`fieldFor(players)` in `shared/rules.js`, up to 2.5x, growing from 20 players).
- `src/sockets.js` — big screens join `${code}:screen` and get `frame` (volatile, 20 Hz) + `fx`; phones get `me`
  (4 Hz), `view` (nearby-only frame, 10 Hz) and `me:fx` (their own hits). Never send the full 20 Hz stream to
  phones: bandwidth (~70 kbit/s per phone) is the real limit, not CPU. Measure with `node tools/loadtest.js`
  (150 phones/room: ~14% of a core, ~10 Mbit/s). `MAX_PLAYERS_TOTAL` caps players across all rooms.
- `src/server.js` — routes `/`, `/r/:code` (phone, `play.html`), `/r/:code/host`, `/r/:code/live` (OBS),
  `/api/rooms`, `/api/status`, operator API (`src/ops.js`, `OPS_TOKEN`), GA4 config.
- `src/rooms/roomManager.js`, `src/ops.js`, `src/stats.js`, `src/settings.js`, `src/db.js`, `src/text.js` — copied
  from duavit (rooms/limits, operator API for the peti.vn admin, daily counters, maintenance/announcement).
  The dashboard's "races" metrics (`roomRaces`, `roomRacers`) mean **matches / match players** here.
- `public/js/` — `arenaView.js` (canvas arena, interpolation ~110 ms behind, y-sorted sprites, flip when facing left,
  team ring + team-coloured badge; `follow` option = the phone's close-up camera with a "BẠN" marker), `host.js`, `live.js`, `play.js` (joystick, throw, vibration, keyboard WASD/Space),
  `hud.js`, `sfx.js` (WebAudio), `home.js`.

## Invariants
- Server is authoritative; phones only send `input {dx, dy}` and `throw`. Snapshots never contain host keys/tokens.
- CSP is strict (`script-src 'self'`): no inline scripts/styles; set styles via CSSOM (`el(tag, { style })`).
- Events are rate-limited per socket (40/s); joins 10/min/socket.
- No gambling vocabulary, nothing about money; content follows the Peti rules (no real people, no slurs).

## Conventions (user's rules)
- Commit/push only when asked; conventional commits; **never** add Claude attribution or session links.
- Small files (< 800 lines), tests alongside (`node:test`), check UI changes in a real browser before reporting.
- Write patch scripts to the scratchpad (never inline JS with backticks in double-quoted shell strings).
