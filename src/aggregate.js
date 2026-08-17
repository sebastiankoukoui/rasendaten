import path from 'node:path';
import { ROOT, readJson, writeJson, listJson } from './lib/io.js';
import {
  MINUTE_BUCKETS,
  bucketOf,
  emptyBuckets,
  pythagoreanPoints,
  eloUpdate,
  longestStreak,
  currentStreak,
  round,
  sum,
  avg,
} from './lib/stats.js';

const RAW_DIR = path.join(ROOT, 'data', 'raw');
const OUT_DIR = path.join(ROOT, 'web', 'data');

const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const PLAYED_MIN = 90;

/** 2026 -> "2025/26" */
const seasonName = (s) => `${s - 1}/${String(s).slice(2)}`;

// ---------------------------------------------------------------- merge ---

/** Join the fixture list with the match reports into one canonical model. */
function buildMatches(raw) {
  const byId = raw.telegrams ?? {};
  const matches = raw.matches
    .map((m) => {
      const tg = m.telegramId ? byId[m.telegramId] : null;
      const home = {
        name: tg?.home?.name ?? m.home,
        teamId: tg?.home?.teamId ?? null,
        clubId: tg?.home?.clubId ?? null,
        logo: tg?.home?.logo ?? null,
      };
      const away = {
        name: tg?.away?.name ?? m.away,
        teamId: tg?.away?.teamId ?? null,
        clubId: tg?.away?.clubId ?? null,
        logo: tg?.away?.logo ?? null,
      };
      const score = m.played
        ? { home: m.homeGoals, away: m.awayGoals }
        : (tg?.score ?? null);

      return {
        id: m.telegramId ?? m.matchNo,
        telegramId: m.telegramId,
        matchNo: m.matchNo,
        date: m.date ?? tg?.date ?? null,
        time: m.time ?? tg?.time ?? null,
        venue: tg?.venue ?? null,
        section: m.section ?? null,
        note: m.note ?? null,
        home,
        away,
        score,
        halftime: tg?.halftime ?? null,
        played: !!score,
        hasReport: !!tg,
        events: normaliseEvents(tg),
        lineups: tg?.lineups ?? null,
      };
    })
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || (a.matchNo ?? 0) - (b.matchNo ?? 0));

  return matches;
}

/**
 * Give every event a side (home/away) and resolve the acting player.
 * Goals are attributed via the running score - that is the only reliable way
 * to get own goals on the correct side.
 */
function normaliseEvents(tg) {
  if (!tg) return [];
  const roleIndex = new Map();
  for (const side of ['home', 'away']) {
    const l = tg.lineups?.[side];
    if (!l) continue;
    for (const p of [...l.starters, ...l.bench]) {
      if (p.roleId) roleIndex.set(p.roleId, { side, personId: p.personId, name: p.name });
    }
  }

  // Karten gegen Bankspieler tragen eine roleId, die nicht im Aufgebot steht.
  // Dann bleibt der Kurzname in Klammern: "Verwarnung X (Rotkreuz)".
  const sideFromLabel = (label) => {
    const token = (String(label ?? '').match(/\(([^)]+)\)\s*$/) || [])[1];
    const hint = token ?? String(label ?? '').split(/\s+/).pop();
    if (!hint) return null;
    const norm = (s) => String(s ?? '').toLowerCase();
    if (norm(tg.home.name).includes(norm(hint))) return 'home';
    if (norm(tg.away.name).includes(norm(hint))) return 'away';
    return null;
  };

  let prev = { home: 0, away: 0 };
  return tg.events.map((ev) => {
    const actor = ev.roleId ? roleIndex.get(ev.roleId) : null;
    const out = {
      ...ev,
      personId: actor?.personId ?? null,
      player: actor?.name ?? ev.scorer ?? null,
      side: actor?.side ?? sideFromLabel(ev.label),
    };

    if (ev.type === 'goal') {
      let side = null;
      if (ev.runningScore) {
        side = ev.runningScore.home > prev.home ? 'home' : 'away';
        prev = ev.runningScore;
      }
      out.scoringSide = side ?? actor?.side ?? null;
      // Scorer registered on the other team -> own goal.
      out.ownGoal = ev.ownGoal || (!!actor && !!side && actor.side !== side);
      out.side = out.scoringSide;
      out.scorerSide = out.ownGoal
        ? (actor?.side ?? (out.scoringSide === 'home' ? 'away' : 'home'))
        : (actor?.side ?? out.scoringSide);
    }
    return out;
  });
}

/** Assign match days: matches are numbered per round, so a greedy fill works. */
function assignRounds(matches) {
  const rounds = [];
  const ordered = [...matches].sort((a, b) => (a.matchNo ?? 0) - (b.matchNo ?? 0));
  for (const m of ordered) {
    let target = rounds.find((r) => !r.teams.has(m.home.name) && !r.teams.has(m.away.name));
    if (!target) {
      target = { teams: new Set(), matches: [] };
      rounds.push(target);
    }
    target.teams.add(m.home.name);
    target.teams.add(m.away.name);
    target.matches.push(m);
  }
  rounds.forEach((r, i) => r.matches.forEach((m) => (m.round = i + 1)));
  return rounds.map((r, i) => ({
    round: i + 1,
    dates: [...new Set(r.matches.map((m) => m.date).filter(Boolean))].sort(),
    matches: r.matches.map((m) => m.id),
  }));
}

