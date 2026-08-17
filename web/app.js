import { columnChart, lineChart, stackedRows, divergingBars, sparkline, hideTip } from './charts.js';

/* ------------------------------------------------------------------ helpers */

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(3)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const fmt = new Intl.NumberFormat('de-CH');
const num = (v, d = 0) =>
  v === null || v === undefined ? '–' : new Intl.NumberFormat('de-CH', { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
const pct = (v, d = 1) => (v === null || v === undefined ? '–' : `${num(v, d)} %`);
const signed = (v, d = 0) => (v > 0 ? '+' : '') + num(v, d);

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
function formatDate(iso, withWeekday = true) {
  if (!iso) return '–';
  const d = new Date(iso + 'T12:00:00');
  const s = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  return withWeekday ? `${WEEKDAYS[d.getDay()]} ${s}` : s;
}

const shortName = (n) => (n ?? '').replace(/\s+(I|II|III|1|2|3)$/, '');

/** Monogramm aus dem Vereinsnamen, ohne Rechtsform-Präfix (FC, SC, ESC …). */
function crest(name) {
  const words = shortName(name)
    .split(/\s+/)
    .filter((w) => !/^(fc|sc|esc|fv|sv|us|ac|cs)$/i.test(w));
  const base = (words.join('') || name || '?').replace(/[^\p{L}]/gu, '');
  return h('span', { class: 'crest', 'aria-hidden': 'true' }, base.slice(0, 3).toUpperCase());
}

const teamCell = (name) =>
  h('span', { class: 'team-cell' }, crest(name), h('span', { class: 'team-cell__name' }, name));

/* -------------------------------------------------------------------- state */

const state = {
  index: null,
  key: null,
  data: null,
  view: 'uebersicht',
  highlightTeam: null,
  playerFilter: { q: '', team: 'all', group: 'all', minApps: 1, sort: 'goals', dir: -1 },
  matchFilter: { team: 'all', round: 'all' },
  tableMode: 'total',
};

const TABS_LEAGUE = [
  ['uebersicht', 'Übersicht'],
  ['tabelle', 'Tabelle & Form'],
  ['spieler', 'Spieler'],
  ['teams', 'Teams'],
  ['spiele', 'Spiele'],
  ['analyse', 'Analyse'],
  ['daten', 'Daten & Qualität'],
];

const TABS_CUP = [
  ['uebersicht', 'Übersicht'],
  ['turnierbaum', 'Turnierbaum'],
  ['runden', 'Runden'],
  ['spieler', 'Spieler'],
  ['spiele', 'Spiele'],
  ['daten', 'Daten & Qualität'],
];

const TABS_VORSCHAU = [
  ['uebersicht', 'Übersicht'],
  ['spiele', 'Spielplan'],
  ['daten', 'Daten & Qualität'],
];

const isCup = () => state.data?.meta.type === 'cup';
/** Meisterschaft ist angesetzt, aber noch kein Spiel ausgetragen. */
const notStarted = () => !isCup() && state.data?.league.matchesPlayed === 0;
const tabs = () => (isCup() ? TABS_CUP : notStarted() ? TABS_VORSCHAU : TABS_LEAGUE);

const teamByKey = (key) => state.data.teams.find((t) => t.key === key);
const playersOf = (key) => state.data.players.filter((p) => p.teamKey === key);

/* -------------------------------------------------------------- components */

const card = (title, sub, ...body) =>
  h(
    'section',
    { class: 'card' },
    h('div', { class: 'card__head' }, h('h2', {}, title), sub && h('span', { class: 'card__sub' }, sub)),
    ...body,
  );

const tile = (label, value, hint) =>
  h(
    'div',
    { class: 'tile' },
    h('span', { class: 'tile__label' }, label),
    h('span', { class: 'tile__value' }, value),
    hint && h('span', { class: 'tile__hint' }, hint),
  );

function formRun(str) {
  const chars = (str ?? '').split('');
  return h(
    'span',
    { class: 'form-run' },
    chars.length
      ? chars.map((c) => h('span', { class: `pill pill--${c}`, title: { W: 'Sieg', D: 'Unentschieden', L: 'Niederlage' }[c] }, c === 'D' ? 'U' : c === 'L' ? 'N' : 'S'))
      : h('span', { class: 'pill pill--none' }, '–'),
  );
}

const legend = (items, kind = 'swatch') =>
  h(
    'div',
    { class: 'legend' },
    items.map((it) =>
      h(
        'span',
        { class: 'legend__item' },
        h('span', {
          class: `legend__swatch${kind === 'line' ? ' legend__swatch--line' : ''}`,
          style: `background:${it.color}`,
        }),
        it.name,
      ),
    ),
  );

function chartBox(height = 200) {
  return h('div', { style: `min-height:${height}px` });
}

const statRow = (items) =>
  h(
    'div',
    { class: 'statrow' },
    items.map(([k, v, s]) =>
      h('div', {}, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v), s && h('span', { class: 's' }, s)),
    ),
  );

const pageHead = (eyebrow, title, sub, aside = null) =>
  h(
    'div',
    { class: 'page-head' },
    h(
      'div',
      {},
      eyebrow && h('span', { class: 'eyebrow' }, eyebrow),
      h('h1', {}, title),
      sub && h('p', {}, sub),
    ),
    aside,
  );

/** Tabelle mit optionaler Sortierung; jede Grafik hat so ihren Tabellen-Zwilling. */
function dataTable(columns, rows, opts = {}) {
  const { onRow = null, sort = null, onSort = null } = opts;
  const thead = h(
    'thead',
    {},
    h(
      'tr',
      {},
      columns.map((c) =>
        h(
          'th',
          {
            class: [c.left ? 't-left' : '', onSort && c.sortKey ? 'sortable' : ''].join(' ').trim(),
            title: c.title ?? null,
            'aria-sort': sort && c.sortKey === sort.key ? (sort.dir < 0 ? 'descending' : 'ascending') : 'none',
            onclick: onSort && c.sortKey ? () => onSort(c.sortKey) : null,
          },
          c.label,
        ),
      ),
    ),
  );
  const tbody = h(
    'tbody',
    {},
    rows.map((r) =>
      h(
        'tr',
        {
          class: [onRow ? 'is-clickable' : '', opts.lineBelow?.(r) ? 'line-below' : ''].join(' ').trim(),
          onclick: onRow ? () => onRow(r) : null,
        },
        columns.map((c) => {
          const v = c.cell(r);
          return h('td', { class: [c.left ? 't-left' : '', c.strong ? 'num-strong' : ''].join(' ').trim() }, v);
        }),
      ),
    ),
  );
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, thead, tbody));
}

/* ------------------------------------------------------------------ drawer */

function openDrawer(title, sub, ...content) {
  const dlg = document.getElementById('drawer');
  const body = document.getElementById('drawer-body');
  body.replaceChildren(
    h(
      'div',
      { class: 'drawer__head' },
      h('div', {}, h('h2', { style: 'font-size:19px' }, title), sub && h('p', { class: 'card__sub', style: 'margin:3px 0 0' }, sub)),
      h('button', { class: 'btn', onclick: () => dlg.close() }, 'Schliessen'),
    ),
    ...content,
  );
  if (!dlg.open) dlg.showModal();
  body.scrollTop = 0;
}

/* ------------------------------------------------------------------- views */

