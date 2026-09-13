// Does the ranking actually predict anything? Measured on the scans already stored.
//
// THE QUESTION. Every universe scan scores each stock and the app puts the top 25 in front of the
// user as the place to look. That is only worth doing if stocks the score liked went on to beat
// the ones it did not. Nothing in the app checked. This does, using nothing but history the
// scanner has already written: each scan's scores, and each later scan's price for the same stock.
//
// WHAT IS MEASURED, per horizon (1, 2 and 3 months) and per score (combined and each component):
//   • Rank correlation (Spearman "IC") between the score on day D and the return from D to D+h,
//     across every stock scanned on both days. Above zero means higher scores went on to higher
//     returns. Averaged over every start date, with the share of start dates on which it was
//     positive — a score that works on average but only half the time is a coin with a bias.
//   • Top-fifth minus bottom-fifth return: the plain-money version of the same question.
//   • The app's own Top 25 (qualifying trend, highest combined score) against the average stock
//     in the universe and against Nifty 50 over the same dates.
//
// WHAT IT CANNOT TELL YOU, and the result says so rather than leaving it implied:
//   • Start dates are a trading day apart, so their forward windows overlap almost entirely. Sixty
//     start dates over three months are not sixty experiments; the number of NON-overlapping
//     windows is reported beside every figure, and it is small.
//   • It is one market regime. A factor that worked in three months of a rally can fail in a fall.
//   • Price return only: dividends are left out, which slightly understates high-yield stocks.
//   • A stock that left the index before the end date has no end price and drops out. Reported.
//   • A split or bonus inside a window turns into a fake crash on unadjusted prices, so any pair
//     spanning one is excluded (from the corporate actions table) and the count reported.
const { openDatabase, allAsync, closeAsync } = require('../../db/connection');

const HORIZONS = { '1M': 30, '2M': 61, '3M': 91 };
const FACTORS = ['combined_score', 'technical_score', 'fundamental_score', 'momentum_score'];
const QUALIFYING_LADDERS = new Set(['STRONG_UPTREND', 'PULLBACK']);   // same rule as the Top 25
const TOP_N = 25;
// An end scan more than this many days past the target is not the same horizon any more.
const MAX_SLIP_DAYS = 7;

const DAY = 86400000;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

// Average ranks, ties sharing the mean of the positions they span.
function ranks(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j += 1;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}

function spearman(xs, ys) {
  const n = xs.length;
  if (n < 10) return null;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}

// Close on or before a date, from an ascending [{date, close}] series.
function closeOnOrBefore(series, date) {
  let hit = null;
  for (const b of series) { if (b.date <= date) hit = b; else break; }
  return hit;
}

/**
 * The pure part, so it can be run on any score column — including a recomputed one.
 *
 *   scans   Map(scanDate -> [{ symbol, cmp, ema_ladder, <factor columns> }]), any order
 *   nifty   ascending [{ date, close }]
 *   splits  Map(symbol -> [exDate, ...]) for splits and bonuses
 */
