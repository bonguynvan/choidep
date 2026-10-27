// Team pills (people still standing), the match timer and the results card: shared by the host screen and the OBS view.
import { TEAMS } from '/shared/rules.js';
import { el } from './ui.js';

/** One pill per team with how many of its people are still standing; a wiped-out team is greyed. */
export function renderScores(container, teams, alive, { inMatch = true } = {}) {
  container.replaceChildren(...Array.from({ length: teams }, (_, t) => {
    const n = alive?.[t] ?? 0;
    const out = inMatch && n === 0;
    return el('span', { class: `score${out ? ' out' : ''}`, title: `Đội ${TEAMS[t].name}: còn ${n} người` },
      el('span', { class: 'team-dot', style: { background: TEAMS[t].color } }),
      TEAMS[t].name,
      el('b', { style: { background: TEAMS[t].color } }, out ? '✖' : `👤 ${n}`));
  }));
}

/** mm:ss left in the match (or empty outside a match), on the server's clock. */
export function timerText(state, clockOffset) {
  if (state?.phase !== 'playing' && state?.phase !== 'countdown') return '';
  const left = Math.max(0, Math.ceil((state.endsAt - (Date.now() + clockOffset)) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

const teamLine = (t) => el('span', { class: `score${t.alive === 0 ? ' out' : ''}` },
  el('span', { class: 'team-dot', style: { background: t.color } }), t.name,
  el('b', { style: { background: t.color } }, t.alive === 0 ? 'bị loại' : `còn ${t.alive} người · ${t.lives} ❤`));

export function resultsCard(results, actions = []) {
  const [first] = results.teams;
  const headline = results.draw ? '🤝 Hòa!' : `🏆 Đội ${first.name} thắng!`;
  return el('div', { class: 'card' },
    el('p', { class: 'eyebrow' }, 'Kết thúc trận'),
    el('h2', {}, headline),
    el('div', { class: 'final' }, results.teams.map(teamLine)),
    el('div', { class: 'awards' },
      results.thrower
        ? el('div', { class: 'award' }, el('span', { class: 'eyebrow' }, '🎯 Thánh ném'), el('strong', {}, results.thrower.name), el('span', {}, `hạ ${results.thrower.value} người`))
        : null,
      results.survivor
        ? el('div', { class: 'award' }, el('span', { class: 'eyebrow' }, '🛡️ Người sống sót'), el('strong', {}, results.survivor.name), el('span', {}, `còn ${results.survivor.value} ❤`))
        : null),
    actions.length ? el('div', { class: 'start-row' }, ...actions) : null);
}
