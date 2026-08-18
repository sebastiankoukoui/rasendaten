import path from 'node:path';
import { MatchcenterSession } from './lib/session.js';
import { leagueUrl, groupUrl, seasonLabel } from './lib/urls.js';
import { ROOT, readJson } from './lib/io.js';

const CACHE_DIR = path.join(ROOT, 'data', 'cache');

/**
 * Bestandsaufnahme: welche Gruppen hat eine Liga, wie viele Mannschaften
 * stehen drin, wie viele Spiele ergibt das - und was kostet das Einlesen.
 *
 * Gedacht als Planungshilfe, bevor man Ligen in config/targets.json aufnimmt.
 */
export async function survey({ leagues, season, log = console.log } = {}) {
  const cfg = readJson(path.join(ROOT, 'config', 'targets.json'));
  const s = season ?? Math.max(...cfg.targets.map((t) => t.season));

  const session = new MatchcenterSession({
    origin: cfg.origin,
    delayMs: cfg.throttleMs ?? 1500,
    cacheDir: CACHE_DIR,
    log: () => {},
  });

  const rows = [];
  try {
    await session.open();
    for (const leagueId of leagues) {
      const index = await session.parse(
        'parseGroupIndex',
        leagueUrl({ orgId: cfg.orgId, lang: cfg.lang, season: s, leagueId }),
        null,
        { force: true },
      );
      log(`\n${index.league ?? leagueId} (ln=${leagueId}) - ${index.groups.length} Gruppen`);

      for (const g of index.groups) {
        const ranking = await session.parse(
          'parseRanking',
          groupUrl({
            orgId: cfg.orgId,
            lang: cfg.lang,
            season: s,
            leagueId,
            stageId: g.stageId,
            groupId: g.groupId,
            view: 'ranking',
          }),
          null,
          { force: true },
        );
        const teams = ranking.length;
        // Doppelrunde: jede Mannschaft zweimal gegen jede andere.
        const matches = teams > 1 ? teams * (teams - 1) : 0;
        rows.push({
          league: index.league ?? String(leagueId),
          leagueId,
          group: g.name,
          stageId: g.stageId,
          groupId: g.groupId,
          teams,
          matches,
        });
        log(`  ${g.name.padEnd(42)} ${String(teams).padStart(2)} Teams  ${String(matches).padStart(3)} Spiele`);
      }
    }
  } finally {
    await session.close();
  }

  // Aufwand: je Gruppe drei Uebersichtsseiten, je gespieltes Spiel ein
  // Telegramm. Mit Gegner-Check zusaetzlich zwei Seiten je Mannschaft.
  const groups = rows.length;
  const teams = rows.reduce((a, r) => a + r.teams, 0);
  const matches = rows.reduce((a, r) => a + r.matches, 0);
  const pagesBase = groups * 3 + matches;
  const pagesScouting = teams * 2 + Math.round(teams * 4);
  const perPage = (cfg.throttleMs ?? 1500) / 1000 + 0.7;

  log(`\n${'='.repeat(64)}`);
  log(`Saison ${seasonLabel(s)}: ${groups} Gruppen, ${teams} Mannschaften, ${matches} Spiele`);
  log(`\nEinmaliges Vollerfassen (ganze Saison, alle Spielberichte)`);
  log(`  Seitenaufrufe   ${pagesBase}`);
  log(`  Dauer           ${(pagesBase * perPage / 60).toFixed(0)} Minuten bei ${perPage.toFixed(1)}s je Seite`);
  // Gemessen am bestehenden Cache: rund 24 KB je Seite nach gzip.
  log(`  Roh-HTML        ~${Math.round((pagesBase * 24) / 1024)} MB im Cache (gzip)`);
  log(`  Auslieferung    ~${Math.round((matches * 16) / 1024)} MB JSON, aufgeteilt auf ${groups} Dateien`);
  log(`\nZusaetzlich mit Gegner-Check fuer alle Mannschaften`);
  log(`  Seitenaufrufe   ~${pagesScouting} (Vereinsseite + Team-Spielplan + Testspiel-Berichte)`);
  log(`\nLaufender Betrieb nach einem Spielwochenende`);
  log(`  Seitenaufrufe   ~${groups * 3 + Math.round(matches / 18)} (Uebersichten neu, Telegramme nur fuer neue Resultate)`);
  log(`  Dauer           ~${(((groups * 3 + matches / 18) * perPage) / 60).toFixed(0)} Minuten`);

  return rows;
}