// ------------------------------------------------------------- standings ---

function blankRow(team) {
  return {
    ...team,
    played: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    points: 0,
    home: { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, points: 0 },
    away: { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, points: 0 },
    results: [],
  };
}

function applyMatch(row, side, gf, ga, match) {
  const bucket = row[side];
  const outcome = gf > ga ? 'W' : gf === ga ? 'D' : 'L';
  const pts = outcome === 'W' ? 3 : outcome === 'D' ? 1 : 0;
  row.played++;
  row.goalsFor += gf;
  row.goalsAgainst += ga;
  row.points += pts;
  bucket.played++;
  bucket.goalsFor += gf;
  bucket.goalsAgainst += ga;
  bucket.points += pts;
  if (outcome === 'W') {
    row.wins++;
    bucket.wins++;
  } else if (outcome === 'D') {
    row.draws++;
    bucket.draws++;
  } else {
    row.losses++;
    bucket.losses++;
  }
  row.results.push({
    matchId: match.id,
    date: match.date,
    round: match.round,
    side,
    opponent: side === 'home' ? match.away.name : match.home.name,
    gf,
    ga,
    outcome,
    points: pts,
  });
}

const byGoals = (a, b) =>
  b.goalsFor - b.goalsAgainst - (a.goalsFor - a.goalsAgainst) ||
  b.goalsFor - a.goalsFor ||
  a.name.localeCompare(b.name);

function sortTable(rows) {
  return [...rows].sort((a, b) => b.points - a.points || byGoals(a, b));
}

/**
 * Rangliste wie sie der Verband rechnet.
 *
 * Punktgleiche Teams werden nach dem Strafpunkte-Quotienten getrennt
 * (Strafpunkte geteilt durch ausgetragene Spiele, Wettspielreglement Art. 48) -
 * nicht nach Tordifferenz. Gegen die offizielle Rangliste der 3. Liga IFV
 * 2025/26 reproduziert das alle zwoelf Plaetze exakt.
 *
 * Die Strafpunkte selbst sind nicht aus den Telegrammen ableitbar (sie
 * enthalten auch nachtraegliche Sanktionen), deshalb werden sie aus der
 * offiziellen Rangliste uebernommen. Fehlen sie, faellt die Sortierung auf
 * Tordifferenz und Tore zurueck.
 */
function rankTable(rows, penaltyByTeam = null) {
  const quotient = (r) => {
    const p = penaltyByTeam?.get(r.key);
    if (!p || !p.played) return null;
    return p.points / p.played;
  };
  return [...rows].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const qa = quotient(a);
    const qb = quotient(b);
    if (qa !== null && qb !== null && qa !== qb) return qa - qb;
    return byGoals(a, b);
  });
}

function computeTeams(matches) {
  const index = new Map();
  const get = (t) => {
    const key = String(t.teamId ?? slug(t.name));
    if (!index.has(key)) {
      index.set(
        key,
        blankRow({
          key,
          teamId: t.teamId,
          clubId: t.clubId,
          name: t.name,
          logo: t.logo,
        }),
      );
    }
    const row = index.get(key);
    if (!row.logo && t.logo) row.logo = t.logo;
    if (!row.clubId && t.clubId) row.clubId = t.clubId;
    return row;
  };

  for (const m of matches) {
    const h = get(m.home);
    const a = get(m.away);
    m.homeKey = h.key;
    m.awayKey = a.key;
    if (!m.played) continue;
    applyMatch(h, 'home', m.score.home, m.score.away, m);
    applyMatch(a, 'away', m.score.away, m.score.home, m);
  }
  return index;
}

// ------------------------------------------------------------ team stats ---

/** Minutes a team spent leading / level / trailing, derived from goal times. */
function gameStateMinutes(match, side) {
  if (!match.played) return null;
  const goals = match.events
    .filter((e) => e.type === 'goal' && e.minute !== null)
    .sort((a, b) => a.minute - b.minute || a.stoppage - b.stoppage);
  const state = { leading: 0, level: 0, trailing: 0 };
  let last = 0;
  let diff = 0;
  const add = (from, to, d) => {
    const mins = Math.max(0, Math.min(PLAYED_MIN, to) - Math.min(PLAYED_MIN, from));
    if (d > 0) state.leading += mins;
    else if (d === 0) state.level += mins;
    else state.trailing += mins;
  };
  for (const g of goals) {
    add(last, g.minute, diff);
    const forUs = g.scoringSide === side;
    diff += forUs ? 1 : -1;
    last = g.minute;
  }
  add(last, PLAYED_MIN, diff);
  return state;
}

