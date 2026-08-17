/**
 * URL builder for the SFV portal system.
 *
 * All regional associations run the same ASP.NET application on their own
 * host; `oid` selects the association, everything else is identical:
 *
 *   oid  organisation   1 SFV, 2 SFL, 3 EL/PL, 4 AL/LA, 5 AFV, 7 IFV, ...
 *   lng  language       1 de, 2 fr, 3 it
 *   s    season         2026 == season 2025/2026
 *   ln   league         e.g. 13029 = 3. Liga
 *   ls   stage          "Staffel" inside a league (main round, play-off, ...)
 *   sg   group          the actual table/group
 *   cp   cup competition
 *   tg   telegram       one match report
 *   v    club page
 *   a    view           see VIEWS below
 */

export const VIEWS = {
  ranking: 'mrr', // Resultate + Rangliste
  scorers: 'mtg', // Torschuetzenliste (Gruppe)
  schedule: 'msp', // Spielplan
  upcoming: 'mag', // Naechste Runden
  reschedule: 'mna', // Neuansetzungen
  penalties: 'mst', // Strafen
  info: 'msi', // Info
  groups: 'mgr', // Gruppenuebersicht
  leagueScorers: 'mts', // Torschuetzenliste (ganze Liga)
};

export const ASSOCIATIONS = {
  1: { code: 'SFV', origin: 'https://matchcenter.football.ch' },
  2: { code: 'SFL', origin: 'https://matchcenter-sfl.football.ch' },
  3: { code: 'EL-PL', origin: 'https://matchcenter.el-pl.ch' },
  4: { code: 'AL-LA', origin: 'https://matchcenter.al-la.ch' },
  5: { code: 'AFV', origin: 'https://matchcenter.afv.ch' },
  6: { code: 'FVBJ', origin: 'https://matchcenter.fvbj.ch' },
  7: { code: 'IFV', origin: 'https://matchcenter.ifv.ch' },
  8: { code: 'FVNWS', origin: 'https://matchcenter.fvnws.ch' },
  9: { code: 'OFV', origin: 'https://matchcenter.ofv.ch' },
  10: { code: 'FVRZ', origin: 'https://matchcenter.fvrz.ch' },
  11: { code: 'AFF-FFV', origin: 'https://matchcenter.aff-ffv.ch' },
  12: { code: 'AVF-WFV', origin: 'https://matchcenter.avf-wfv.ch' },
  13: { code: 'ACGF', origin: 'https://matchcenter.acgf.ch' },
  14: { code: 'AVFN', origin: 'https://matchcenter.avfn.ch' },
  15: { code: 'ANF', origin: 'https://matchcenter.anf.ch' },
  16: { code: 'ACVF', origin: 'https://matchcenter.acvf.ch' },
  17: { code: 'AVFV', origin: 'https://matchcenter.football-valais.ch' },
  18: { code: 'FTC', origin: 'https://matchcenter.football.ch' },
};

const q = (params) =>
  Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

export function leagueUrl({ orgId, lang = 1, season, leagueId }) {
  return `/default.aspx?${q({ oid: orgId, lng: lang, s: season, ln: leagueId })}`;
}

export function groupUrl({ orgId, lang = 1, season, leagueId, stageId, groupId, view }) {
  return `/default.aspx?${q({
    oid: orgId,
    lng: lang,
    s: season,
    ln: leagueId,
    ls: stageId,
    sg: groupId,
    a: VIEWS[view] ?? view,
  })}`;
}

export function cupUrl({ orgId, lang = 1, season, cupId }) {
  return `/default.aspx?${q({ oid: orgId, lng: lang, s: season, cp: cupId })}`;
}

export function telegramUrl({ orgId, lang = 1, telegramId }) {
  return `/default.aspx?${q({ oid: orgId, lng: lang, ln: '', v: 0, tg: telegramId })}`;
}

export function clubUrl({ orgId, lang = 1, clubPageId }) {
  return `/default.aspx?${q({ oid: orgId, lng: lang, v: clubPageId })}`;
}

/** 2026 -> "2025/26" */
export function seasonLabel(season) {
  return `${season - 1}/${String(season).slice(2)}`;
}