function viewUebersicht() {
  if (isCup()) return viewCupUebersicht();
  if (notStarted()) return viewVorschau();
  const d = state.data;
  const L = d.league;
  const table = d.teams;
  const leader = table[0];
  const scorers = d.players.filter((p) => p.goals > 0).slice(0, 10);

  const goalBuckets = h('div', {});
  columnChart(goalBuckets, {
    data: Object.entries(L.goalsByBucket).map(([label, v]) => ({ label, values: [v] })),
    series: [{ name: 'Tore', color: 'var(--series-1)' }],
    height: 190,
    labelValues: true,
  });

  return h(
    'div',
    { class: 'stack' },
    pageHead(
      `${d.meta.association} · Saison ${d.meta.seasonLabel}`,
      `${d.meta.league ?? ''} · ${d.meta.group ?? d.meta.label}`,
      `${L.matchesPlayed} von ${L.matchesTotal} Spielen ausgewertet · ${L.coverage.lineups} Spielberichte mit vollständiger Aufstellung`,
    ),

    h(
      'div',
      { class: 'hero' },
      h('div', { class: 'hero__figure' }, num(L.goalsPerMatch, 2)),
      h(
        'div',
        { class: 'hero__meta' },
        h('h2', {}, 'Tore pro Spiel'),
        h(
          'p',
          {},
          `${fmt.format(L.goals)} Tore in ${L.matchesPlayed} Spielen. ` +
            `${pct(L.homeWinPct)} Heimsiege, ${pct(L.drawPct)} Unentschieden, ${pct(L.awayWinPct)} Auswärtssiege.`,
        ),
      ),
    ),

    h(
      'div',
      { class: 'grid grid--tiles' },
      tile('Meister', shortName(leader.name), `${leader.points} Punkte · ${leader.goalsFor}:${leader.goalsAgainst}`),
      tile('Beide Teams treffen', pct(L.bothScoredPct)),
      tile('Über 2.5 Tore', pct(L.over25Pct)),
      tile('Elfmeter-Tore', fmt.format(L.penalties), `${fmt.format(L.ownGoals)} Eigentore`),
      tile('Karten', fmt.format(L.cards.yellow + L.cards.secondYellow + L.cards.red), `${L.cards.yellow} gelb · ${L.cards.secondYellow} gelb-rot · ${L.cards.red} rot`),
      tile('Spielberichte', pct(L.coverage.lineupPct), `${L.coverage.lineups} Spiele mit Aufstellung`),
    ),

    h(
      'div',
      { class: 'grid grid--wide-left' },
      card(
        'Tabelle',
        'Punkte, Tordifferenz, Form der letzten fünf Spiele',
        dataTable(
          [
            { label: '#', cell: (t) => h('span', { class: 'rank' }, t.rank) },
            { label: 'Team', left: true, cell: (t) => teamCell(t.name) },
            { label: 'Sp', cell: (t) => t.played },
            { label: 'S', cell: (t) => t.wins },
            { label: 'U', cell: (t) => t.draws },
            { label: 'N', cell: (t) => t.losses },
            { label: 'Tore', cell: (t) => `${t.goalsFor}:${t.goalsAgainst}` },
            { label: 'Diff', cell: (t) => signed(t.goalDiff) },
            { label: 'Pkt', strong: true, cell: (t) => t.points },
            { label: 'Form', left: true, cell: (t) => formRun(t.form5) },
          ],
          table,
          { onRow: (t) => showTeam(t.key), lineBelow: (t) => t.lineBelow },
        ),
      ),
      h(
        'div',
        { class: 'stack' },
        card(
          'Torschützen',
          'Aus den Spieltelegrammen berechnet',
          dataTable(
            [
              { label: 'Tore', strong: true, cell: (p) => p.goals },
              { label: 'Spieler', left: true, cell: (p) => p.name },
              { label: 'Team', left: true, cell: (p) => h('span', { class: 'muted' }, shortName(p.team ?? '')) },
              { label: 'Sp', cell: (p) => p.apps },
            ],
            scorers,
            { onRow: (p) => showPlayer(p.key) },
          ),
        ),
      ),
    ),

    h(
      'div',
      { class: 'grid grid--2' },
      card('Tore nach Spielminute', 'Alle Tore der Gruppe, 15-Minuten-Fenster', goalBuckets),
      card(
        'Höchste Siege',
        'Grösste Tordifferenzen der Saison',
        dataTable(
          [
            { label: 'Runde', cell: (m) => m.round },
            { label: 'Datum', left: true, cell: (m) => formatDate(m.date, false) },
            { label: 'Begegnung', left: true, cell: (m) => `${shortName(m.home)} – ${shortName(m.away)}` },
            { label: 'Resultat', strong: true, cell: (m) => `${m.score.home}:${m.score.away}` },
          ],
          L.biggestWins,
          { onRow: (m) => showMatch(m.id) },
        ),
      ),
    ),
  );
}

/** Meisterschaft vor dem ersten Anpfiff: Spielplan statt Statistik. */
function viewVorschau() {
  const d = state.data;
  const kickoff = d.matches.filter((m) => m.date).sort((a, b) => a.date.localeCompare(b.date));
  const firstDate = kickoff[0]?.date ?? null;
  const opening = kickoff.filter((m) => m.date === firstDate);
  const rounds = [...new Set(d.matches.map((m) => m.round).filter(Boolean))].length;
  const days = firstDate
    ? Math.round((new Date(firstDate + 'T12:00:00') - new Date().setHours(12, 0, 0, 0)) / 86400000)
    : null;

  return h(
    'div',
    { class: 'stack' },
    pageHead(
      `${d.meta.association} · Saison ${d.meta.seasonLabel}`,
      `${d.meta.league ?? ''} · ${d.meta.group ?? d.meta.label}`,
      'Der Spielplan steht, gespielt wurde noch nicht. Sobald die ersten Resultate erfasst sind, füllen sich Tabelle, Analyse und Spielerstatistik automatisch.',
    ),
    h(
      'div',
      { class: 'hero' },
      h('div', { class: 'hero__figure' }, days !== null && days > 0 ? days : '0'),
      h(
        'div',
        { class: 'hero__meta' },
        h('h2', {}, days === 1 ? 'Tag bis zum Saisonstart' : 'Tage bis zum Saisonstart'),
        h('p', {}, firstDate ? `Erster Spieltag: ${formatDate(firstDate)}` : 'Noch kein Datum angesetzt.'),
      ),
    ),
    h(
      'div',
      { class: 'grid grid--tiles' },
      tile('Mannschaften', d.teams.length),
      tile('Angesetzte Spiele', d.matches.length),
      tile('Runden', rounds),
      tile('Saisonende', d.meta.lastMatch ? formatDate(d.meta.lastMatch, false) : '–'),
    ),
    card(
      'Erster Spieltag',
      firstDate ? formatDate(firstDate) : null,
      dataTable(
        [
          { label: 'Zeit', cell: (m) => m.time ?? '–' },
          { label: 'Heim', left: true, cell: (m) => teamCell(m.home.name) },
          { label: '', cell: () => '–' },
          { label: 'Gast', left: true, cell: (m) => teamCell(m.away.name) },
        ],
        opening,
      ),
    ),
    card(
      'Mannschaften',
      `${d.teams.length} Teams in der Gruppe`,
      dataTable(
        [
          { label: 'Team', left: true, cell: (t) => teamCell(t.name) },
          { label: 'Spiele angesetzt', cell: (t) => d.matches.filter((m) => m.homeKey === t.key || m.awayKey === t.key).length },
        ],
        [...d.teams].sort((a, b) => a.name.localeCompare(b.name)),
      ),
    ),
  );
}

/* ------------------------------------------------------------------- Cup --- */

const stagesOf = () => {
  const d = state.data;
  if (d.stages?.length) {
    return d.stages
      .map((s) => ({
        name: s.name,
        matches: s.matchIds.map((id) => d.matches.find((m) => m.id === id)).filter(Boolean),
      }))
      .filter((s) => s.matches.length);
  }
  const bySection = new Map();
  for (const m of d.matches) {
    const key = m.section ?? 'Spiele';
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(m);
  }
  return [...bySection].map(([name, matches]) => ({ name, matches }));
};