function evaluate(scans, { nifty = [], splits = new Map(), factors = FACTORS, horizons = HORIZONS } = {}) {
  const dates = [...scans.keys()].sort();
  const out = {
    firstScan: dates[0] || null,
    lastScan: dates[dates.length - 1] || null,
    scanDays: dates.length,
    horizons: {},
  };

  for (const [label, days] of Object.entries(horizons)) {
    const perDate = [];
    let excludedSplits = 0;
    let droppedOut = 0;

    for (const start of dates) {
      const target = addDays(start, days);
      const end = dates.find((d) => d >= target);
      if (!end || daysBetween(target, end) > MAX_SLIP_DAYS) continue;

      const endPx = new Map(scans.get(end).map((r) => [r.symbol, r.cmp]));
      const pairs = [];
      for (const r of scans.get(start)) {
        const p0 = Number(r.cmp);
        if (!(p0 > 0)) continue;
        const p1 = Number(endPx.get(r.symbol));
        if (!(p1 > 0)) { droppedOut += 1; continue; }
        if ((splits.get(r.symbol) || []).some((ex) => ex > start && ex <= end)) { excludedSplits += 1; continue; }
        pairs.push({ ...r, fwd: (p1 / p0 - 1) * 100 });
      }
      if (pairs.length < 20) continue;

      const nb = closeOnOrBefore(nifty, start);
      const ne = closeOnOrBefore(nifty, end);
      const row = {
        start, end,
        stocks: pairs.length,
        universePct: mean(pairs.map((p) => p.fwd)),
        niftyPct: nb && ne ? (ne.close / nb.close - 1) * 100 : null,
        factors: {},
      };

      for (const f of factors) {
        const scored = pairs.filter((p) => p[f] != null && Number.isFinite(Number(p[f])));
        if (scored.length < 20) continue;
        const ic = spearman(scored.map((p) => Number(p[f])), scored.map((p) => p.fwd));
        const sorted = [...scored].sort((a, b) => Number(b[f]) - Number(a[f]));
        const fifth = Math.max(1, Math.floor(sorted.length / 5));
        row.factors[f] = {
          ic,
          topFifthPct: mean(sorted.slice(0, fifth).map((p) => p.fwd)),
          bottomFifthPct: mean(sorted.slice(-fifth).map((p) => p.fwd)),
        };
      }

      const top = pairs
        .filter((p) => p.combined_score != null && QUALIFYING_LADDERS.has(p.ema_ladder))
        .sort((a, b) => b.combined_score - a.combined_score)
        .slice(0, TOP_N);
      row.top25Pct = top.length >= 10 ? mean(top.map((p) => p.fwd)) : null;
      perDate.push(row);
    }

    const span = perDate.length ? daysBetween(perDate[0].start, perDate[perDate.length - 1].end) : 0;
    const summary = {
      days,
      startDates: perDate.length,
      // How many windows of this length fit end to end in the period covered. THIS is the sample
      // size to judge the figures by, not startDates.
      independentWindows: Math.floor(span / days),
      firstStart: perDate[0]?.start || null,
      lastEnd: perDate[perDate.length - 1]?.end || null,
      excludedForSplitOrBonus: excludedSplits,
      droppedOutOfUniverse: droppedOut,
      factors: {},
    };
    for (const f of factors) {
      const rows = perDate.map((d) => d.factors[f]).filter(Boolean);
      const ics = rows.map((x) => x.ic).filter((x) => x != null);
      summary.factors[f] = {
        dates: rows.length,
        meanIc: round(mean(ics), 3),
        icPositiveShare: ics.length ? round(ics.filter((x) => x > 0).length / ics.length, 2) : null,
        topFifthPct: round(mean(rows.map((x) => x.topFifthPct))),
        bottomFifthPct: round(mean(rows.map((x) => x.bottomFifthPct))),
        spreadPct: round(mean(rows.map((x) => x.topFifthPct - x.bottomFifthPct))),
      };
    }
    const withTop = perDate.filter((d) => d.top25Pct != null);
    const withNifty = withTop.filter((d) => d.niftyPct != null);
    summary.top25 = {
      dates: withTop.length,
      top25Pct: round(mean(withTop.map((d) => d.top25Pct))),
      universePct: round(mean(withTop.map((d) => d.universePct))),
      niftyPct: round(mean(withNifty.map((d) => d.niftyPct))),
      vsUniversePct: round(mean(withTop.map((d) => d.top25Pct - d.universePct))),
      vsNiftyPct: round(mean(withNifty.map((d) => d.top25Pct - d.niftyPct))),
      beatUniverseShare: withTop.length ? round(withTop.filter((d) => d.top25Pct > d.universePct).length / withTop.length, 2) : null,
    };
    out.horizons[label] = summary;
  }
  return out;
}

async function loadInputs(universe) {
  const db = openDatabase();
  try {
    const rows = await allAsync(db,
      `SELECT scan_date, symbol, cmp, ema_ladder, ${FACTORS.join(', ')}
         FROM universe_scores WHERE universe = ? ORDER BY scan_date`, [universe]);
    const scans = new Map();
    for (const r of rows) {
      if (!scans.has(r.scan_date)) scans.set(r.scan_date, []);
      scans.get(r.scan_date).push(r);
    }
    const nifty = await allAsync(db, 'SELECT date, close FROM nifty_candles ORDER BY date').catch(() => []);
    const splits = new Map();
    const actions = await allAsync(db,
      `SELECT symbol, ex_date FROM corporate_actions
        WHERE action_type IN ('SPLIT', 'BONUS') AND ex_date IS NOT NULL`).catch(() => []);
    for (const a of actions) {
      const k = String(a.symbol || '').toUpperCase();
      if (!splits.has(k)) splits.set(k, []);
      splits.get(k).push(a.ex_date);
    }
    return { scans, nifty, splits };
  } finally {
    await closeAsync(db);
  }
}

async function validateScores({ universe = 'NIFTY500' } = {}) {
  const inputs = await loadInputs(universe);
  return { ok: true, universe, ...evaluate(inputs.scans, inputs) };
}

module.exports = { validateScores, evaluate, loadInputs, spearman, ranks, HORIZONS, FACTORS };