function teamAdvanced(row, matches) {
  const own = matches.filter((m) => m.played && (m.homeKey === row.key || m.awayKey === row.key));
  const chrono = [...own].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

  const goalsFor = emptyBuckets();
  const goalsAgainst = emptyBuckets();
  const state = { leading: 0, level: 0, trailing: 0 };
  let cards = { yellow: 0, secondYellow: 0, red: 0 };
  let cleanSheets = 0;
  let failedToScore = 0;
  let comebackPoints = 0;
  let pointsDropped = 0;
  let firstGoalFor = 0;
  let firstGoalAgainst = 0;
  let pointsAfterFirstGoal = 0;

  for (const m of chrono) {
    const side = m.homeKey === row.key ? 'home' : 'away';
    const gf = side === 'home' ? m.score.home : m.score.away;
    const ga = side === 'home' ? m.score.away : m.score.home;
    if (ga === 0) cleanSheets++;
    if (gf === 0) failedToScore++;

    for (const e of m.events) {
      if (e.type === 'goal' && e.minute !== null) {
        const b = bucketOf(e.minute, e.stoppage);
        if (!b) continue;
        if (e.scoringSide === side) goalsFor[b]++;
        else goalsAgainst[b]++;
      }
      if (e.side === side) {
        if (e.type === 'yellow') cards.yellow++;
        else if (e.type === 'secondYellow') cards.secondYellow++;
        else if (e.type === 'red') cards.red++;
      }
    }

    const gs = gameStateMinutes(m, side);
    if (gs) {
      state.leading += gs.leading;
      state.level += gs.level;
      state.trailing += gs.trailing;
    }

    const goals = m.events
      .filter((e) => e.type === 'goal' && e.minute !== null)
      .sort((a, b) => a.minute - b.minute);
    const pts = gf > ga ? 3 : gf === ga ? 1 : 0;
    if (goals.length) {
      const first = goals[0];
      if (first.scoringSide === side) {
        firstGoalFor++;
        pointsAfterFirstGoal += pts;
      } else firstGoalAgainst++;
      // Rueckstand aufgeholt?
      let diff = 0;
      let wasBehind = false;
      for (const g of goals) {
        diff += g.scoringSide === side ? 1 : -1;
        if (diff < 0) wasBehind = true;
      }
      if (wasBehind && pts > 0) comebackPoints += pts;
      let led = false;
      diff = 0;
      for (const g of goals) {
        diff += g.scoringSide === side ? 1 : -1;
        if (diff > 0) led = true;
      }
      if (led && pts < 3) pointsDropped += 3 - pts;
    }
  }

  const outcomes = row.results.map((r) => r.outcome);
  const last5 = row.results.slice(-5);
  const ppg = row.played ? row.points / row.played : 0;
  const expected = pythagoreanPoints(row.goalsFor, row.goalsAgainst, row.played);

  return {
    goalsForByBucket: goalsFor,
    goalsAgainstByBucket: goalsAgainst,
    stateMinutes: state,
    cards,
    cardPoints: cards.yellow + cards.secondYellow * 3 + cards.red * 5,
    cleanSheets,
    failedToScore,
    comebackPoints,
    pointsDropped,
    firstGoalFor,
    firstGoalAgainst,
    pointsAfterFirstGoal,
    ppg: round(ppg),
    form5: last5.map((r) => r.outcome).join(''),
    form5Points: sum(last5.map((r) => r.points)),
    expectedPoints: round(expected, 1),
    pointsOverExpected: round(row.points - expected, 1),
    streaks: {
      currentUnbeaten: currentStreak(outcomes, (o) => o !== 'L'),
      currentWins: currentStreak(outcomes, (o) => o === 'W'),
      currentWinless: currentStreak(outcomes, (o) => o !== 'W'),
      longestWins: longestStreak(outcomes, (o) => o === 'W').length,
      longestUnbeaten: longestStreak(outcomes, (o) => o !== 'L').length,
    },
    biggestWin: pickExtreme(row.results, (r) => (r.outcome === 'W' ? r.gf - r.ga : -99)),
    biggestLoss: pickExtreme(row.results, (r) => (r.outcome === 'L' ? r.ga - r.gf : -99)),
  };
}

function pickExtreme(results, score) {
  let best = null;
  let bestVal = -Infinity;
  for (const r of results) {
    const v = score(r);
    if (v > bestVal) {
      bestVal = v;
      best = r;
    }
  }
  return bestVal <= -99 ? null : best;
}

// ---------------------------------------------------------- player stats ---