function viewCupUebersicht() {
  const d = state.data;
  const L = d.league;
  const stages = stagesOf();
  // Einen Sieger gibt es erst, wenn die letzte Runde wirklich das Endspiel ist.
  const lastStage = stages[stages.length - 1];
  const final =
    lastStage && lastStage.matches.length === 1 && /final/i.test(lastStage.name ?? '')
      ? lastStage.matches.find((m) => m.played)
      : null;
  const winner = final
    ? final.score.home > final.score.away
      ? final.home.name
      : final.away.name
    : null;
  const scorers = d.players.filter((p) => p.goals > 0).slice(0, 10);

  return h(
    'div',
    { class: 'stack' },
    pageHead(
      `${d.meta.association} · Saison ${d.meta.seasonLabel}`,
      d.meta.label,
      `${stages.length} Runden · ${L.matchesPlayed} von ${L.matchesTotal} Spielen gespielt · ${d.teams.length} Mannschaften`,
    ),
    winner
      ? h(
          'div',
          { class: 'hero' },
          h('div', { class: 'hero__figure', style: 'font-size:clamp(28px,4vw,40px)' }, winner),
          h(
            'div',
            { class: 'hero__meta' },
            h('h2', {}, 'Cupsieger'),
            h(
              'p',
              {},
              `Final ${formatDate(final.date, false)}: ${final.home.name} ${final.score.home}:${final.score.away} ${final.away.name}` +
                (final.venue ? ` · ${final.venue}` : ''),
            ),
          ),
        )
      : null,
    h(
      'div',
      { class: 'grid grid--tiles' },
      tile('Tore pro Spiel', num(L.goalsPerMatch, 2), `${fmt.format(L.goals)} Tore total`),
      tile('Mannschaften', d.teams.length),
      tile('Beide Teams treffen', pct(L.bothScoredPct)),
      tile('Elfmeter-Tore', fmt.format(L.penalties), `${fmt.format(L.ownGoals)} Eigentore`),
      tile(
        'Karten',
        fmt.format(L.cards.yellow + L.cards.secondYellow + L.cards.red),
        `${L.cards.yellow} gelb · ${L.cards.secondYellow} gelb-rot · ${L.cards.red} rot`,
      ),
      tile('Spielberichte', pct(L.coverage.lineupPct), `${L.coverage.lineups} mit Aufstellung`),
    ),
    h(
      'div',
      { class: 'grid grid--wide-left' },
      card(
        'Torreichste Spiele',
        null,
        dataTable(
          [
            { label: 'Datum', left: true, cell: (m) => formatDate(m.date, false) },
            { label: 'Begegnung', left: true, cell: (m) => `${shortName(m.home)} – ${shortName(m.away)}` },
            { label: 'Resultat', strong: true, cell: (m) => `${m.score.home}:${m.score.away}` },
          ],
          L.highestScoring,
          { onRow: (m) => showMatch(m.id) },
        ),
      ),
      card(
        'Torschützen',
        'Aus den Spieltelegrammen berechnet',
        dataTable(
          [
            { label: 'Tore', strong: true, cell: (p) => p.goals },
            { label: 'Spieler', left: true, cell: (p) => p.name },
            { label: 'Team', left: true, cell: (p) => h('span', { class: 'muted' }, shortName(p.team ?? '')) },
          ],
          scorers,
          { onRow: (p) => showPlayer(p.key) },
        ),
      ),
    ),
  );
}

const winnerOf = (m) =>
  !m.played || !m.score
    ? null
    : m.score.home > m.score.away
      ? m.home.name
      : m.score.away > m.score.home
        ? m.away.name
        : null;

/**
 * Runden in Baumform bringen: Jedes Spiel bekommt das Spiel der Folgerunde
 * zugewiesen, in dem sein Sieger wieder auftaucht. Danach wird jede Runde so
 * sortiert, dass die Zubringer direkt bei ihrem Folgespiel stehen.
 *
 * Über die Namen statt über feste Paarungen, weil Amateur-Cups Freilose und
 * Zwischenrunden kennen - dort halbiert sich die Spielzahl nicht sauber.
 */
function bracketModel(stages) {
  const rounds = stages.map((s) => ({ name: s.name, matches: s.matches.map((m) => ({ ...m })) }));
  for (let i = rounds.length - 2; i >= 0; i--) {
    const next = rounds[i + 1].matches;
    const rank = new Map();
    for (const m of rounds[i].matches) {
      const w = winnerOf(m);
      if (!w) continue;
      const ni = next.findIndex((nm) => nm.home.name === w || nm.away.name === w);
      if (ni < 0) continue;
      m.parentId = next[ni].id;
      rank.set(m.id, ni * 2 + (next[ni].home.name === w ? 0 : 1));
    }
    rounds[i].matches.sort((a, b) => (rank.get(a.id) ?? 1e6) - (rank.get(b.id) ?? 1e6));
  }
  return rounds;
}

function bracketMatch(m) {
  const w = winnerOf(m);
  const side = (team, goals) => {
    const c = crest(team);
    c.classList.add('bracket__crest');
    return h(
      'div',
      { class: `bracket__side${w === team ? ' bracket__side--win' : ''}` },
      c,
      h('span', { class: 'bracket__team', title: team }, team),
      h('span', { class: 'bracket__score' }, goals ?? '–'),
    );
  };
  return h(
    'div',
    {
      class: 'bracket__match',
      dataset: { mid: String(m.id), ...(m.parentId ? { parent: String(m.parentId) } : {}) },
      onclick: () => showMatch(m.id),
    },
    h(
      'div',
      { class: 'bracket__meta' },
      h('span', {}, m.date ? formatDate(m.date, false) : 'noch offen'),
      m.venue ? h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:110px' }, m.venue.split(',')[0]) : null,
    ),
    side(m.home.name, m.played ? m.score.home : null),
    side(m.away.name, m.played ? m.score.away : null),
  );
}

/** Verbindungslinien nach dem Layout aus den echten Kastenpositionen zeichnen. */
function drawBracketLinks(board, svg) {
  const base = board.getBoundingClientRect();
  const w = board.offsetWidth;
  const hgt = board.offsetHeight;
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  svg.setAttribute('width', w);
  svg.setAttribute('height', hgt);
  while (svg.firstChild) svg.firstChild.remove();

  board.querySelectorAll('[data-parent]').forEach((node) => {
    const parent = board.querySelector(`[data-mid="${node.dataset.parent}"]`);
    if (!parent) return;
    const a = node.getBoundingClientRect();
    const b = parent.getBoundingClientRect();
    const x1 = a.right - base.left;
    const y1 = a.top - base.top + a.height / 2;
    const x2 = b.left - base.left;
    const y2 = b.top - base.top + b.height / 2;
    const mid = x1 + (x2 - x1) / 2;
    const dy = y2 - y1;
    const r = Math.min(9, Math.abs(dy) / 2, Math.abs(mid - x1));
    const dir = dy >= 0 ? 1 : -1;
    const d =
      Math.abs(dy) < 1
        ? `M${x1} ${y1}H${x2}`
        : `M${x1} ${y1}H${mid - r}Q${mid} ${y1} ${mid} ${y1 + r * dir}V${y2 - r * dir}Q${mid} ${y2} ${mid + r} ${y2}H${x2}`;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'var(--line-strong)');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
  });
}

function viewTurnierbaum() {
  const d = state.data;
  const rounds = bracketModel(stagesOf());
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'bracket__svg');

  const board = h(
    'div',
    { class: 'bracket' },
    svg,
    rounds.map((r) =>
      h(
        'div',
        { class: 'bracket__round' },
        h('div', { class: 'bracket__label' }, r.name),
        h('div', { class: 'bracket__slots' }, r.matches.map(bracketMatch)),
      ),
    ),
  );

  const wrap = h('div', { class: 'bracket-wrap' }, board);
  const redraw = () => drawBracketLinks(board, svg);
  requestAnimationFrame(() => {
    redraw();
    requestAnimationFrame(redraw);
  });
  new ResizeObserver(() => redraw()).observe(board);

  const played = d.matches.filter((m) => m.played).length;
  return h(
    'div',
    { class: 'stack' },
    pageHead(
      'Tableau',
      'Turnierbaum',
      `${rounds.length} ${rounds.length === 1 ? 'Runde' : 'Runden'} · ${played} von ${d.matches.length} Spielen gespielt. ` +
        'Die Linien folgen den Siegern von Runde zu Runde. Klick öffnet den Spielbericht.',
    ),
    h('section', { class: 'card card--flush' }, h('div', { style: 'padding:0 18px' }, wrap)),
  );
}

