import path from 'node:path';
import { ROOT, writeJson } from './lib/io.js';

const OUT_DIR = path.join(ROOT, 'web', 'data');

export const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * Verzeichnisse über alle Wettbewerbe hinweg: Vereine, Mannschaften, Spieler.
 *
 * Das Matchcenter denkt in Wettbewerben - ein Verein existiert dort nur als
 * Seite mit einer Mannschaftsliste, eine Spielersuche gibt es gar nicht.
 * Für ein Portal über mehrere Ligen braucht es die Gegenrichtung: vom Verein
 * oder vom Namen aus in die Daten hinein.
 */

/** Gemeinsamer Namensteil mehrerer Mannschaften: "FC Aegeri 1|2" -> "FC Aegeri". */
function commonClubName(names) {
  if (!names.length) return null;
  if (names.length === 1) return names[0];
  const parts = names.map((n) => n.split(/\s+/));
  const out = [];
  for (let i = 0; i < parts[0].length; i++) {
    const token = parts[0][i];
    if (parts.every((p) => p[i] === token)) out.push(token);
    else break;
  }
  // Ein reiner Rechtsform-Prefix ("FC") wäre kein Vereinsname.
  if (out.length < 2 && names[0].split(/\s+/).length > 1) return names[0];
  return out.join(' ') || names[0];
}

/** Mannschaftsbezeichnungen der Vereinsseite in Rubriken einsortieren. */
export function teamCategory(label) {
  const l = String(label ?? '').toLowerCase();
  if (/juniorinnen|ff-\d/.test(l)) return 'Juniorinnen';
  if (/junioren|youth league|kinderfussball/.test(l)) return 'Junioren';
  if (/senior/.test(l)) return 'Senioren';
  if (/frauen|damen/.test(l)) return 'Frauen';
  if (/liga|promotion|league/.test(l)) return 'Aktive';
  return 'Weitere';
}

export function buildRegistries(builtAll) {
  const clubs = {};
  const players = {};

  for (const built of builtAll) {
    const meta = built.meta;
    const compRef = {
      key: meta.key,
      label: meta.label,
      league: meta.league,
      group: meta.group,
      seasonLabel: meta.seasonLabel,
      type: meta.type,
    };

    // ---- Vereine ------------------------------------------------------
    for (const dos of built.dossiers ?? []) {
      if (!dos.clubPageId) continue;
      const key = `v${dos.clubPageId}`;
      if (!clubs[key]) {
        clubs[key] = {
          key,
          clubPageId: dos.clubPageId,
          clubNumber: dos.clubNumber ?? null,
          name: null,
          _names: [],
          teams: [],
          entries: [],
        };
      }
      const club = clubs[key];
      if (!club.clubNumber && dos.clubNumber) club.clubNumber = dos.clubNumber;
      club._names.push(dos.team);

      // Mannschaften laut Vereinsseite - auch die, für die wir keine Daten haben.
      for (const t of dos.clubTeams ?? []) {
        if (club.teams.some((x) => x.teamId === t.teamId)) continue;
        club.teams.push({
          teamId: t.teamId,
          label: t.label,
          category: teamCategory(t.label),
          orgId: t.orgId ?? null,
        });
      }

      // Mannschaften, zu denen wir tatsächlich Daten haben.
      const row = built.teams.find((x) => x.name === dos.team);
      club.entries.push({
        team: dos.team,
        teamKey: slug(dos.team),
        teamId: dos.teamId ?? null,
        competition: compRef,
        rank: row?.played ? row.rank : null,
        played: row?.played ?? 0,
      });
    }

    // ---- Spieler ------------------------------------------------------
    for (const pl of built.players) {
      if (!pl.apps && !pl.goals) continue;
      const key = pl.personId ? `p${pl.personId}` : `n${slug(pl.name)}`;
      if (!players[key]) {
        players[key] = {
          key,
          personId: pl.personId ?? null,
          name: pl.name,
          teams: [],
          apps: 0,
          goals: 0,
          yellow: 0,
          red: 0,
        };
      }
      const p = players[key];
      p.apps += pl.apps;
      p.goals += pl.goals;
      p.yellow += pl.yellow;
      p.red += pl.red + pl.secondYellow;
      if (pl.positionGroup && pl.positionGroup !== 'unbekannt') p.position = pl.positionGroup;
      p.teams.push({
        team: pl.team,
        competitionKey: meta.key,
        competitionLabel: [meta.league ?? meta.label, meta.group].filter(Boolean).join(' '),
        seasonLabel: meta.seasonLabel,
        playerKey: pl.key,
        apps: pl.apps,
        goals: pl.goals,
      });
    }
  }

  for (const club of Object.values(clubs)) {
    club.name = commonClubName([...new Set(club._names)]);
    delete club._names;
    club.teams.sort(
      (a, b) =>
        ['Aktive', 'Frauen', 'Junioren', 'Juniorinnen', 'Senioren', 'Weitere'].indexOf(a.category) -
          ['Aktive', 'Frauen', 'Junioren', 'Juniorinnen', 'Senioren', 'Weitere'].indexOf(b.category) ||
        a.label.localeCompare(b.label),
    );
  }

  writeJson(path.join(OUT_DIR, 'clubs.json'), { clubs, builtAt: new Date().toISOString() }, { pretty: false });
  writeJson(
    path.join(OUT_DIR, 'players.json'),
    { players: Object.values(players).sort((a, b) => b.goals - a.goals || b.apps - a.apps), builtAt: new Date().toISOString() },
    { pretty: false },
  );

  return { clubs: Object.keys(clubs).length, players: Object.keys(players).length };
}