function computePlayers(matches, teamsByKey) {
  const players = new Map();

  const get = (personId, name, teamKey) => {
    const key = personId ?? `n:${slug(name)}`;
    if (!players.has(key)) {
      players.set(key, {
        key: String(key),
        personId,
        name,
        teamKey,
        teams: new Set(),
        numbers: new Set(),
        positions: {},
        apps: 0,
        starts: 0,
        subOn: 0,
        benchUnused: 0,
        absences: 0,
        minutes: 0,
        minutesKnown: 0,
        goals: 0,
        penaltyGoals: 0,
        ownGoals: 0,
        yellow: 0,
        secondYellow: 0,
        red: 0,
        goalsByBucket: emptyBuckets(),
        matchLog: [],
      });
    }
    const p = players.get(key);
    if (teamKey) p.teams.add(teamKey);
    if (!p.teamKey && teamKey) p.teamKey = teamKey;
    return p;
  };

  for (const m of matches) {
    if (!m.lineups) continue;
    const sides = [
      ['home', m.homeKey],
      ['away', m.awayKey],
    ];

    // Substitutions give us real minutes where the league records them.
    const subs = m.events.filter((e) => e.type === 'substitution');
    const subMinuteByName = new Map();
    for (const s of subs) {
      if (s.off) subMinuteByName.set(`off:${s.off}`, s.minute);
      if (s.on) subMinuteByName.set(`on:${s.on}`, s.minute);
    }
    const hasSubData = subs.length > 0;

    for (const [side, teamKey] of sides) {
      const lineup = m.lineups[side];
      if (!lineup) continue;
      const opponent = side === 'home' ? m.away.name : m.home.name;
      const gf = m.score ? (side === 'home' ? m.score.home : m.score.away) : null;
      const ga = m.score ? (side === 'home' ? m.score.away : m.score.home) : null;

      const register = (entry, role) => {
        const p = get(entry.personId, entry.name, teamKey);
        if (entry.number) p.numbers.add(entry.number);
        if (entry.position) p.positions[entry.position] = (p.positions[entry.position] ?? 0) + 1;

        const log = {
          matchId: m.id,
          date: m.date,
          round: m.round,
          opponent,
          side,
          score: m.score,
          role,
          goals: 0,
          cards: [],
        };

        if (role === 'start' || role === 'sub') {
          p.apps++;
          if (role === 'start') p.starts++;
          else p.subOn++;
          if (hasSubData) {
            const off = subMinuteByName.get(`off:${entry.name}`);
            const on = subMinuteByName.get(`on:${entry.name}`);
            let mins = null;
            if (role === 'start') mins = off ?? PLAYED_MIN;
            else if (on !== undefined) mins = Math.max(0, (off ?? PLAYED_MIN) - on);
            if (mins !== null) {
              p.minutes += mins;
              p.minutesKnown++;
              log.minutes = mins;
            }
          }
        } else if (role === 'bench') p.benchUnused++;

        p.matchLog.push(log);
        return p;
      };

      for (const s of lineup.starters) register(s, s.appeared === false ? 'bench' : 'start');
      for (const b of lineup.bench) register(b, b.appeared ? 'sub' : 'bench');
      for (const a of lineup.absent ?? []) {
        const p = get(null, a.name, teamKey);
        p.absences++;
      }
    }

    // events -> players
    for (const e of m.events) {
      if (!e.personId && !e.player) continue;
      // Beim Eigentor zaehlt das Tor der anderen Mannschaft, der Spieler
      // gehoert aber weiterhin zu seiner eigenen.
      const actorSide = e.type === 'goal' ? (e.scorerSide ?? e.side) : e.side;
      if (!actorSide) continue;
      const teamKey = actorSide === 'home' ? m.homeKey : m.awayKey;
      const p = get(e.personId, e.player, teamKey);
      const log = p.matchLog.find((l) => l.matchId === m.id);
      if (e.type === 'goal') {
        if (e.ownGoal) {
          p.ownGoals++;
        } else {
          p.goals++;
          if (e.penalty) p.penaltyGoals++;
          const b = bucketOf(e.minute, e.stoppage);
          if (b) p.goalsByBucket[b]++;
          if (log) log.goals++;
        }
      } else if (e.type === 'yellow') {
        p.yellow++;
        log?.cards.push('yellow');
      } else if (e.type === 'secondYellow') {
        p.secondYellow++;
        log?.cards.push('secondYellow');
      } else if (e.type === 'red') {
        p.red++;
        log?.cards.push('red');
      }
    }
  }

  return [...players.values()].map((p) => {
    const positions = Object.entries(p.positions).sort((a, b) => b[1] - a[1]);
    const team = teamsByKey.get(p.teamKey);
    return {
      ...p,
      teams: undefined,
      teamKey: p.teamKey ?? null,
      team: team?.name ?? null,
      number: [...p.numbers].sort((a, b) => a - b)[0] ?? null,
      numbers: [...p.numbers].sort((a, b) => a - b),
      mainPosition: positions[0]?.[0] ?? null,
      positionGroup: dominantGroup(p.positions),
      goalsPerApp: p.apps ? round(p.goals / p.apps) : 0,
      minutesPerGoal: p.goals && p.minutes ? Math.round(p.minutes / p.goals) : null,
      squadShare: null, // filled in later, needs the team's match count
      cardPoints: p.yellow + p.secondYellow * 3 + p.red * 5,
    };
  });
}

/** Die Positionsbezeichnungen des Verbands auf vier Mannschaftsteile abbilden. */
function positionGroup(pos) {
  if (!pos) return 'unbekannt';
  const p = pos.toLowerCase();
  if (/^tor(wart|h(ü|u)ter)?$/.test(p) || p === 'tor') return 'Tor';
  if (/verteidig|libero|abwehr/.test(p)) return 'Abwehr';
  if (/sturm|spitze|fl(ü|u)gel|angriff/.test(p)) return 'Angriff';
  if (/mittelfeld/.test(p)) return 'Mittelfeld';
  return 'unbekannt';
}

/** Mannschaftsteil aus allen erfassten Positionen eines Spielers. */
function dominantGroup(positions) {
  const tally = {};
  for (const [pos, n] of Object.entries(positions)) {
    const g = positionGroup(pos);
    if (g === 'unbekannt') continue;
    tally[g] = (tally[g] ?? 0) + n;
  }
  const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : 'unbekannt';
}