function viewRunden() {
  const d = state.data;
  const stages = stagesOf();
  return h(
    'div',
    { class: 'stack' },
    pageHead('Tableau', 'Runden', 'Der Weg zum Titel, Runde für Runde. Klick öffnet den Spielbericht.'),
    ...stages.reverse().map((s) =>
      card(
        s.name,
        `${s.matches.length} ${s.matches.length === 1 ? 'Spiel' : 'Spiele'}`,
        dataTable(
          [
            { label: 'Datum', left: true, cell: (m) => formatDate(m.date) },
            { label: 'Heim', left: true, cell: (m) => teamCell(m.home.name) },
            { label: 'Resultat', strong: true, cell: (m) => (m.played ? `${m.score.home}:${m.score.away}` : '–:–') },
            { label: 'Gast', left: true, cell: (m) => teamCell(m.away.name) },
            { label: 'Ort', left: true, cell: (m) => h('span', { class: 'muted' }, m.venue ?? '–') },
          ],
          s.matches,
          { onRow: (m) => showMatch(m.id) },
        ),
      ),
    ),
  );
}

function viewTabelle() {
  const d = state.data;
  const mode = state.tableMode;
  const rows = d.teams.map((t) => {
    const src = mode === 'total' ? t : t[mode];
    return {
      ...t,
      _played: src.played,
      _wins: src.wins,
      _draws: src.draws,
      _losses: src.losses,
      _gf: src.goalsFor,
      _ga: src.goalsAgainst,
      _pts: src.points,
    };
  });
  if (mode !== 'total') rows.sort((a, b) => b._pts - a._pts || b._gf - b._ga - (a._gf - a._ga) || b._gf - a._gf);
  rows.forEach((r, i) => (r._rank = mode === 'total' ? r.rank : i + 1));

  const rankChart = chartBox(300);
  const series = d.teams.map((t) => ({
    key: t.key,
    name: shortName(t.name),
    points: d.tableByRound.map((r) => {
      const s = r.standings.find((x) => x.key === t.key);
      return { x: r.round, y: s ? s.rank : null };
    }).filter((p) => p.y !== null),
  }));
  const drawRank = () =>
    lineChart(rankChart, {
      series,
      height: 300,
      invertY: true,
      highlight: state.highlightTeam ?? d.teams[0].key,
      yMin: 1,
      yMax: d.teams.length,
      yTicks: [1, 3, 6, 9, d.teams.length],
      xLabel: (v) => `${v}.`,
      tip: (s) => `<b>${s.name}</b><br>Klicken zum Hervorheben`,
      onPick: (key) => {
        state.highlightTeam = key;
        drawRank();
      },
    });
  drawRank();

  const form5 = d.form.last5;

  return h(
    'div',
    { class: 'stack' },
    pageHead(
      'Rangliste',
      'Tabelle & Form',
      'Aus den Resultaten neu berechnet und Platz für Platz gegen die offizielle Rangliste geprüft.',
      h(
        'div',
        { class: 'chips' },
        [
          ['total', 'Gesamt'],
          ['home', 'Heim'],
          ['away', 'Auswärts'],
        ].map(([k, label]) =>
          h(
            'button',
            {
              class: 'chip',
              'aria-pressed': String(mode === k),
              onclick: () => {
                state.tableMode = k;
                render();
              },
            },
            label,
          ),
        ),
      ),
    ),

    card(
      mode === 'total' ? 'Rangliste' : mode === 'home' ? 'Heimtabelle' : 'Auswärtstabelle',
      'Klick auf eine Zeile öffnet das Teamprofil',
      dataTable(
        [
          { label: '#', cell: (t) => h('span', { class: 'rank' }, t._rank) },
          { label: 'Team', left: true, cell: (t) => teamCell(t.name) },
          { label: 'Sp', cell: (t) => t._played },
          { label: 'S', cell: (t) => t._wins },
          { label: 'U', cell: (t) => t._draws },
          { label: 'N', cell: (t) => t._losses },
          { label: 'Tore', cell: (t) => `${t._gf}:${t._ga}` },
          { label: 'Diff', cell: (t) => signed(t._gf - t._ga) },
          { label: 'Pkt', strong: true, cell: (t) => t._pts },
          { label: 'Strafp.', title: 'Strafpunkte des Verbands – bei Punktgleichheit entscheidet der Quotient', cell: (t) => t.penaltyPoints ?? '–' },
          { label: 'PpS', title: 'Punkte pro Spiel', cell: (t) => num(t._played ? t._pts / t._played : 0, 2) },
          { label: 'Elo', title: 'Elo-Wertung nach dem letzten Spiel', cell: (t) => d.elo.current[t.key] ?? '–' },
          { label: 'Form', left: true, cell: (t) => formRun(t.form5) },
        ],
        rows,
        { onRow: (t) => showTeam(t.key), lineBelow: (t) => mode === 'total' && t.lineBelow },
      ),
      mode === 'total' && d.officialNote
        ? h('p', { class: 'card__note' }, `Rangfolge bei Punktgleichheit: ${d.officialNote}`)
        : null,
    ),

    h(
      'div',
      { class: 'grid grid--2' },
      card(
        'In-Form-Tabelle',
        'Nur die letzten fünf Spiele jedes Teams',
        dataTable(
          [
            { label: '#', cell: (t) => h('span', { class: 'rank' }, t.rank) },
            { label: 'Team', left: true, cell: (t) => t.name },
            { label: 'Sp', cell: (t) => t.played },
            { label: 'Tore', cell: (t) => `${t.goalsFor}:${t.goalsAgainst}` },
            { label: 'Pkt', strong: true, cell: (t) => t.points },
            { label: 'Saisonrang', cell: (t) => teamByKey(t.key)?.rank ?? '–' },
            {
              label: 'Δ',
              title: 'Differenz zwischen Formrang und Saisonrang',
              cell: (t) => {
                const delta = (teamByKey(t.key)?.rank ?? 0) - t.rank;
                return h('span', { class: delta > 0 ? 'pos' : delta < 0 ? 'neg' : 'muted' }, delta === 0 ? '0' : signed(delta));
              },
            },
            { label: 'Form', left: true, cell: (t) => formRun(t.form) },
          ],
          form5,
          { onRow: (t) => showTeam(t.key) },
        ),
      ),
      card(
        'Positionsverlauf',
        'Rang nach jeder Runde · Linie anklicken zum Hervorheben',
        legend([{ name: 'hervorgehobenes Team', color: 'var(--series-1)' }, { name: 'übrige Teams', color: 'var(--line-strong)' }], 'line'),
        rankChart,
        h('p', { class: 'card__note' }, 'Rang 1 oben. Die Werte stehen ebenso in der Rangliste-Tabelle oben.'),
      ),
    ),
  );
}

