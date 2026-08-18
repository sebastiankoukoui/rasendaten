/*
 * SFV Matchcenter parsers.
 *
 * This file is NOT a Node module. It is injected verbatim into a real browser
 * page (same origin as the matchcenter) and registers `window.SFV`.
 * Reason: the matchcenter runs behind a Cloudflare bot filter, so every request
 * has to originate from a genuine browser session anyway - and once we are in
 * there, the browser's own DOM parser is the most faithful way to read the
 * ASP.NET markup.
 */
(function () {
  'use strict';

  const SFV = {};

  // ---------------------------------------------------------------- helpers

  const txt = (el) =>
    el ? el.textContent.replace(/ /g, ' ').replace(/\s+/g, ' ').trim() : '';

  const int = (v) => {
    if (v === null || v === undefined) return null;
    const m = String(v).match(/-?\d+/);
    return m ? parseInt(m[0], 10) : null;
  };

  const qp = (href, key) => {
    if (!href) return null;
    const m = href.match(new RegExp('[?&]' + key + '=([^&#]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  };

  const iconOf = (img) =>
    img ? (img.getAttribute('src') || '').split('/').pop().toLowerCase() : null;

  const isoDate = (ddmmyyyy) => {
    const m = String(ddmmyyyy).match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (!m) return null;
    return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  };

  // "90'+2'" -> { minute: 90, stoppage: 2, sort: 90.02 }
  const parseMinute = (raw) => {
    if (!raw) return { minute: null, stoppage: 0, raw: null, sort: null };
    const m = String(raw).match(/(\d+)'?(?:\s*\+\s*(\d+))?/);
    if (!m) return { minute: null, stoppage: 0, raw, sort: null };
    const minute = parseInt(m[1], 10);
    const stoppage = m[2] ? parseInt(m[2], 10) : 0;
    return { minute, stoppage, raw: String(raw).trim(), sort: minute + stoppage / 100 };
  };

  const parseDoc = (html) => new DOMParser().parseFromString(html, 'text/html');
  SFV.parseDoc = parseDoc;

  // ------------------------------------------------------------ group index
  //
  // Every league page carries the list of its "Staffeln"/groups in a
  // ul.list-group with one li per group (label + dropdown of views).

  SFV.parseGroupIndex = function (html) {
    const d = parseDoc(html);
    const out = { league: null, leagueId: null, season: null, groups: [] };

    const title = d.querySelector('.nisGruppenTitel a');
    if (title) {
      out.league = txt(title);
      out.leagueId = int(qp(title.getAttribute('href'), 'ln'));
      out.season = int(qp(title.getAttribute('href'), 's'));
    }

    const seen = new Set();
    d.querySelectorAll('li .dropdown > a:first-child[href*="sg="]').forEach((a) => {
      const href = a.getAttribute('href');
      const ls = int(qp(href, 'ls'));
      const sg = int(qp(href, 'sg'));
      const key = ls + '/' + sg;
      if (!sg || seen.has(key)) return;
      seen.add(key);
      out.groups.push({
        name: txt(a),
        stageId: ls,
        groupId: sg,
        leagueId: out.leagueId ?? int(qp(href, 'ln')),
        season: out.season ?? int(qp(href, 's')),
      });
    });
    return out;
  };

  // --------------------------------------------------------------- schedule
  //
  // a=msp - full fixture list of a group, grouped by date headers.

  /**
   * Eine Spielzeile lesen. Meisterschaft und Cup benutzen zwei verschiedene
   * Markup-Varianten; die Meisterschaft hat sprechende Klassen (.teamA/.torA),
   * der Cup nur Bootstrap-Spalten.
   */
  function readMatchAnchor(a) {
    const href = a.getAttribute('href') || '';
    const telegramId = int(qp(href, 'tg'));
    const row = a.querySelector('.row.spiel') || a.querySelector('.row');
    if (!row) return null;

    let home = txt(row.querySelector('.teamA'));
    let away = txt(row.querySelector('.teamB'));
    let homeGoals = int(txt(row.querySelector('.torA')));
    let awayGoals = int(txt(row.querySelector('.torB')));
    let time = txt(row.querySelector('.time'));
    const info = txt(row.querySelector('.spielInfo'));

    if (!home) {
      // Cup-Variante: erste Spalte Zeit, dann Team-Block, dann .goals-Block.
      const cells = [...row.children];
      time = time || txt(cells[0]);

      const goalsBox = row.querySelector('.goals');
      if (goalsBox) {
        const parts = [...(goalsBox.querySelector('.row') ?? goalsBox).children].map(txt);
        homeGoals = int(parts[0]);
        awayGoals = int(parts[parts.length - 1]);
      }

      const teamWrap = cells.find(
        (c) => !c.classList.contains('goals') && c.querySelector('.row'),
      );
      const parts = teamWrap ? [...teamWrap.querySelector('.row').children].map(txt) : [];
      home = parts[0] ?? '';
      away = parts[parts.length - 1] ?? '';
    }

    if (!home || !away) {
      // Letzter Ausweg: der Titel des Links nennt beide Mannschaften.
      const m = (a.getAttribute('title') || '').match(/^Telegramm\s+(.+?)\s+-\s+(.+)$/);
      if (m) {
        home = home || m[1];
        away = away || m[2];
      }
    }

    const strip = (s) => s.replace(/\s*\((\d+\.)\)\s*$/, '').trim();
    const tier = (s) => (s.match(/\((\d+\.)\)\s*$/) || [])[1] ?? null;

    return {
      telegramId,
      matchNo: int((info.match(/Spielnummer\s*(\d+)/) || [])[1]),
      time: time || null,
      home: strip(home),
      away: strip(away),
      homeTier: tier(home),
      awayTier: tier(away),
      homeGoals,
      awayGoals,
      played: homeGoals !== null && awayGoals !== null,
      note: info.replace(/Spielnummer\s*\d+/, '').trim() || null,
    };
  }

  /** Alle Spiel-Listen einer Seite, gruppiert nach Panel-Titel. */
  function readMatchLists(d) {
    const sections = [];
    d.querySelectorAll('.nisListeRD .list-group, .nisListeRD').forEach((block) => {
      if (!block.querySelector('a[href*="tg="]')) return;
      if (block.querySelector('.list-group')) return; // Container, nicht die Liste
      const panel = block.closest('.panel, .card');
      const section = panel ? txt(panel.querySelector('.card-header, .panel-heading')) : '';
      let date = null;
      const matches = [];
      [...block.children].forEach((node) => {
        if (node.classList?.contains('sppTitel')) {
          date = isoDate(txt(node));
          return;
        }
        if (node.tagName !== 'A') return;
        const m = readMatchAnchor(node);
        if (m) matches.push(Object.assign(m, { date, section: section || null }));
      });
      if (matches.length) sections.push({ section: section || null, matches });
    });
    return sections;
  }

  SFV.parseSchedule = function (html) {
    return readMatchLists(parseDoc(html)).flatMap((s) => s.matches);
  };

  // -------------------------------------------------------------- standings
  //
  // a=mrr - the official table as the association computes it.

  SFV.parseRanking = function (html) {
    const d = parseDoc(html);
    // The page's scripts drop the `.nisRanglisteRD` class after render, so
    // find the table by its id suffix / cell classes instead.
    const table =
      d.querySelector('table[id$="tbRangliste"]') ||
      [...d.querySelectorAll('table')].find((t) => t.querySelector('td.ranCrang'));
    if (!table) return [];
    return [...table.rows]
      .filter((tr) => tr.querySelector('.ranCteam'))
      .map((tr) => {
        const link = tr.querySelector('.ranCteam a');
        return {
          rank: int(txt(tr.querySelector('.ranCrang'))),
          team: txt(tr.querySelector('.ranCteam')),
          clubPageId: link ? int(qp(link.getAttribute('href'), 'v')) : null,
          played: int(txt(tr.querySelector('.ranCsp'))),
          wins: int(txt(tr.querySelector('.ranCs'))),
          draws: int(txt(tr.querySelector('.ranCu'))),
          losses: int(txt(tr.querySelector('.ranCn'))),
          bonus: txt(tr.querySelector('.ranCstrp')) || null,
          goalsFor: int(txt(tr.querySelector('.ranCtg'))),
          goalsAgainst: int(txt(tr.querySelector('.ranCte'))),
          goalDiff: int(txt(tr.querySelector('.ranCtdf'))),
          points: int(txt(tr.querySelector('.ranCpt'))),
          remark: txt(tr.querySelector('.ranCpa')) || null,
          // Der Verband zieht unter Auf-/Abstiegsplaetzen eine farbige Linie.
          lineBelow: /border-bottom/.test(tr.className),
        };
      });
  };

  /** Fusstext unter der Rangliste (erklaert u. a. die Strafpunkte-Spalte). */
  SFV.parseRankingNote = function (html) {
    const d = parseDoc(html);
    const box = d.querySelector('[id$="lbHinweis"]');
    if (!box) return null;
    const parts = [...box.children].map(txt).filter(Boolean);
    return (parts.length ? parts.join(' ') : txt(box)) || null;
  };

  // ------------------------------------------------------- official scorers
  //
  // a=mtg - rows with an empty goal cell continue the previous goal count.

  SFV.parseScorers = function (html) {
    const d = parseDoc(html);
    const table = [...d.querySelectorAll('table')].find((t) => {
      const head = txt(t.rows[0]);
      return /^Tore/.test(head) && /Spielername/.test(head);
    });
    if (!table) return [];

    const out = [];
    let goals = null;
    [...table.rows].slice(1).forEach((tr) => {
      const cells = [...tr.cells];
      if (cells.length < 3) return;
      const g = int(txt(cells[0]));
      if (g !== null) goals = g;
      const name = txt(cells[1]);
      if (!name) return;
      out.push({ goals, name, club: txt(cells[2]) });
    });
    return out;
  };

  // --------------------------------------------------------------- telegram
  //
  // The match report: header, event timeline, both line-ups.

  function parseLineupTable(table) {
    const side = { starters: [], bench: [], coaches: [], absent: [] };
    let section = 'start';

    [...table.rows].forEach((tr) => {
      const titel = tr.querySelector('.aufTitel');
      if (titel) {
        const t = txt(titel);
        section = /Ersatz/i.test(t)
          ? 'bench'
          : /Trainer/i.test(t)
            ? 'coach'
            : /Abwesend/i.test(t)
              ? 'absent'
              : 'other';
        return;
      }

      const absent = tr.querySelector('.aufAbwesendText');
      if (absent) {
        side.absent.push({ name: txt(absent) });
        return;
      }

      const pid = tr.getAttribute('data-pid');
      if (!pid) return; // legend row ("= Kein Einsatz")

      const nameEl = tr.querySelector('.aufName');
      const captainEl = nameEl ? nameEl.querySelector('.aufCaptain') : null;
      const name = txt(nameEl).replace(/\(C\)$/, '').trim();

      if (section === 'coach') {
        side.coaches.push({ personId: int(pid), name });
        return;
      }

      const right = tr.querySelector('.right');
      const imgs = right ? [...right.querySelectorAll('img')] : [];
      const noAppearance = imgs.some((i) => i.classList.contains('aufStern'));
      const marks = imgs
        .filter((i) => !i.classList.contains('aufStern'))
        .map((i) => ({ icon: iconOf(i), minute: i.getAttribute('title') || null }));

      const entry = {
        personId: int(pid),
        roleId: int(tr.getAttribute('data-rid')),
        number: int(txt(tr.querySelector('.eventsTime'))),
        name,
        captain: !!captainEl,
        position: txt(tr.querySelector('.aufPos')) || null,
        marks,
      };

      if (section === 'bench') {
        entry.appeared = !noAppearance;
        side.bench.push(entry);
      } else {
        entry.appeared = !noAppearance;
        side.starters.push(entry);
      }
    });

    return side;
  }

  SFV.parseTelegram = function (html, telegramId) {
    const d = parseDoc(html);
    const head = d.querySelector('.telegrammHeadAllDiv');
    if (!head) return null;

    const info = txt(head.querySelector('.shortSpielort'));
    const dm = info.match(/(\d{1,2}\.\d{1,2}\.\d{4})\s+(\d{2}:\d{2})/);
    const competition = dm ? info.slice(0, info.indexOf(dm[0])).replace(/[\s-]+$/, '') : null;
    const tail = dm ? info.slice(info.indexOf(dm[0]) + dm[0].length) : '';
    const venue = tail.replace(/^[\s-]*Spielnummer:\s*\d+\s*-?\s*/, '').trim() || null;

    const homeImg = head.querySelector('.shortTeamFlagHeim img');
    const awayImg = head.querySelector('.shortTeamFlagGast img');
    const clubIdOf = (img) => {
      const m = img ? (img.getAttribute('src') || '').match(/\/Verein\/(\d+)\./i) : null;
      return m ? parseInt(m[1], 10) : null;
    };

    const score = txt(head.querySelector('.shortResults'));
    const sm = score.match(/(\d+)\s*:\s*(\d+)/);
    const htRaw = txt(head.querySelector('[id$="divToreHz"]'));
    const hm = htRaw.match(/(\d+)\s*:\s*(\d+)/);

    const match = {
      telegramId: telegramId ?? null,
      matchNo: int((info.match(/Spielnummer:\s*(\d+)/) || [])[1]),
      competition,
      date: dm ? isoDate(dm[1]) : null,
      time: dm ? dm[2] : null,
      venue,
      home: {
        name: txt(head.querySelector('.shortTeamHeim')),
        teamId: homeImg ? int(homeImg.getAttribute('data-tid')) : null,
        clubId: clubIdOf(homeImg),
        logo: homeImg ? homeImg.getAttribute('src') : null,
      },
      away: {
        name: txt(head.querySelector('.shortTeamGast')),
        teamId: awayImg ? int(awayImg.getAttribute('data-tid')) : null,
        clubId: clubIdOf(awayImg),
        logo: awayImg ? awayImg.getAttribute('src') : null,
      },
      score: sm ? { home: +sm[1], away: +sm[2] } : null,
      halftime: hm ? { home: +hm[1], away: +hm[2] } : null,
      events: [],
      lineups: null,
    };

    // ---- timeline (rendered newest first, we re-sort ascending) ----
    const items = [...d.querySelectorAll('ul.bnEventsList > li')];
    match.events = items
      .map((li) => {
        const time = parseMinute(txt(li.querySelector('time')));
        const icon = iconOf(li.querySelector('img'));
        const label = txt(li.querySelector('.eventlabel'));
        const body = txt(li.querySelector('.panel-body'));
        const detail = body.replace(label, '').trim();
        const scoreText = txt(li.querySelector('.panel-body > div'));
        const rs = scoreText.match(/(\d+)\s*:\s*(\d+)/);

        // Icon-Varianten: *bank = Karte gegen jemanden auf der Bank,
        // tor_em = Elfmeter, eigentor = Eigentor.
        const ic = icon || '';
        let type = 'other';
        if (/^tor/.test(ic) || /^eigentor/.test(ic)) type = 'goal';
        else if (/^out_in/.test(ic)) type = 'substitution';
        else if (/^gelbrot/.test(ic)) type = 'secondYellow';
        else if (/^gelb/.test(ic)) type = 'yellow';
        else if (/^rot/.test(ic)) type = 'red';

        const ev = {
          eventId: int(li.getAttribute('data-eid')),
          roleId: int(li.getAttribute('data-rid')),
          type,
          icon,
          minute: time.minute,
          stoppage: time.stoppage,
          minuteRaw: time.raw,
          label,
          detail,
        };

        if (type === 'goal') {
          ev.runningScore = rs ? { home: +rs[1], away: +rs[2] } : null;
          ev.penalty = /penalty|elfmeter/i.test(detail) || /^tor_em/.test(ic);
          ev.ownGoal = /^eigentor/.test(ic) || /eigentor|autogoal/i.test(detail);
          ev.scorer =
            (detail.match(/(?:Torsch(?:ü|u)tze|Eigentor)\s+(.+?)(?:\s*\(|$)/) || [])[1] || null;
        }
        if (type === 'substitution') {
          const m = detail.match(/^(.*?)\s+ersetzt durch\s+(.*?)$/i);
          ev.off = m ? m[1].trim() : null;
          ev.on = m ? m[2].trim() : null;
        }
        return ev;
      })
      .sort((a, b) => (a.minute ?? 0) - (b.minute ?? 0) || (a.stoppage ?? 0) - (b.stoppage ?? 0));

    // ---- line-ups ----
    // Note: the page's own scripts strip the `.aufstellung` class from the
    // table once rendered, so identify the tables by their content instead.
    const wrap = d.querySelector('[id$="_phAufstellung"]');
    if (wrap) {
      const blocks = [...wrap.children].filter((c) => c.querySelector('.aufName'));
      const read = (block, fallbackName) => {
        const table = [...block.querySelectorAll('table')].find((t) => t.querySelector('.aufName'));
        if (!table) return null;
        const name =
          [...block.querySelectorAll('.eventsTeamName')].map(txt).find(Boolean) || fallbackName;
        return Object.assign({ team: name }, parseLineupTable(table));
      };
      if (blocks.length >= 2) {
        const home = read(blocks[0], match.home.name);
        const away = read(blocks[1], match.away.name);
        if (home && away) match.lineups = { home, away };
      }
    }

    return match;
  };

  // ------------------------------------------------------------- team views

  /**
   * a=pt - Team-Spielplan: alle Partien einer Mannschaft der laufenden Saison,
   * quer ueber Meisterschaft, Cup und Vorbereitungsspiele. Bei Gegnern aus
   * anderen Ligen steht deren Liga-Stufe in Klammern, z. B. "FC Buttikon 1 (3.)".
   */
  SFV.parseTeamSchedule = function (html) {
    const d = parseDoc(html);
    const readSide = (cell) => {
      if (!cell) return { name: '', tier: null, own: false, clubPageId: null, orgId: null };
      const link = cell.querySelector('a[href*="v="]');
      const raw = txt(cell);
      const tier = (raw.match(/\((\d+)\.\)\s*$/) || [])[1];
      return {
        name: raw.replace(/\s*\(\d+\.\)\s*$/, '').trim(),
        tier: tier ? Number(tier) : null,
        own: !!cell.querySelector('.tabMyTeam'),
        clubPageId: link ? int(qp(link.getAttribute('href'), 'v')) : null,
        orgId: link ? int(qp(link.getAttribute('href'), 'oid')) : null,
      };
    };

    return [...d.querySelectorAll('.nisListeRD .row.spiel')].map((r) => {
      const dateEl = r.querySelector('.date');
      const dateTxt = dateEl ? txt(dateEl.querySelector('span')) : '';
      const timeTxt = dateEl ? txt(dateEl).replace(dateTxt, '').trim() : '';
      const hg = int(txt(r.querySelector('.torA')));
      const ag = int(txt(r.querySelector('.torB')));
      const tgHref = r.querySelector('.telegramm-link a')?.getAttribute('href') ?? '';
      const info = txt(r.querySelector('.font-small'));
      // "Forfait", "Nullwertung", "verschoben" - steht als eigener Block ueber
      // der Spielnummer, in der Telegramm-Spalte zusaetzlich als Kuerzel.
      const status = txt(r.querySelector('.sppStatusText')) || null;
      return {
        telegramId: int(qp(tgHref, 'tg')),
        matchNo: int((info.match(/Spielnummer\s*(\d+)/) || [])[1]),
        status,
        date: isoDate(dateTxt),
        time: timeTxt || null,
        home: readSide(r.querySelector('.teamA')),
        away: readSide(r.querySelector('.teamB')),
        homeGoals: hg,
        awayGoals: ag,
        played: hg !== null && ag !== null,
      };
    });
  };

  /** Mannschaftsliste einer Vereinsseite (v=...): Label -> Team-ID. */
  SFV.parseClubTeams = function (html) {
    const d = parseDoc(html);
    const seen = new Set();
    const teams = [];
    d.querySelectorAll('a[href*="t="]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      const teamId = int(qp(href, 't'));
      if (!teamId || seen.has(teamId)) return;
      const label = txt(a);
      if (!label) return;
      seen.add(teamId);
      teams.push({
        teamId,
        label,
        orgId: int(qp(href, 'oid')),
        clubPageId: int(qp(href, 'v')),
      });
    });
    return { teams };
  };

  /** Aus der Team-Ansicht (a=trr) die Gruppe lesen, in der das Team spielt. */
  SFV.parseTeamGroup = function (html) {
    const d = parseDoc(html);
    const link = [...d.querySelectorAll('a[href*="sg="]')].find((a) => /a=trr/.test(a.getAttribute('href') || ''));
    if (!link) return null;
    const href = link.getAttribute('href');
    return { stageId: int(qp(href, 'ls')), groupId: int(qp(href, 'sg')) };
  };

  // ------------------------------------------------------------------ cup

  SFV.parseCup = function (html) {
    // Der Cup wird vom Final rueckwaerts ausgegeben - wir drehen auf die
    // sportliche Reihenfolge (1. Runde zuerst).
    return readMatchLists(parseDoc(html))
      .map((s) => ({ round: (s.section || '').replace(/\s*-\s*$/, ''), matches: s.matches }))
      .reverse();
  };

  window.SFV = SFV;
})();