// ------------------------------------------------------------- league wide --

function leagueStats(matches, teams) {
  const played = matches.filter((m) => m.played);
  // Vor dem ersten Spieltag gibt es nichts zu quotieren.
  const share = (n) => (played.length ? round((n / played.length) * 100, 1) : null);
  const goals = played.map((m) => m.score.home + m.score.away);
  const homeWins = played.filter((m) => m.score.home > m.score.away).length;
  const draws = played.filter((m) => m.score.home === m.score.away).length;
  const buckets = emptyBuckets();
  let goalEvents = 0;
  let penalties = 0;
  let ownGoals = 0;
  const cards = { yellow: 0, secondYellow: 0, red: 0 };

  for (const m of played) {
    for (const e of m.events) {
      if (e.type === 'goal') {
        goalEvents++;
        if (e.penalty) penalties++;
        if (e.ownGoal) ownGoals++;
        const b = bucketOf(e.minute, e.stoppage);
        if (b) buckets[b]++;
      } else if (cards[e.type] !== undefined) cards[e.type]++;
    }
  }

  const withReport = played.filter((m) => m.hasReport).length;
  const withLineups = played.filter((m) => m.lineups).length;

  return {
    matchesTotal: matches.length,
    matchesPlayed: played.length,
    goals: sum(goals),
    goalsPerMatch: round(avg(goals)),
    homeWinPct: share(homeWins),
    drawPct: share(draws),
    awayWinPct: share(played.length - homeWins - draws),
    bothScoredPct: share(played.filter((m) => m.score.home > 0 && m.score.away > 0).length),
    over25Pct: share(played.filter((m) => m.score.home + m.score.away > 2.5).length),
    goalsByBucket: buckets,
    goalEventsCovered: goalEvents,
    penalties,
    ownGoals,
    cards,
    coverage: {
      reports: withReport,
      lineups: withLineups,
      reportPct: share(withReport),
      lineupPct: share(withLineups),
    },
    biggestWins: [...played]
      .sort(
        (a, b) =>
          Math.abs(b.score.home - b.score.away) - Math.abs(a.score.home - a.score.away) ||
          b.score.home + b.score.away - (a.score.home + a.score.away),
      )
      .slice(0, 5)
      .map(matchBrief),
    highestScoring: [...played]
      .sort((a, b) => b.score.home + b.score.away - (a.score.home + a.score.away))
      .slice(0, 5)
      .map(matchBrief),
  };
}

const matchBrief = (m) => ({
  id: m.id,
  date: m.date,
  round: m.round,
  home: m.home.name,
  away: m.away.name,
  score: m.score,
});

// --------------------------------------------------------- table by round --

function tableByRound(matches, teams, penaltyByTeam) {
  const rounds = [...new Set(matches.map((m) => m.round).filter(Boolean))].sort((a, b) => a - b);
  const running = new Map(
    teams.map((t) => [t.key, { key: t.key, name: t.name, points: 0, goalsFor: 0, goalsAgainst: 0, played: 0 }]),
  );
  const series = [];

  for (const r of rounds) {
    for (const m of matches.filter((x) => x.round === r && x.played)) {
      const h = running.get(m.homeKey);
      const a = running.get(m.awayKey);
      if (!h || !a) continue;
      h.played++;
      a.played++;
      h.goalsFor += m.score.home;
      h.goalsAgainst += m.score.away;
      a.goalsFor += m.score.away;
      a.goalsAgainst += m.score.home;
      if (m.score.home > m.score.away) h.points += 3;
      else if (m.score.home < m.score.away) a.points += 3;
      else {
        h.points++;
        a.points++;
      }
    }
    const ranked = rankTable([...running.values()], penaltyByTeam);
    series.push({
      round: r,
      standings: ranked.map((t, i) => ({
        key: t.key,
        rank: i + 1,
        points: t.points,
        gd: t.goalsFor - t.goalsAgainst,
      })),
    });
  }
  return series;
}

// ---------------------------------------------------------------- elo ------

function eloSeries(matches, teamKeys) {
  const rating = new Map(teamKeys.map((k) => [k, 1500]));
  const history = new Map(teamKeys.map((k) => [k, []]));
  const chrono = matches
    .filter((m) => m.played)
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.matchNo - b.matchNo);

  for (const m of chrono) {
    const rh = rating.get(m.homeKey);
    const ra = rating.get(m.awayKey);
    if (rh === undefined || ra === undefined) continue;
    const next = eloUpdate(rh, ra, m.score.home, m.score.away);
    rating.set(m.homeKey, next.home);
    rating.set(m.awayKey, next.away);
    history.get(m.homeKey).push({ date: m.date, round: m.round, rating: Math.round(next.home) });
    history.get(m.awayKey).push({ date: m.date, round: m.round, rating: Math.round(next.away) });
  }
  return {
    current: Object.fromEntries([...rating].map(([k, v]) => [k, Math.round(v)])),
    history: Object.fromEntries([...history].map(([k, v]) => [k, v])),
  };
}

// -------------------------------------------------------------- form table --

