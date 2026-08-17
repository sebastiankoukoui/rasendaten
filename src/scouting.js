import { groupUrl, leagueUrl, clubUrl, telegramUrl } from './lib/urls.js';

/**
 * Gegner-Dossiers.
 *
 * Zwei Quellen, die das Matchcenter getrennt haelt:
 *
 * 1. `a=pt` (Team-Spielplan) liefert pro Mannschaft ALLE Partien der laufenden
 *    Saison - Vorbereitungsspiele, Cup und Meisterschaft in einer Liste, samt
 *    Liga-Stufe des Gegners. Genau das, was man zur Vorbereitung braucht.
 *    Der Saisonparameter wird dort ignoriert, die Ansicht kennt nur "jetzt".
 *
 * 2. Fuer die Vorsaison bleibt darum nur der Weg ueber die Gruppen: die
 *    Ranglisten der Vorjahresligen absuchen, bis jede Mannschaft gefunden ist.
 *    Das ist billig (eine Seite je Gruppe) und liefert zusaetzlich Schlussrang
 *    und Bilanz.
 */

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,]/g, '')
    .trim();

/** "4. Liga - Gruppe 2" -> "4. liga" */
const leaguePrefix = (label) => norm(String(label ?? '').split(/[-–]/)[0]);

/** Die Mannschaft eines Vereins finden, die in unserer Liga spielt. */
async function resolveTeamId(session, entry, target, log) {
  const url = clubUrl({ orgId: entry.orgId ?? 7, clubPageId: entry.clubPageId });
  const club = await session.parse('parseClubTeams', url);
  const wanted = leaguePrefix(target.label);
  const candidates = club.teams.filter((t) => norm(t.label).startsWith(wanted));

  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) {
    log(`    ? ${entry.team}: keine Mannschaft mit "${wanted}" auf der Vereinsseite`);
    return null;
  }

  // Mehrere Teams derselben Liga: dasjenige nehmen, das in unserer Gruppe steht.
  for (const c of candidates) {
    const trr = `/default.aspx?oid=${c.orgId ?? entry.orgId ?? 7}&lng=1&v=${entry.clubPageId}&t=${c.teamId}&a=trr`;
    const group = await session.parse('parseTeamGroup', trr);
    if (group && group.groupId === target.groupId) return c;
  }
  return candidates[0];
}

export async function collectScouting(session, target, cfg, ranking, telegrams, log) {
  const dossiers = [];

  log(`  Gegner-Dossiers (${ranking.length} Mannschaften) ...`);
  for (const entry of ranking) {
    if (!entry.clubPageId) continue;
    const team = await resolveTeamId(session, entry, target, log);
    if (!team) {
      dossiers.push({ team: entry.team, clubPageId: entry.clubPageId, matches: [], teamId: null });
      continue;
    }
    const ptUrl =
      `/default.aspx?oid=${team.orgId ?? cfg.orgId}&lng=1&v=${entry.clubPageId}` +
      `&t=${team.teamId}&ls=${target.stageId}&sg=${target.groupId}&a=pt`;
    const matches = await session.parse('parseTeamSchedule', ptUrl, null, { force: true });
    dossiers.push({
      team: entry.team,
      clubPageId: entry.clubPageId,
      orgId: team.orgId ?? cfg.orgId,
      teamId: team.teamId,
      teamLabel: team.label,
      matches,
    });
    log(`    ${entry.team}: ${matches.length} Partien (${matches.filter((m) => m.played).length} gespielt)`);
  }

  // Telegramme aller gespielten Partien, die wir noch nicht kennen.
  const wanted = new Map();
  for (const d of dossiers) {
    for (const m of d.matches) {
      if (m.played && m.telegramId && !telegrams[m.telegramId]) wanted.set(m.telegramId, m);
    }
  }
  log(`  ${wanted.size} zusaetzliche Spielberichte`);
  let n = 0;
  for (const id of wanted.keys()) {
    try {
      const tg = await session.parse(
        'parseTelegram',
        telegramUrl({ orgId: cfg.orgId, lang: cfg.lang, telegramId: id }),
        id,
        { force: true },
      );
      if (tg) telegrams[id] = tg;
      if (++n % 10 === 0) log(`    ${n}/${wanted.size}`);
    } catch (err) {
      log(`    ! Telegramm ${id}: ${err.message}`);
    }
  }

  return dossiers;
}

/**
 * Vorsaison: die Ranglisten der angegebenen Ligen durchsuchen, bis jede
 * Mannschaft zugeordnet ist. Von den Gruppen mit Treffern zusaetzlich den
 * Spielplan holen, damit die Einzelresultate vorliegen.
 */
export async function collectPreviousSeason(session, target, cfg, teamNames, leagueIds, log) {
  const season = target.season - 1;
  const open = new Set(teamNames.map(norm));
  const found = {};
  const groupsWithHits = [];

  for (const leagueId of leagueIds) {
    if (!open.size) break;
    let index;
    try {
      index = await session.parse(
        'parseGroupIndex',
        leagueUrl({ orgId: cfg.orgId, lang: cfg.lang, season, leagueId }),
        null,
        { force: true },
      );
    } catch (err) {
      log(`    ! Liga ${leagueId}: ${err.message}`);
      continue;
    }

    for (const group of index.groups ?? []) {
      if (!open.size) break;
      const url = groupUrl({
        orgId: cfg.orgId,
        lang: cfg.lang,
        season,
        leagueId,
        stageId: group.stageId,
        groupId: group.groupId,
        view: 'ranking',
      });
      let ranking;
      try {
        ranking = await session.parse('parseRanking', url, null, { force: true });
      } catch {
        continue;
      }
      const hits = ranking.filter((r) => open.has(norm(r.team)));
      if (!hits.length) continue;

      groupsWithHits.push({ leagueId, league: index.league, group, ranking });
      for (const hit of hits) {
        open.delete(norm(hit.team));
        found[hit.team] = {
          league: index.league,
          leagueId,
          group: group.name,
          stageId: group.stageId,
          groupId: group.groupId,
          rank: hit.rank,
          played: hit.played,
          wins: hit.wins,
          draws: hit.draws,
          losses: hit.losses,
          goalsFor: hit.goalsFor,
          goalsAgainst: hit.goalsAgainst,
          points: hit.points,
          teams: ranking.length,
        };
      }
      log(`    ${index.league} / ${group.name}: ${hits.map((h) => h.team).join(', ')}`);
    }
  }

  // Einzelresultate der Vorsaison aus den Gruppen mit Treffern.
  const matches = [];
  for (const g of groupsWithHits) {
    const url = groupUrl({
      orgId: cfg.orgId,
      lang: cfg.lang,
      season,
      leagueId: g.leagueId,
      stageId: g.group.stageId,
      groupId: g.group.groupId,
      view: 'schedule',
    });
    try {
      const rows = await session.parse('parseSchedule', url, null, { force: true });
      for (const m of rows) {
        matches.push({ ...m, league: g.league, group: g.group.name });
      }
    } catch (err) {
      log(`    ! Spielplan ${g.group.name}: ${err.message}`);
    }
  }

  if (open.size) log(`    (nicht gefunden: ${[...open].join(', ')})`);
  return { season, table: found, matches };
}
