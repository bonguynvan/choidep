// Score pills, the match timer and the results card: shared by the host screen and the OBS view.
import { TEAMS } from '/shared/rules.js';
import { el } from './ui.js';

export function renderScores(container, teams, scores) {
  container.replaceChildren(...Array.from({ length: teams }, (_, t) => el('span', { class: 'score' },
    el('span', { class: 'team-dot', style: { background: TEAMS[t].color } }),
    TEAMS[t].name,
    el('b', { style: { background: TEAMS[t].color } }, String(scores?.[t] ?? 0)))));
}

/** mm:ss left in the match (or empty outside a match), on the server's clock. */
export function timerText(state, clockOffset) {
  if (state?.phase !== 'playing' && state?.phase !== 'countdown') return '';
  const left = Math.max(0, Math.ceil((state.endsAt - (Date.now() + clockOffset)) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

export function resultsCard(results, actions = []) {
  const [first] = results.teams;
  const headline = results.draw ? '🤝 Hòa!' : `🏆 Đội ${first.name} thắng!`;
  return el('div', { class: 'card' },
    el('p', { class: 'eyebrow' }, 'Kết thúc trận'),
    el('h2', {}, headline),
    el('div', { class: 'final' }, results.teams.map((t) => el('span', { class: 'score' },
      el('span', { class: 'team-dot', style: { background: t.color } }), t.name, el('b', { style: { background: t.color } }, String(t.score))))),
    el('div', { class: 'awards' },
      results.thrower && results.thrower.value > 0
        ? el('div', { class: 'award' }, el('span', { class: 'eyebrow' }, '🎯 Thánh ném'), el('strong', {}, results.thrower.name), el('span', {}, `${results.thrower.value} lần trúng`))
        : null,
      results.sandbag && results.sandbag.value > 0
        ? el('div', { class: 'award' }, el('span', { class: 'eyebrow' }, '🥴 Bao cát'), el('strong', {}, results.sandbag.name), el('span', {}, `bị trúng ${results.sandbag.value} lần`))
        : null),
    actions.length ? el('div', { class: 'start-row' }, ...actions) : null);
}
