import fs from 'node:fs';
import path from 'node:path';
import { MatchcenterSession } from './lib/session.js';
import { groupUrl, cupUrl, telegramUrl, seasonLabel } from './lib/urls.js';
import { ROOT, readJson, writeJson } from './lib/io.js';

const RAW_DIR = path.join(ROOT, 'data', 'raw');
const CACHE_DIR = path.join(ROOT, 'data', 'cache');

/**
 * Decide which match reports need to be (re-)read.
 * A telegram is re-read when the fixture list shows a result we have not
 * stored yet, when the stored report disagrees with the fixture list, or when
 * the report was collected before the line-ups had been entered.
 */
function telegramsToFetch(matches, previous, { force = false } = {}) {
  const have = previous?.telegrams ?? {};
  const todo = [];
  for (const m of matches) {
    if (!m.telegramId || !m.played) continue;
    const old = have[m.telegramId];
    if (force || !old) {
      todo.push({ match: m, reason: old ? 'force' : 'neu' });
      continue;
    }
    const scoreChanged =
      !old.score || old.score.home !== m.homeGoals || old.score.away !== m.awayGoals;
    if (scoreChanged) todo.push({ match: m, reason: 'Resultat geaendert' });
    else if (!old.lineups) todo.push({ match: m, reason: 'Aufstellung fehlte' });
  }
  return todo;
}

async function collectLeague(session, target, cfg, opts, log) {
  const base = {
    orgId: cfg.orgId,
    lang: cfg.lang ?? 1,
    season: target.season,
    leagueId: target.leagueId,
    stageId: target.stageId,
    groupId: target.groupId,
  };

  log(`  Spielplan ...`);
  const scheduleUrl = groupUrl({ ...base, view: 'schedule' });
  const matches = await session.parse('parseSchedule', scheduleUrl, null, { force: true });
  const index = await session.parse('parseGroupIndex', scheduleUrl);

  log(`  Rangliste ...`);
  const rankingUrl = groupUrl({ ...base, view: 'ranking' });
  const ranking = await session.parse('parseRanking', rankingUrl, null, { force: true });
  const rankingNote = await session.parse('parseRankingNote', rankingUrl);

  log(`  Torschuetzenliste ...`);
  let officialScorers = [];
  try {
    officialScorers = await session.parse(
      'parseScorers',
      groupUrl({ ...base, view: 'scorers' }),
      null,
      { force: true },
    );
  } catch (err) {
    log(`  (keine Torschuetzenliste: ${err.message})`);
  }

  const previous = readJson(path.join(RAW_DIR, `${target.key}.json`));
  const telegrams = { ...(previous?.telegrams ?? {}) };
  const todo = telegramsToFetch(matches, previous, opts);
  log(`  ${matches.length} Spiele, ${todo.length} Telegramme zu lesen`);

  let done = 0;
  for (const { match, reason } of todo) {
    const url = telegramUrl({ orgId: cfg.orgId, lang: cfg.lang, telegramId: match.telegramId });
    try {
      const tg = await session.parse('parseTelegram', url, match.telegramId, { force: true });
      if (tg) telegrams[match.telegramId] = tg;
      done++;
      if (done % 10 === 0 || done === todo.length) {
        log(`    ${done}/${todo.length} Telegramme (${reason})`);
      }
    } catch (err) {
      log(`    ! Telegramm ${match.telegramId}: ${err.message}`);
    }
  }

  const groupMeta = (index.groups ?? []).find((g) => g.groupId === target.groupId);
  return {
    key: target.key,
    type: 'league',
    label: target.label,
    association: target.association ?? cfg.association,
    orgId: cfg.orgId,
    season: target.season,
    seasonLabel: seasonLabel(target.season),
    league: index.league ?? null,
    group: groupMeta?.name ?? null,
    ids: { leagueId: target.leagueId, stageId: target.stageId, groupId: target.groupId },
    siblingGroups: index.groups ?? [],
    sourceUrl: cfg.origin + groupUrl({ ...base, view: 'ranking' }),
    collectedAt: new Date().toISOString(),
    matches,
    ranking,
    rankingNote,
    officialScorers,
    telegrams,
  };
}

async function collectCup(session, target, cfg, opts, log) {
  const url = cupUrl({
    orgId: cfg.orgId,
    lang: cfg.lang ?? 1,
    season: target.season,
    cupId: target.cupId,
  });
  log(`  Cup-Tableau ...`);
  const rounds = await session.parse('parseCup', url, null, { force: true });
  const matches = rounds.flatMap((r) => r.matches.map((m) => ({ ...m, section: r.round })));

  const previous = readJson(path.join(RAW_DIR, `${target.key}.json`));
  const telegrams = { ...(previous?.telegrams ?? {}) };
  const todo = telegramsToFetch(matches, previous, opts);
  log(`  ${matches.length} Spiele, ${todo.length} Telegramme zu lesen`);

  let done = 0;
  for (const { match } of todo) {
    const tgUrl = telegramUrl({ orgId: cfg.orgId, lang: cfg.lang, telegramId: match.telegramId });
    try {
      const tg = await session.parse('parseTelegram', tgUrl, match.telegramId, { force: true });
      if (tg) telegrams[match.telegramId] = tg;
      done++;
      if (done % 10 === 0 || done === todo.length) log(`    ${done}/${todo.length} Telegramme`);
    } catch (err) {
      log(`    ! Telegramm ${match.telegramId}: ${err.message}`);
    }
  }

  return {
    key: target.key,
    type: 'cup',
    label: target.label,
    association: target.association ?? cfg.association,
    orgId: cfg.orgId,
    season: target.season,
    seasonLabel: seasonLabel(target.season),
    ids: { cupId: target.cupId },
    sourceUrl: cfg.origin + url,
    collectedAt: new Date().toISOString(),
    rounds,
    matches,
    ranking: [],
    officialScorers: [],
    telegrams,
  };
}

export async function collect(opts = {}) {
  const log = opts.log ?? ((m) => console.log(m));
  const cfg = readJson(path.join(ROOT, 'config', 'targets.json'));
  if (!cfg) throw new Error('config/targets.json fehlt');

  const targets = cfg.targets.filter(
    (t) => t.enabled !== false && (!opts.only || opts.only.includes(t.key)),
  );
  if (!targets.length) throw new Error('Keine aktiven Targets in config/targets.json');

  fs.mkdirSync(RAW_DIR, { recursive: true });

  const session = new MatchcenterSession({
    origin: cfg.origin,
    delayMs: opts.delayMs ?? cfg.throttleMs ?? 1500,
    cacheDir: CACHE_DIR,
    preferCache: !!opts.fromCache,
    log,
  });

  const results = [];
  try {
    await session.open();
    for (const target of targets) {
      log(`\n> ${target.label} (${target.key})`);
      const data =
        target.type === 'cup'
          ? await collectCup(session, target, cfg, opts, log)
          : await collectLeague(session, target, cfg, opts, log);
      writeJson(path.join(RAW_DIR, `${target.key}.json`), data);
      results.push(data);
      log(`  gespeichert -> data/raw/${target.key}.json`);
    }
  } finally {
    await session.close();
  }

  log(
    `\nFertig. ${session.stats.fetched} Seiten geladen, ${session.stats.cached} aus Cache, ` +
      `${(session.stats.bytes / 1048576).toFixed(1)} MB.`,
  );
  return results;
}