function viewSpieler() {
  const d = state.data;
  const f = state.playerFilter;
  const groups = ['Tor', 'Abwehr', 'Mittelfeld', 'Angriff'];

  let rows = d.players.filter(
    (p) =>
      p.apps >= f.minApps &&
      (f.team === 'all' || p.teamKey === f.team) &&
      (f.group === 'all' || p.positionGroup === f.group) &&
      (!f.q || p.name.toLowerCase().includes(f.q.toLowerCase())),
  );
  rows = rows.sort((a, b) => ((a[f.sort] ?? 0) - (b[f.sort] ?? 0)) * f.dir || b.apps - a.apps);

  const onSort = (key) => {
    if (f.sort === key) f.dir *= -1;
    else {
      f.sort = key;
      f.dir = -1;
    }
    render();
  };

  return h(
    'div',
    { class: 'stack' },
    pageHead(
      'Einsätze · Tore · Karten',
      'Spieler',
      `${d.players.length} Spielerinnen und Spieler aus ${d.league.coverage.lineups} Spielberichten. Der Verband publiziert davon nur die Torschützenliste.`,
    ),
    h(
      'div',
      { class: 'filters' },
      h('input', {
        type: 'search',
        placeholder: 'Name suchen …',
        value: f.q,
        oninput: (e) => {
          f.q = e.target.value;
          render({ keepFocus: 'search' });
        },
      }),
      h(
        'select',
        {
          'aria-label': 'Team filtern',
          onchange: (e) => {
            f.team = e.target.value;
            render();
          },
        },
        h('option', { value: 'all', selected: f.team === 'all' }, 'Alle Teams'),
        d.teams.map((t) => h('option', { value: t.key, selected: f.team === t.key }, t.name)),
      ),
      h(
        'div',
        { class: 'chips' },
        [['all', 'Alle Positionen'], ...groups.map((g) => [g, g])].map(([k, label]) =>
          h(
            'button',
            {
              class: 'chip',
              'aria-pressed': String(f.group === k),
              onclick: () => {
                f.group = k;
                render();
              },
            },
            label,
          ),
        ),
      ),
      h(
        'label',
        { class: 'chips', style: 'gap:6px;color:var(--ink-3);font-size:12.5px' },
        'ab',
        h('input', {
          type: 'number',
          min: 0,
          max: 30,
          value: f.minApps,
          style: 'width:58px;font:inherit;padding:5px 8px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface);color:var(--ink)',
          oninput: (e) => {
            f.minApps = Number(e.target.value) || 0;
            render();
          },
        }),
        'Einsätzen',
      ),
    ),

    card(
      `${rows.length} Spieler`,
      'Spaltentitel anklicken zum Sortieren · Zeile öffnet das Spielerprofil',
      dataTable(
        [
          { label: 'Spieler', left: true, cell: (p) => p.name },
          { label: 'Team', left: true, cell: (p) => h('span', { class: 'muted' }, shortName(p.team ?? '')) },
          { label: 'Position', left: true, cell: (p) => h('span', { class: 'muted' }, p.positionGroup) },
          { label: 'Sp', sortKey: 'apps', title: 'Einsätze', cell: (p) => p.apps },
          { label: 'Start', sortKey: 'starts', cell: (p) => p.starts },
          { label: 'Ein', sortKey: 'subOn', title: 'Einwechslungen', cell: (p) => p.subOn },
          { label: 'Bank', sortKey: 'benchUnused', title: 'Im Kader ohne Einsatz', cell: (p) => p.benchUnused },
          { label: 'Tore', sortKey: 'goals', strong: true, cell: (p) => p.goals },
          { label: '11m', sortKey: 'penaltyGoals', title: 'Tore per Elfmeter', cell: (p) => p.penaltyGoals || '' },
          { label: 'T/Sp', sortKey: 'goalsPerApp', title: 'Tore pro Einsatz', cell: (p) => num(p.goalsPerApp, 2) },
          { label: 'G', sortKey: 'yellow', title: 'Gelbe Karten', cell: (p) => p.yellow || '' },
          { label: 'GR', sortKey: 'secondYellow', title: 'Gelb-Rot', cell: (p) => p.secondYellow || '' },
          { label: 'R', sortKey: 'red', title: 'Rote Karten', cell: (p) => p.red || '' },
          {
            label: 'Quote',
            sortKey: 'squadShare',
            title: 'Anteil der Teamspiele mit Einsatz',
            cell: (p) => pct((p.squadShare ?? 0) * 100, 0),
          },
        ],
        rows,
        { onRow: (p) => showPlayer(p.key), sort: { key: f.sort, dir: f.dir }, onSort },
      ),
    ),
  );
}

function viewTeams() {
  const d = state.data;
  return h(
    'div',
    { class: 'stack' },
    pageHead('Mannschaften', 'Teams', 'Kaderbreite, Torverteilung und Formkurve je Mannschaft. Klick öffnet das vollständige Profil.'),
    h(
      'div',
      { class: 'grid grid--2' },
      d.teams.map((t) => {
        const elo = d.elo.history[t.key] ?? [];
        const box = h('div', { style: 'margin-top:10px' });
        columnChart(box, {
          data: Object.keys(t.goalsForByBucket).map((k) => ({
            label: k,
            values: [t.goalsForByBucket[k], t.goalsAgainstByBucket[k]],
          })),
          series: [
            { name: 'erzielt', color: 'var(--series-1)' },
            { name: 'kassiert', color: 'var(--series-2)' },
          ],
          height: 150,
        });
        return h(
          'section',
          { class: 'card', style: 'cursor:pointer', onclick: () => showTeam(t.key) },
          h(
            'div',
            { class: 'card__head' },
            h('h2', {}, h('span', { class: 'muted' }, `${t.rank}. `), t.name),
            h('span', { class: 'card__sub' }, `${t.points} Pkt · ${t.goalsFor}:${t.goalsAgainst}`),
          ),
          h(
            'div',
            { class: 'row-between' },
            formRun(t.form5),
            h(
              'span',
              { class: 'row-between', style: 'gap:8px' },
              h('span', { class: 'muted', style: 'font-size:12px' }, `Elo ${d.elo.current[t.key] ?? '–'}`),
              sparkline(elo.map((e) => e.rating)),
            ),
          ),
          statRow([
            ['Eingesetzt', t.playersUsed, `${t.squadSize} im Aufgebot`],
            ['Zu Null', t.cleanSheets, `${t.failedToScore}× ohne Tor`],
            ['Pkt/Spiel', num(t.ppg, 2), `${signed(t.pointsOverExpected, 1)} vs. Erw.`],
            ['Top-Scorer', t.topScorer ? t.topScorer.goals : '–', t.topScorer ? `${t.topScorer.name}` : null],
          ]),
          legend([
            { name: 'erzielt', color: 'var(--series-1)' },
            { name: 'kassiert', color: 'var(--series-2)' },
          ]),
          box,
        );
      }),
    ),
  );
}

function viewSpiele() {
  const d = state.data;
  const f = state.matchFilter;
  const rounds = [...new Set(d.matches.map((m) => m.round))].sort((a, b) => a - b);
  const rows = d.matches.filter(
    (m) =>
      (f.team === 'all' || m.homeKey === f.team || m.awayKey === f.team) &&
      (f.round === 'all' || m.round === Number(f.round)),
  );

  return h(
    'div',
    { class: 'stack' },
    pageHead('Spielplan', 'Spiele', 'Alle Begegnungen mit Torfolge, Karten und beiden Aufstellungen.'),
    h(
      'div',
      { class: 'filters' },
      h(
        'select',
        {
          'aria-label': 'Team filtern',
          onchange: (e) => {
            f.team = e.target.value;
            render();
          },
        },
        h('option', { value: 'all', selected: f.team === 'all' }, 'Alle Teams'),
        d.teams.map((t) => h('option', { value: t.key, selected: f.team === t.key }, t.name)),
      ),
      h(
        'select',
        {
          'aria-label': 'Runde filtern',
          onchange: (e) => {
            f.round = e.target.value;
            render();
          },
        },
        h('option', { value: 'all', selected: f.round === 'all' }, 'Alle Runden'),
        rounds.map((r) => h('option', { value: r, selected: String(f.round) === String(r) }, `Runde ${r}`)),
      ),
    ),
    card(
      `${rows.length} Spiele`,
      'Zeile öffnet den Spielbericht',
      dataTable(
        [
          { label: 'Rd', cell: (m) => m.round },
          { label: 'Datum', left: true, cell: (m) => formatDate(m.date) },
          { label: 'Zeit', cell: (m) => m.time ?? '–' },
          { label: 'Heim', left: true, cell: (m) => m.home.name },
          { label: 'Resultat', strong: true, cell: (m) => (m.played ? `${m.score.home}:${m.score.away}` : '–:–') },
          { label: 'Gast', left: true, cell: (m) => m.away.name },
          { label: 'Halbzeit', cell: (m) => (m.halftime ? `${m.halftime.home}:${m.halftime.away}` : '–') },
          { label: 'Bericht', cell: (m) => (m.lineups ? 'Aufstellung' : m.hasReport ? 'Torfolge' : '–') },
        ],
        rows,
        { onRow: (m) => showMatch(m.id) },
      ),
    ),
  );
}

