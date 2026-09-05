// Industry Scorecard — how each NSE sector has moved, from the stocks you already scan.
//
// WHAT THIS IS NOT: a sector index. Nifty Metal, Nifty Bank and the rest are FREE-FLOAT MARKET
// CAP WEIGHTED, so a handful of giants set the number. This is an EQUAL-WEIGHTED MEDIAN of the
// NIFTY 500 members in each industry — every constituent counts once, from the largest bank to
// the smallest. The two answer different questions and will not agree:
//
//   cap-weighted  "what did money invested across the sector do"
//   equal-weighted "what did a typical stock in the sector do"
//
// The second is the one worth having next to a stock picker, because it says whether the sector
// is broadly moving or whether two names are carrying it. That difference is measurable, so
// `breadth` reports it directly rather than leaving it to be inferred.
//
// MEDIAN, NOT MEAN. One microcap up 400% drags an average far enough to misdescribe the other
// forty members. The median cannot be moved by a single outlier, and the mean is returned
// alongside it precisely so a wide gap between the two is visible.
const { openDatabase, allAsync, closeAsync } = require('../../db/connection');
const portfolioRepository = require('../../repositories/portfolioRepository');
const { resolveNseSymbol } = require('../portfolio/portfolioService');

const UNIVERSE = 'NIFTY500';
const WINDOWS = ['r1w', 'r1m', 'r3m', 'r6m', 'r1y'];

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

/** Latest snapshot per portfolio → { NSE_SYMBOL: Set(portfolio) }. */
async function heldBySymbol() {
  const held = new Map();
  try {
    const snaps = await portfolioRepository.listPortfolioSnapshots('', 20);
    const seen = new Set();
    for (const s of snaps) {
      if (seen.has(s.portfolio)) continue;      // newest snapshot per portfolio only
      seen.add(s.portfolio);
      let payload;
      try { payload = JSON.parse(s.payload_json); } catch { continue; }
      for (const h of (payload?.portfolio || [])) {
        const raw = h.instrument || h.symbol || '';
        if (!raw) continue;
        const nse = (resolveNseSymbol(raw) || raw).toUpperCase();
        if (!held.has(nse)) held.set(nse, new Set());
        held.get(nse).add(s.portfolio);
      }
    }
  } catch { /* best-effort */ }
  return held;
}

/**
 * One row per industry, with per-window medians, plus every member stock.
 *
 * Everything comes from the latest scan of one universe, so a stock is in exactly one industry
 * and no name is double-counted.
 */
async function build({ universe = UNIVERSE } = {}) {
  const db = openDatabase();
  try {
    // The whole of one scan day, not per-symbol latest: an industry median has to be taken
    // across the same date for every member, or a stock last scanned a week ago quietly
    // contributes a stale return to today's number.
    const rows = await allAsync(db,
      `SELECT symbol, name, industry, cmp, combined_score, rsi, ema_ladder,
              r1w, r1m, r3m, r6m, r1y, scan_date
         FROM universe_scores
        WHERE universe = ?
          AND scan_date = (SELECT MAX(scan_date) FROM universe_scores WHERE universe = ?)`,
      [universe, universe]);

    if (!rows.length) {
      return { universe, scanDate: null, industries: [], market: null,
        message: 'No scan data yet for this universe.' };
    }
    const scanDate = rows[0].scan_date;

    // Holdings overlay, so a sector you are already exposed to is obvious at a glance.
    // Holdings live inside each snapshot's payload_json and use broker codes, so this reuses
    // the same read-and-resolve the recommendations page does. Best effort — the scorecard is
    // about the market, and an unreadable snapshot must not take the page down.
    const heldBy = await heldBySymbol();

    const byIndustry = new Map();
    for (const r of rows) {
      const key = r.industry || 'Unclassified';
      if (!byIndustry.has(key)) byIndustry.set(key, []);
      byIndustry.get(key).push(r);
    }

    const industries = [...byIndustry.entries()].map(([name, members]) => {
      const windows = {};
      for (const w of WINDOWS) {
        // Only members that actually have this window. A stock listed four months ago has no
        // 6-month return, and counting it as 0 would drag the sector toward flat.
        const vals = members.map((m) => m[w]).filter((v) => Number.isFinite(v));
        windows[w] = vals.length ? {
          median: r1(median(vals)),
          mean: r1(mean(vals)),
          best: r1(Math.max(...vals)),
          worst: r1(Math.min(...vals)),
          // How much of the sector is actually participating. A +12% median on 80% advancing is
          // a sector move; the same median on 45% advancing is a couple of names running.
          advancing: vals.filter((v) => v > 0).length,
          declining: vals.filter((v) => v <= 0).length,
          breadthPct: r1((vals.filter((v) => v > 0).length / vals.length) * 100),
          measured: vals.length,
        } : null;
      }

      const scores = members.map((m) => m.combined_score).filter((v) => Number.isFinite(v));
      const stocks = members.map((m) => ({
        symbol: m.symbol,
        name: m.name || m.symbol,
        cmp: m.cmp,
        score: m.combined_score,
        rsi: r1(m.rsi),
        emaLadder: m.ema_ladder,
        r1w: m.r1w, r1m: m.r1m, r3m: m.r3m, r6m: m.r6m, r1y: m.r1y,
        heldBy: [...(heldBy.get(String(m.symbol).toUpperCase()) || [])],
      }));

      return {
        industry: name,
        count: members.length,
        windows,
        avgScore: r1(mean(scores)),
        heldCount: stocks.filter((s) => s.heldBy.length).length,
        stocks,
      };
    });

    // The whole universe as one row, so an industry's number can be read against the market
    // rather than in isolation — +8% is a different thing when the market did +2% or +11%.
    const market = { industry: 'NIFTY 500', count: rows.length, windows: {} };
    for (const w of WINDOWS) {
      const vals = rows.map((r) => r[w]).filter((v) => Number.isFinite(v));
      market.windows[w] = vals.length ? {
        median: r1(median(vals)),
        mean: r1(mean(vals)),
        breadthPct: r1((vals.filter((v) => v > 0).length / vals.length) * 100),
        measured: vals.length,
      } : null;
    }

    return { universe, scanDate, windows: WINDOWS, industries, market };
  } finally {
    await closeAsync(db);
  }
}

module.exports = { build, WINDOWS, UNIVERSE };