function formTable(teams, n = 5) {
  return sortTable(
    teams.map((t) => {
      const last = t.results.slice(-n);
      return {
        ...t,
        points: sum(last.map((r) => r.points)),
        goalsFor: sum(last.map((r) => r.gf)),
        goalsAgainst: sum(last.map((r) => r.ga)),
        wins: last.filter((r) => r.outcome === 'W').length,
        draws: last.filter((r) => r.outcome === 'D').length,
        losses: last.filter((r) => r.outcome === 'L').length,
        played: last.length,
        form: last.map((r) => r.outcome).join(''),
      };
    }),
  ).map((t, i) => ({
    key: t.key,
    name: t.name,
    rank: i + 1,
    played: t.played,
    wins: t.wins,
    draws: t.draws,
    losses: t.losses,
    goalsFor: t.goalsFor,
    goalsAgainst: t.goalsAgainst,
    points: t.points,
    form: t.form,
  }));
}

// -------------------------------------------------------------- dossiers ---

const COMPETITION = {
  liga: 'Meisterschaft',
  cup: 'Cup',
  test: 'Vorbereitung',
  other: 'Weiteres',
};

/**
 * Wettbewerb einer Partie bestimmen. Die verlaessliche Quelle ist der
 * Telegramm-Kopf ("Meisterschaft - 4. Liga / Gruppe 2", "Cup - IFV-Cup -
 * Runde 1", "Trainingsspiele"). Fehlt der Bericht, hilft die Zugehoerigkeit
 * zum eigenen Spielplan und sonst der Nummernkreis: Vorbereitungsspiele
 * liegen bei 7xxxxx, Meisterschaftsspiele darunter.
 */
function classifyMatch(competition, match, ownFixtureIds) {
  if (match.telegramId && ownFixtureIds.has(match.telegramId)) return 'liga';
  const c = String(competition ?? '');
  if (/^Meisterschaft/i.test(c)) return 'liga';
  if (/^Cup|Cup\s*-/i.test(c)) return 'cup';
  if (/Trainings|Freundschaft|Vorbereitung/i.test(c)) return 'test';
  if (c) return 'other';
  if (match.matchNo && match.matchNo >= 700000) return 'test';
  return match.matchNo ? 'liga' : 'other';
}

/** Ein Telegramm ausserhalb des eigenen Spielplans in Match-Form bringen. */
function matchFromTelegram(tg) {
  return {
    id: tg.telegramId,
    telegramId: tg.telegramId,
    matchNo: tg.matchNo,
    date: tg.date,
    time: tg.time,
    venue: tg.venue,
    competition: tg.competition,
    home: { name: tg.home?.name, teamId: tg.home?.teamId, clubId: tg.home?.clubId },
    away: { name: tg.away?.name, teamId: tg.away?.teamId, clubId: tg.away?.clubId },
    score: tg.score,
    halftime: tg.halftime,
    played: !!tg.score,
    hasReport: true,
    events: normaliseEvents(tg),
    lineups: tg.lineups ?? null,
  };
}

function buildDossiers(raw, teamIndex) {
  if (!raw.dossiers?.length) return null;
  const tg = raw.telegrams ?? {};
  const ownFixtureIds = new Set((raw.matches ?? []).map((m) => m.telegramId).filter(Boolean));
  const prev = raw.previousSeason ?? null;

  return raw.dossiers.map((d) => {
    const teamRow = [...teamIndex.values()].find((t) => t.name === d.team);
    const rows = d.matches
      .map((m) => {
        const report = m.telegramId ? tg[m.telegramId] : null;
        const type = classifyMatch(report?.competition, m, ownFixtureIds);
        const side = m.home.own || m.home.name === d.team ? 'home' : 'away';
        const opponent = side === 'home' ? m.away : m.home;
        const gf = side === 'home' ? m.homeGoals : m.awayGoals;
        const ga = side === 'home' ? m.awayGoals : m.homeGoals;
        return {
          id: m.telegramId ?? m.matchNo,
          telegramId: m.telegramId,
          date: m.date,
          time: m.time,
          type,
          competition: report?.competition ?? COMPETITION[type],
          venue: report?.venue ?? null,
          side,
          opponent: opponent.name,
          opponentTier: opponent.tier,
          goalsFor: gf,
          goalsAgainst: ga,
          played: m.played,
          outcome: m.played ? (gf > ga ? 'W' : gf === ga ? 'D' : 'L') : null,
          hasReport: !!report,
        };
      })
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

    const played = rows.filter((r) => r.played);
    const upcoming = rows.filter((r) => !r.played);
    const tally = (list) => ({
      played: list.length,
      wins: list.filter((r) => r.outcome === 'W').length,
      draws: list.filter((r) => r.outcome === 'D').length,
      losses: list.filter((r) => r.outcome === 'L').length,
      goalsFor: sum(list.map((r) => r.goalsFor ?? 0)),
      goalsAgainst: sum(list.map((r) => r.goalsAgainst ?? 0)),
    });

    // Vorsaison: Schlussrang plus die Einzelresultate aus der damaligen Gruppe.
    const history = prev?.table?.[d.team] ?? null;
    const historyMatches = (prev?.matches ?? [])
      .filter((m) => m.home === d.team || m.away === d.team)
      .map((m) => {
        const side = m.home === d.team ? 'home' : 'away';
        const gf = side === 'home' ? m.homeGoals : m.awayGoals;
        const ga = side === 'home' ? m.awayGoals : m.homeGoals;
        return {
          date: m.date,
          side,
          opponent: side === 'home' ? m.away : m.home,
          goalsFor: gf,
          goalsAgainst: ga,
          played: m.played,
          outcome: m.played ? (gf > ga ? 'W' : gf === ga ? 'D' : 'L') : null,
          league: m.league,
          group: m.group,
        };
      })
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

    return {
      team: d.team,
      teamKey: teamRow?.key ?? null,
      teamId: d.teamId ?? null,
      clubPageId: d.clubPageId ?? null,
      matches: rows,
      upcoming: upcoming.slice(0, 5),
      form: played.slice(-5).map((r) => r.outcome).join(''),
      totals: tally(played),
      byType: Object.fromEntries(
        Object.keys(COMPETITION).map((k) => [k, tally(played.filter((r) => r.type === k))]),
      ),
      previous: history,
      previousForm: historyMatches.filter((m) => m.played).slice(-5).map((m) => m.outcome).join(''),
      previousMatches: historyMatches,
    };
  });
}

