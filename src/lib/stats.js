/** Kleine Statistik-Helfer ohne Abhaengigkeiten. */

export const sum = (xs) => xs.reduce((a, b) => a + b, 0);
export const avg = (xs) => (xs.length ? sum(xs) / xs.length : 0);
export const round = (x, d = 2) => (x === null || x === undefined ? null : +x.toFixed(d));

export const MINUTE_BUCKETS = [
  { key: '1-15', from: 1, to: 15 },
  { key: '16-30', from: 16, to: 30 },
  { key: '31-45', from: 31, to: 45, stoppage: true },
  { key: '46-60', from: 46, to: 60 },
  { key: '61-75', from: 61, to: 75 },
  { key: '76-90', from: 76, to: 90, stoppage: true },
];

export function bucketOf(minute, stoppage = 0) {
  if (minute === null || minute === undefined) return null;
  const m = Math.min(90, minute + (stoppage > 0 ? 0 : 0));
  for (const b of MINUTE_BUCKETS) if (m >= b.from && m <= b.to) return b.key;
  return m > 90 ? '76-90' : '1-15';
}

export function emptyBuckets() {
  return Object.fromEntries(MINUTE_BUCKETS.map((b) => [b.key, 0]));
}

/**
 * Pythagoras-Erwartung: wie viele Punkte "verdient" ein Team aufgrund
 * seiner Tore? Exponent 1.3 ist der ueblich verwendete Fussball-Wert.
 */
export function pythagoreanPoints(goalsFor, goalsAgainst, played) {
  if (!played) return 0;
  const gf = Math.max(goalsFor, 0.1) ** 1.3;
  const ga = Math.max(goalsAgainst, 0.1) ** 1.3;
  const winShare = gf / (gf + ga);
  // 3-Punkte-System: Erwartungswert ueber Sieg-/Remis-Anteil approximiert.
  const drawShare = 0.26 * (1 - Math.abs(winShare - 0.5) * 2) + 0.08;
  const w = Math.max(0, winShare - drawShare / 2);
  const d = drawShare;
  return played * (w * 3 + d);
}

/** Elo mit Heimvorteil und Tordifferenz-Gewichtung. */
export function eloUpdate(ratingHome, ratingAway, goalsHome, goalsAway, opts = {}) {
  const k = opts.k ?? 24;
  const homeAdv = opts.homeAdvantage ?? 55;
  const expHome = 1 / (1 + 10 ** ((ratingAway - (ratingHome + homeAdv)) / 400));
  const scoreHome = goalsHome > goalsAway ? 1 : goalsHome === goalsAway ? 0.5 : 0;
  const margin = Math.abs(goalsHome - goalsAway);
  const mult = margin <= 1 ? 1 : margin === 2 ? 1.5 : (11 + margin) / 8;
  const delta = k * mult * (scoreHome - expHome);
  return { home: ratingHome + delta, away: ratingAway - delta, delta, expHome };
}

/** Laengste Serie, fuer die `pred` zutrifft. */
export function longestStreak(items, pred) {
  let best = 0;
  let cur = 0;
  let bestEnd = -1;
  items.forEach((it, i) => {
    if (pred(it)) {
      cur++;
      if (cur > best) {
        best = cur;
        bestEnd = i;
      }
    } else cur = 0;
  });
  return { length: best, endIndex: bestEnd };
}

export function currentStreak(items, pred) {
  let n = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (pred(items[i])) n++;
    else break;
  }
  return n;
}