function viewAnalyse() {
  const d = state.data;

  const eloBox = chartBox(300);
  const eloSeries = d.teams.map((t) => ({
    key: t.key,
    name: shortName(t.name),
    points: (d.elo.history[t.key] ?? []).map((e, i) => ({ x: i + 1, y: e.rating })),
  }));
  const drawElo = () =>
    lineChart(eloBox, {
      series: eloSeries,
      height: 300,
      highlight: state.highlightTeam ?? d.teams[0].key,
      xLabel: (v) => `${v}.`,
      tip: (s) => `<b>${s.name}</b><br>Klicken zum Hervorheben`,
      onPick: (key) => {
        state.highlightTeam = key;
        drawElo();
      },
    });
  drawElo();

  const overBox = chartBox(200);
  divergingBars(overBox, {
    rows: [...d.teams]
      .sort((a, b) => b.pointsOverExpected - a.pointsOverExpected)
      .map((t) => ({
        label: shortName(t.name),
        value: t.pointsOverExpected,
        tip: `${t.points} Punkte · erwartet ${num(t.expectedPoints, 1)}`,
      })),
    formatValue: (v) => signed(v, 1),
  });

  const stateBox = chartBox(200);
  stackedRows(stateBox, {
    rows: [...d.teams]
      .sort((a, b) => b.stateMinutes.leading - a.stateMinutes.leading)
      .map((t) => ({
        label: shortName(t.name),
        values: [t.stateMinutes.leading, t.stateMinutes.level, t.stateMinutes.trailing],
      })),
    segments: [
      { name: 'in Führung', color: 'var(--series-1)' },
      { name: 'ausgeglichen', color: 'var(--line-strong)' },
      { name: 'im Rückstand', color: 'var(--bad)' },
    ],
    formatValue: (v) => `${fmt.format(v)} Min.`,
  });

  return h(
    'div',
    { class: 'stack' },
    pageHead('Advanced Stats', 'Analyse', 'Kennzahlen, die es im offiziellen Matchcenter nicht gibt – alle aus den Spieltelegrammen abgeleitet.'),

    h(
      'div',
      { class: 'grid grid--2' },
      card(
        'Elo-Verlauf',
        'Startwert 1500, Heimvorteil 55, Gewichtung nach Tordifferenz',
        legend([{ name: 'hervorgehobenes Team', color: 'var(--series-1)' }, { name: 'übrige Teams', color: 'var(--line-strong)' }], 'line'),
        eloBox,
      ),
      card(
        'Punkte über Erwartung',
        'Ist-Punkte minus Pythagoras-Erwartung aus Toren',
        overBox,
        h('p', { class: 'card__note' }, 'Positiv = mehr Punkte geholt, als die Tordifferenz hergibt (enge Siege, starke Schlussphasen).'),
      ),
    ),

    h(
      'div',
      { class: 'grid grid--2' },
      card(
        'Minuten nach Spielstand',
        'Aus den Torzeiten rekonstruiert, 90 Minuten pro Spiel',
        legend([
          { name: 'in Führung', color: 'var(--series-1)' },
          { name: 'ausgeglichen', color: 'var(--line-strong)' },
          { name: 'im Rückstand', color: 'var(--bad)' },
        ]),
        stateBox,
      ),
      card(
        'Führung, Comeback, Disziplin',
        'Alle Werte aus den Spieltelegrammen',
        dataTable(
          [
            { label: 'Team', left: true, cell: (t) => t.name },
            { label: '1:0', title: 'Spiele mit dem ersten Tor', cell: (t) => t.firstGoalFor },
            { label: 'Pkt danach', title: 'Punkte in Spielen mit dem ersten Tor', cell: (t) => t.pointsAfterFirstGoal },
            { label: 'Comeback', title: 'Punkte aus Spielen mit Rückstand', cell: (t) => t.comebackPoints },
            { label: 'Verspielt', title: 'Punkte, die nach einer Führung liegen blieben', cell: (t) => t.pointsDropped },
            { label: 'G', cell: (t) => t.cards.yellow },
            { label: 'GR', cell: (t) => t.cards.secondYellow },
            { label: 'R', cell: (t) => t.cards.red },
            {
              label: 'Strafpunkte',
              title: 'Offizieller Wert des Verbands (inkl. nachträglicher Sanktionen)',
              strong: true,
              cell: (t) => t.penaltyPoints ?? '–',
            },
          ],
          [...d.teams].sort((a, b) => b.comebackPoints - a.comebackPoints),
          { onRow: (t) => showTeam(t.key) },
        ),
      ),
    ),

    card(
      'Kader und Rotation',
      'Wie breit die Teams aufgestellt sind',
      dataTable(
        [
          { label: 'Team', left: true, cell: (t) => t.name },
          { label: 'Spieler im Kader', cell: (t) => t.squadSize },
          { label: 'eingesetzt', cell: (t) => t.playersUsed },
          { label: 'Ø Einsätze', title: 'Durchschnittliche Einsätze pro eingesetztem Spieler', cell: (t) => num(avgApps(t), 1) },
          { label: 'Bester Torschütze', left: true, cell: (t) => (t.topScorer ? `${t.topScorer.name} (${t.topScorer.goals})` : '–') },
          { label: 'Anteil Teamtore', cell: (t) => pct(t.topScorerShare) },
          { label: 'Zu Null', cell: (t) => t.cleanSheets },
          { label: 'Ohne eigenes Tor', cell: (t) => t.failedToScore },
        ],
        d.teams,
        { onRow: (t) => showTeam(t.key) },
      ),
    ),
  );
}

const avgApps = (t) => {
  const ps = playersOf(t.key).filter((p) => p.apps > 0);
  return ps.length ? ps.reduce((a, p) => a + p.apps, 0) / ps.length : 0;
};

function viewDaten() {
  const d = state.data;
  const v = d.verification;
  const ok = v.filter((x) => x.match).length;

  return h(
    'div',
    { class: 'stack' },
    pageHead('Herkunft & Kontrolle', 'Daten & Qualität', 'Woher die Zahlen kommen und wie genau sie mit der offiziellen Rangliste übereinstimmen.'),
    h(
      'div',
      { class: 'grid grid--tiles' },
      tile('Spiele mit Bericht', `${d.league.coverage.reports}/${d.league.matchesPlayed}`, pct(d.league.coverage.reportPct)),
      tile('Spiele mit Aufstellung', `${d.league.coverage.lineups}/${d.league.matchesPlayed}`, pct(d.league.coverage.lineupPct)),
      tile('Tabellen-Abgleich', `${ok}/${v.length}`, 'Teams mit identischen Punkten und Toren'),
      tile('Stand der Daten', formatDate((d.meta.collectedAt ?? '').slice(0, 10), false), new Date(d.meta.collectedAt).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })),
    ),
    card(
      'Abgleich mit der offiziellen Rangliste',
      'Eigene Berechnung gegen matchcenter-Rangliste',
      dataTable(
        [
          { label: 'Rang off./ber.', cell: (r) => `${r.officialRank} / ${r.computedRank ?? '–'}` },
          { label: 'Team', left: true, cell: (r) => r.team },
          { label: 'Punkte offiziell', cell: (r) => r.officialPoints },
          { label: 'Punkte berechnet', cell: (r) => r.computedPoints ?? '–' },
          { label: 'Tore offiziell', cell: (r) => r.officialGoals },
          { label: 'Tore berechnet', cell: (r) => r.computedGoals ?? '–' },
          { label: 'Strafp. offiziell', cell: (r) => r.officialPenaltyPoints ?? '–' },
          { label: 'aus Karten', title: 'Nur die im Telegramm erfassten Karten: gelb 1, gelb-rot 3, rot 5', cell: (r) => r.computedCardPoints ?? '–' },
          {
            label: 'Status',
            left: true,
            cell: (r) =>
              h('span', { class: r.match ? 'pos' : 'neg' }, r.match ? '✓ identisch' : '✗ Abweichung'),
          },
        ],
        v,
      ),
      h(
        'p',
        { class: 'card__note' },
        'Die offiziellen Strafpunkte liegen über den aus den Telegrammen berechneten, weil sie auch nachträgliche Sanktionen enthalten. Sie werden deshalb aus der Verbandsrangliste übernommen und nicht selbst gerechnet.',
      ),
    ),
    card(
      'Offizielle Torschützenliste',
      'Zum Vergleich, wie sie der Verband publiziert',
      d.officialScorers.length
        ? dataTable(
            [
              { label: 'Tore', strong: true, cell: (r) => r.goals },
              { label: 'Spieler', left: true, cell: (r) => r.name },
              { label: 'Verein', left: true, cell: (r) => r.club },
            ],
            d.officialScorers.slice(0, 25),
          )
        : h('p', { class: 'muted' }, 'Für diese Liga führt der Verband keine Torschützenliste.'),
    ),
    card(
      'Quelle',
      null,
      h(
        'p',
        { class: 'muted', style: 'margin:0' },
        'Primärquelle: ',
        h('a', { href: d.meta.sourceUrl, target: '_blank', rel: 'noreferrer' }, d.meta.sourceUrl),
        h('br'),
        `Erhoben ${new Date(d.meta.collectedAt).toLocaleString('de-CH')} · aufbereitet ${new Date(d.meta.builtAt).toLocaleString('de-CH')}.`,
      ),
    ),
  );
}