// ------------------------------------------------------------------ build --

export function buildTarget(raw) {
  const matches = buildMatches(raw);
  const rounds = assignRounds(matches);
  const teamIndex = computeTeams(matches);
  const teamList = [...teamIndex.values()];

  // Offizielle Strafpunkte je Team (nur dort erhaeltlich, nicht berechenbar).
  const penaltyByTeam = new Map();
  for (const o of raw.ranking ?? []) {
    const row = teamList.find((t) => t.name === o.team || slug(t.name) === slug(o.team));
    const points = o.bonus ? Number(String(o.bonus).replace(/[^\d]/g, '')) : null;
    if (row && Number.isFinite(points)) {
      penaltyByTeam.set(row.key, { points, played: o.played || 1 });
    }
  }

  const ranked = rankTable(teamList, penaltyByTeam);
  ranked.forEach((t, i) => (t.rank = i + 1));

  const players = computePlayers(matches, teamIndex);
  for (const p of players) {
    const team = teamIndex.get(p.teamKey);
    p.squadShare = team?.played ? round(p.apps / team.played, 2) : null;
  }

  const teams = ranked.map((t) => {
    const adv = teamAdvanced(t, matches);
    // Nur wer mindestens einmal im Aufgebot stand - die "Abwesend"-Listen
    // nennen auch Spieler, die in dieser Mannschaft nie dabei waren.
    const squad = players
      .filter((p) => p.teamKey === t.key && p.apps + p.benchUnused > 0)
      .sort((a, b) => b.apps - a.apps || b.goals - a.goals);
    const topScorer = [...squad].sort((a, b) => b.goals - a.goals)[0] ?? null;
    return {
      ...t,
      ...adv,
      goalDiff: t.goalsFor - t.goalsAgainst,
      squadSize: squad.length,
      playersUsed: squad.filter((p) => p.apps > 0).length,
      topScorer: topScorer && topScorer.goals > 0 ? { name: topScorer.name, goals: topScorer.goals } : null,
      topScorerShare:
        topScorer && t.goalsFor ? round((topScorer.goals / t.goalsFor) * 100, 1) : null,
    };
  });

  const official = raw.ranking ?? [];
  const verification = official.map((o) => {
    const mine = teams.find((t) => t.name === o.team || slug(t.name) === slug(o.team));
    const penalty = o.bonus ? Number(String(o.bonus).replace(/[^\d]/g, '')) : null;
    return {
      team: o.team,
      teamKey: mine?.key ?? null,
      officialRank: o.rank,
      computedRank: mine?.rank ?? null,
      officialPoints: o.points,
      computedPoints: mine?.points ?? null,
      officialGoals: `${o.goalsFor}:${o.goalsAgainst}`,
      computedGoals: mine ? `${mine.goalsFor}:${mine.goalsAgainst}` : null,
      match:
        !!mine &&
        mine.points === o.points &&
        mine.goalsFor === o.goalsFor &&
        mine.goalsAgainst === o.goalsAgainst,
      officialPenaltyPoints: Number.isFinite(penalty) ? penalty : null,
      computedCardPoints: mine?.cardPoints ?? null,
    };
  });

  const officialByRank = new Map((raw.ranking ?? []).map((o) => [o.rank, o]));
  for (const t of teams) {
    const p = penaltyByTeam.get(t.key);
    t.penaltyPoints = p?.points ?? null;
    t.penaltyQuotient = p?.played ? round(p.points / p.played, 3) : null;
    t.lineBelow = !!officialByRank.get(t.rank)?.lineBelow;
  }

  const teamKeys = teams.map((t) => t.key);
  const dossiers = buildDossiers(raw, teamIndex);

  // Spielberichte, die nicht zum eigenen Spielplan gehoeren (Vorbereitung,
  // Cup) - damit sich auch diese Partien im Dashboard oeffnen lassen.
  const ownIds = new Set(matches.map((m) => m.telegramId).filter(Boolean));
  const extraMatches = {};
  if (dossiers) {
    for (const [id, tg] of Object.entries(raw.telegrams ?? {})) {
      if (ownIds.has(Number(id))) continue;
      const m = matchFromTelegram(tg);
      extraMatches[m.id] = {
        ...m,
        events: m.events.map((e) => ({
          type: e.type,
          minute: e.minute,
          stoppage: e.stoppage,
          minuteRaw: e.minuteRaw,
          side: e.side,
          player: e.player,
          personId: e.personId,
          penalty: e.penalty ?? false,
          ownGoal: e.ownGoal ?? false,
          on: e.on ?? null,
          off: e.off ?? null,
          runningScore: e.runningScore ?? null,
        })),
      };
    }
  }

  // Die Saison-Bezeichnung aus den echten Spieldaten ableiten: beim Cup passt
  // der `s`-Parameter der Quelle nicht immer zum Spieljahr.
  const dates = matches.map((m) => m.date).filter(Boolean).sort();
  let seasonLabel = raw.seasonLabel;
  if (dates.length) {
    const first = new Date(dates[0] + 'T12:00:00');
    const endYear = first.getMonth() >= 6 ? first.getFullYear() + 1 : first.getFullYear();
    seasonLabel = `${endYear - 1}/${String(endYear).slice(2)}`;
  }

  return {
    meta: {
      key: raw.key,
      type: raw.type,
      label: raw.label,
      association: raw.association,
      league: raw.league,
      group: raw.group,
      season: raw.season,
      seasonLabel,
      seasonParam: raw.season,
      firstMatch: dates[0] ?? null,
      lastMatch: dates[dates.length - 1] ?? null,
      sourceUrl: raw.sourceUrl,
      collectedAt: raw.collectedAt,
      builtAt: new Date().toISOString(),
      ids: raw.ids,
    },
    league: leagueStats(matches, teams),
    verification,
    officialRanking: official,
    officialNote: raw.rankingNote ?? null,
    officialScorers: raw.officialScorers ?? [],
    teams,
    dossiers,
    extraMatches: dossiers ? extraMatches : null,
    previousSeasonLabel: raw.previousSeason ? seasonName(raw.previousSeason.season) : null,
    players: players
      .filter((p) => p.apps > 0 || p.goals > 0 || p.benchUnused > 0)
      .sort((a, b) => b.goals - a.goals || b.apps - a.apps),
    matches: matches.map((m) => ({
      ...m,
      events: m.events.map((e) => ({
        type: e.type,
        minute: e.minute,
        stoppage: e.stoppage,
        minuteRaw: e.minuteRaw,
        side: e.side,
        player: e.player,
        personId: e.personId,
        penalty: e.penalty ?? false,
        ownGoal: e.ownGoal ?? false,
        on: e.on ?? null,
        off: e.off ?? null,
        runningScore: e.runningScore ?? null,
      })),
    })),
    rounds,
    // Beim Cup zaehlt die Runde (Final, 1/2-Final, ...), nicht die Spielrunde.
    stages:
      raw.type === 'cup'
        ? (raw.rounds ?? []).map((r) => ({
            // Der Panel-Titel wiederholt den Wettbewerbsnamen - weg damit.
            name: String(r.round ?? '')
              .replace(new RegExp('\\s*-\\s*' + (raw.label ?? '').trim() + '\\s*$', 'i'), '')
              .replace(/\s*-\s*$/, '')
              .trim(),
            matchIds: r.matches.map((m) => m.telegramId ?? m.matchNo),
          }))
        : null,
    tableByRound: tableByRound(matches, teams, penaltyByTeam),
    elo: eloSeries(matches, teamKeys),
    form: { last5: formTable(teams, 5), last3: formTable(teams, 3) },
    buckets: MINUTE_BUCKETS.map((b) => b.key),
  };
}