/* ------------------------------------------------------------------ details */

function showTeam(key) {
  const d = state.data;
  const t = teamByKey(key);
  if (!t) return;
  const squad = playersOf(key).sort((a, b) => b.apps - a.apps || b.goals - a.goals);
  const rounds = [...new Set(d.matches.map((m) => m.round))].sort((a, b) => a - b);

  // Einsatz-Raster: Spieler x Runde
  const heat = h(
    'table',
    { class: 'heat' },
    h(
      'thead',
      {},
      h('tr', {}, h('th', {}, ''), rounds.map((r) => h('th', { style: 'text-align:center;padding:0 0 4px' }, r % 2 ? r : ''))),
    ),
    h(
      'tbody',
      {},
      squad
        .filter((p) => p.apps + p.benchUnused > 0)
        .slice(0, 26)
        .map((p) =>
          h(
            'tr',
            {},
            h('th', {}, p.name),
            rounds.map((r) => {
              const log = p.matchLog.find((l) => l.round === r);
              const cls = log ? (log.role === 'start' ? 'cell--start' : log.role === 'sub' ? 'cell--sub' : 'cell--bench') : '';
              const label = log
                ? { start: 'Startelf', sub: 'eingewechselt', bench: 'Bank ohne Einsatz' }[log.role]
                : 'nicht im Aufgebot';
              return h('td', {}, h('div', {
                class: `cell ${cls}`,
                title: `${p.name} · Runde ${r}: ${label}${log?.goals ? ` · ${log.goals} Tor(e)` : ''}`,
              }));
            }),
          ),
        ),
    ),
  );

  const goalBox = chartBox(170);
  columnChart(goalBox, {
    data: Object.keys(t.goalsForByBucket).map((k) => ({
      label: k,
      values: [t.goalsForByBucket[k], t.goalsAgainstByBucket[k]],
    })),
    series: [
      { name: 'erzielt', color: 'var(--series-1)' },
      { name: 'kassiert', color: 'var(--series-2)' },
    ],
    height: 170,
  });

  openDrawer(
    t.name,
    `Rang ${t.rank} · ${t.points} Punkte · ${t.goalsFor}:${t.goalsAgainst} Tore · Elo ${d.elo.current[t.key] ?? '–'}`,
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'grid grid--tiles' },
        tile('Punkte pro Spiel', num(t.ppg, 2)),
        tile('Über Erwartung', signed(t.pointsOverExpected, 1), `erwartet ${num(t.expectedPoints, 1)}`),
        tile('Längste Siegesserie', t.streaks.longestWins),
        tile('Ungeschlagen (max.)', t.streaks.longestUnbeaten),
        tile('Zu Null', t.cleanSheets),
        tile('Strafpunkte', t.cardPoints, `${t.cards.yellow}G · ${t.cards.secondYellow}GR · ${t.cards.red}R`),
      ),
      card(
        'Tore nach Spielminute',
        null,
        legend([
          { name: 'erzielt', color: 'var(--series-1)' },
          { name: 'kassiert', color: 'var(--series-2)' },
        ]),
        goalBox,
      ),
      card(
        'Einsätze pro Runde',
        'Startelf, Einwechslung, Bank',
        legend([
          { name: 'Startelf', color: 'var(--seq-450)' },
          { name: 'eingewechselt', color: 'var(--seq-250)' },
          { name: 'Bank ohne Einsatz', color: 'var(--surface-sunk)' },
        ]),
        h('div', { class: 'table-wrap' }, heat),
      ),
      card(
        'Kader',
        `${t.playersUsed} eingesetzte Spieler`,
        dataTable(
          [
            { label: 'Spieler', left: true, cell: (p) => p.name },
            { label: 'Pos', left: true, cell: (p) => h('span', { class: 'muted' }, p.positionGroup) },
            { label: 'Sp', cell: (p) => p.apps },
            { label: 'Start', cell: (p) => p.starts },
            { label: 'Ein', cell: (p) => p.subOn },
            { label: 'Bank', cell: (p) => p.benchUnused },
            { label: 'Tore', strong: true, cell: (p) => p.goals },
            { label: 'G/GR/R', cell: (p) => `${p.yellow}/${p.secondYellow}/${p.red}` },
          ],
          squad,
          { onRow: (p) => showPlayer(p.key) },
        ),
      ),
      card(
        'Resultate',
        null,
        dataTable(
          [
            { label: 'Rd', cell: (r) => r.round },
            { label: 'Datum', left: true, cell: (r) => formatDate(r.date, false) },
            { label: 'Ort', left: true, cell: (r) => (r.side === 'home' ? 'Heim' : 'Auswärts') },
            { label: 'Gegner', left: true, cell: (r) => r.opponent },
            { label: 'Resultat', strong: true, cell: (r) => `${r.gf}:${r.ga}` },
            { label: '', left: true, cell: (r) => formRun(r.outcome) },
          ],
          t.results,
          { onRow: (r) => showMatch(r.matchId) },
        ),
      ),
    ),
  );
}

function showPlayer(key) {
  const p = state.data.players.find((x) => x.key === key);
  if (!p) return;
  const box = chartBox(150);
  columnChart(box, {
    data: Object.entries(p.goalsByBucket).map(([label, v]) => ({ label, values: [v] })),
    series: [{ name: 'Tore', color: 'var(--series-1)' }],
    height: 150,
    labelValues: true,
  });

  openDrawer(
    p.name,
    `${p.team ?? ''} · ${p.mainPosition ?? p.positionGroup}${p.number ? ` · Nr. ${p.number}` : ''}`,
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'grid grid--tiles' },
        tile('Einsätze', p.apps, `${p.starts} × Startelf, ${p.subOn} × eingewechselt`),
        tile('Tore', p.goals, p.penaltyGoals ? `davon ${p.penaltyGoals} per Elfmeter` : null),
        tile('Tore pro Einsatz', num(p.goalsPerApp, 2)),
        tile('Bank ohne Einsatz', p.benchUnused),
        tile('Karten', `${p.yellow}/${p.secondYellow}/${p.red}`, 'gelb / gelb-rot / rot'),
        tile('Einsatzquote', pct((p.squadShare ?? 0) * 100, 0), 'Anteil der Teamspiele'),
        p.minutesKnown > 0
          ? tile('Erfasste Spielzeit', `${fmt.format(p.minutes)}′`, `aus ${p.minutesKnown} Spielen mit Wechseldaten`)
          : null,
      ),
      p.goals > 0 && card('Tore nach Spielminute', null, box),
      card(
        'Spiele',
        'Rolle, Tore und Karten je Partie',
        dataTable(
          [
            { label: 'Rd', cell: (l) => l.round },
            { label: 'Datum', left: true, cell: (l) => formatDate(l.date, false) },
            { label: 'Gegner', left: true, cell: (l) => l.opponent },
            { label: 'Resultat', cell: (l) => (l.score ? `${l.score.home}:${l.score.away}` : '–') },
            {
              label: 'Rolle',
              left: true,
              cell: (l) => ({ start: 'Startelf', sub: 'eingewechselt', bench: 'Bank' })[l.role] ?? l.role,
            },
            { label: 'Tore', strong: true, cell: (l) => l.goals || '' },
            { label: 'Karten', left: true, cell: (l) => l.cards.map((c) => ({ yellow: 'G', secondYellow: 'GR', red: 'R' })[c]).join(' ') },
          ],
          [...p.matchLog].sort((a, b) => (a.round ?? 0) - (b.round ?? 0)),
          { onRow: (l) => showMatch(l.matchId) },
        ),
      ),
    ),
  );
}