export function buildAll() {
  const files = listJson(RAW_DIR);
  if (!files.length) {
    console.log('Keine Rohdaten in data/raw - zuerst "node src/cli.js crawl" ausfuehren.');
    return [];
  }
  const index = [];
  for (const file of files) {
    const raw = readJson(file);
    if (!raw?.matches) continue;
    const built = buildTarget(raw);
    writeJson(path.join(OUT_DIR, `${raw.key}.json`), built, { pretty: false });
    index.push({
      key: built.meta.key,
      label: built.meta.label,
      league: built.meta.league,
      group: built.meta.group,
      association: built.meta.association,
      season: built.meta.season,
      seasonLabel: built.meta.seasonLabel,
      firstMatch: built.meta.firstMatch,
      lastMatch: built.meta.lastMatch,
      type: built.meta.type,
      matches: built.league.matchesPlayed,
      teams: built.teams.length,
      players: built.players.length,
      collectedAt: built.meta.collectedAt,
    });
    console.log(
      `gebaut: ${built.meta.label} - ${built.teams.length} Teams, ` +
        `${built.league.matchesPlayed} Spiele, ${built.players.length} Spieler`,
    );
  }
  // Vollste Datensaetze zuerst - danach greift die Oberflaeche automatisch.
  index.sort((a, b) => b.matches - a.matches || String(a.key).localeCompare(String(b.key)));
  writeJson(path.join(OUT_DIR, 'index.json'), { competitions: index, builtAt: new Date().toISOString() });
  return index;
}