function showMatch(id) {
  const m = state.data.matches.find((x) => x.id === id);
  if (!m) return;

  const evLabel = {
    goal: 'Tor',
    yellow: 'Gelb',
    secondYellow: 'Gelb-Rot',
    red: 'Rot',
    substitution: 'Wechsel',
  };

  const timeline = h(
    'ul',
    { class: 'timeline' },
    m.events.map((e) =>
      h(
        'li',
        {},
        h('span', { class: 'min' }, e.minuteRaw ?? (e.minute !== null ? `${e.minute}'` : '')),
        h(
          'span',
          { class: `ev ${e.side === 'away' ? 'away' : ''}` },
          h('span', { class: `badge badge--${e.type}` }, evLabel[e.type] ?? e.type),
          h(
            'span',
            {},
            e.type === 'substitution'
              ? `${e.off ?? '?'} → ${e.on ?? '?'}`
              : `${e.player ?? '–'}${e.penalty ? ' (Elfmeter)' : ''}${e.ownGoal ? ' (Eigentor)' : ''}`,
            e.runningScore ? h('span', { class: 'muted' }, ` · ${e.runningScore.home}:${e.runningScore.away}`) : null,
          ),
        ),
      ),
    ),
  );

  const lineupCol = (side, label) => {
    const l = m.lineups?.[side];
    if (!l) return h('div', { class: 'muted' }, 'Keine Aufstellung erfasst.');
    const list = (arr, title) =>
      arr.length
        ? h(
            'div',
            { style: 'margin-bottom:12px' },
            h('h4', { style: 'font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3);margin-bottom:5px' }, title),
            h(
              'ul',
              { style: 'list-style:none;margin:0;padding:0;font-size:13.5px' },
              arr.map((p) =>
                h(
                  'li',
                  { style: 'display:flex;gap:8px;padding:2px 0' },
                  h('span', { class: 'muted num', style: 'width:22px;text-align:right' }, p.number ?? ''),
                  h('span', {}, p.name, p.captain ? h('span', { class: 'muted' }, ' (C)') : null),
                  p.position ? h('span', { class: 'muted', style: 'margin-left:auto;font-size:11.5px' }, p.position) : null,
                ),
              ),
            ),
          )
        : null;
    return h(
      'div',
      {},
      h('h3', { style: 'font-size:14px;margin-bottom:10px' }, label),
      list(l.starters, 'Startelf'),
      list(l.bench.filter((p) => p.appeared), 'Eingewechselt'),
      list(l.bench.filter((p) => !p.appeared), 'Bank ohne Einsatz'),
      list(l.coaches, 'Trainer'),
    );
  };

  openDrawer(
    `${m.home.name} – ${m.away.name}`,
    `Runde ${m.round} · ${formatDate(m.date)} ${m.time ?? ''} · ${m.venue ?? ''}`,
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'hero', style: 'justify-content:center;text-align:center' },
        h('div', { class: 'hero__figure' }, m.played ? `${m.score.home} : ${m.score.away}` : '–:–'),
        m.halftime && h('div', { class: 'muted' }, `Halbzeit ${m.halftime.home}:${m.halftime.away}`),
      ),
      m.events.length ? card('Torfolge und Karten', null, timeline) : null,
      card('Aufstellungen', null, h('div', { class: 'grid grid--2' }, lineupCol('home', m.home.name), lineupCol('away', m.away.name))),
    ),
  );
}

/* ------------------------------------------------------------------ render */

const VIEWS = {
  uebersicht: viewUebersicht,
  turnierbaum: viewTurnierbaum,
  runden: viewRunden,
  tabelle: viewTabelle,
  spieler: viewSpieler,
  teams: viewTeams,
  spiele: viewSpiele,
  analyse: viewAnalyse,
  daten: viewDaten,
};

function renderTabs() {
  const nav = document.getElementById('tabs');
  nav.replaceChildren(
    ...tabs().map(([k, label]) =>
      h(
        'button',
        {
          class: 'tab',
          'aria-current': String(state.view === k),
          onclick: () => {
            location.hash = `#/${k}`;
          },
        },
        label,
      ),
    ),
  );
}

function render(opts = {}) {
  hideTip();
  renderTabs();
  const root = document.getElementById('view');
  const fn = VIEWS[state.view] ?? viewUebersicht;
  root.replaceChildren(fn());
  if (opts.keepFocus === 'search') {
    const input = root.querySelector('input[type=search]');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
  const note = document.getElementById('data-note');
  const d = state.data;
  note.textContent = `${d.meta.association} · ${d.meta.league ?? ''} ${d.meta.group ?? ''} · Saison ${d.meta.seasonLabel} · Datenstand ${new Date(d.meta.collectedAt).toLocaleString('de-CH')}`;
}

/* -------------------------------------------------------------------- boot */

/**
 * Daten holen. Im Einzeldatei-Build (`node src/cli.js bundle`) liegen sie
 * bereits als globales Objekt vor, dann faellt kein Netzwerkzugriff an.
 */
async function loadJson(path) {
  const bundled = globalThis.__RASENDATEN__;
  if (bundled && bundled[path]) return bundled[path];
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Datei ${path} fehlt`);
  return res.json();
}

async function loadCompetition(key) {
  state.data = await loadJson(`data/${key}.json`);
  state.key = key;
  state.highlightTeam = state.data.teams[0]?.key ?? null;
  state.playerFilter.team = 'all';
  state.matchFilter = { team: 'all', round: 'all' };
}

function applyHash() {
  const view = (location.hash.replace(/^#\//, '') || 'uebersicht').split('/')[0];
  const allowed = tabs().map(([k]) => k);
  state.view = allowed.includes(view) ? view : 'uebersicht';
}

function initTheme() {
  const stored = localStorage.getItem('rasendaten-theme');
  const theme = stored ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = theme;
  const btn = document.getElementById('theme-toggle');
  const paint = () => {
    btn.querySelector('[data-theme-icon]').textContent =
      document.documentElement.dataset.theme === 'dark' ? '☀' : '☾';
  };
  paint();
  btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('rasendaten-theme', next);
    paint();
    render();
  });
}

async function boot() {
  initTheme();
  try {
    const index = await loadJson('data/index.json');
    state.index = index;
    const select = document.getElementById('competition-select');
    select.replaceChildren(
      ...index.competitions.map((c) =>
        h('option', { value: c.key }, `${c.association} · ${c.league ?? c.label} ${c.group ?? ''} · ${c.seasonLabel}`),
      ),
    );
    select.addEventListener('change', async () => {
      await loadCompetition(select.value);
      applyHash();
      render();
    });

    await loadCompetition(index.competitions[0].key);
    applyHash();
    render();
    addEventListener('hashchange', () => {
      applyHash();
      render();
      document.getElementById('view').focus({ preventScroll: true });
      scrollTo({ top: 0 });
    });
  } catch (err) {
    document.getElementById('view').replaceChildren(
      h(
        'div',
        { class: 'card' },
        h('h2', {}, 'Keine Daten gefunden'),
        h('p', { class: 'muted' }, String(err.message)),
        h('p', { class: 'muted' }, 'Zuerst `node src/cli.js crawl` ausführen, danach `node src/cli.js serve`.'),
      ),
    );
  }
}

boot();
