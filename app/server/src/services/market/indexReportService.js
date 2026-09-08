// The Stock Sleuth report for an index rather than a stock.
//
// WHAT AN INDEX REPORT IS NOT. Half of the stock report has no meaning here and is deliberately
// absent rather than blank: an index has no rank inside a scanned universe (it is not a
// constituent of one), no combined/technical/fundamental score (those are computed per company
// from fundamentals it does not have), no quarterly results, no shareholding pattern, and no
// "do I hold it". Rendering those as empty panels would suggest the data failed to load.
//
// WHAT IT ADDS, and the reason the report is worth having at all: RELATIVE STRENGTH. "Nifty IT
// -5% this month" is nearly useless on its own — the whole market may have been down 6%, making
// -5% a good month. Against the Nifty 50 the same number becomes a read on the sector. For a
// sector index that comparison is the entire point of looking.
const nseService = require('./nseService');
const indexRegistry = require('./indexRegistry');

// Calendar days, not trading-day offsets into the array.
//
// WHY THIS MATTERS HERE AND NOT FOR STOCKS. Yahoo returns a sparse series for nine of the
// fourteen indices — about 211 usable closes across a year where a liquid stock has 250. Counting
// back a fixed number of array positions would then mean 3.7 months for those indices and 3.0 for
// the others, under the same "3M" label, and nothing on screen would reveal the difference.
// Finding the close nearest a target DATE is correct for both.
const WINDOWS = [
  { key: 'r1w', label: '1W', days: 7 },
  { key: 'r1m', label: '1M', days: 30 },
  { key: 'r3m', label: '3M', days: 91 },
  { key: 'r6m', label: '6M', days: 182 },
];

const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

/**
 * The close nearest to `daysAgo` calendar days before the last point.
 *
 * Returns null when the series does not reach back that far, or when the nearest candle is more
 * than a fortnight off target — better to show nothing than to label a 10-week return "3M".
 */
function closeNearDaysAgo(points, daysAgo) {
  if (!points.length) return null;
  const lastTs = points[points.length - 1].timestamp;
  const targetTs = lastTs - daysAgo * 86400;
  if (points[0].timestamp > targetTs + 14 * 86400) return null;   // series starts too late

  let best = null;
  let bestGap = Infinity;
  for (const p of points) {
    const gap = Math.abs(p.timestamp - targetTs);
    if (gap < bestGap) { bestGap = gap; best = p; }
  }
  return bestGap <= 14 * 86400 ? best.close : null;
}

/** Percentage return over each window, from one price series. */
function returnsFor(points) {
  const last = points.length ? points[points.length - 1].close : null;
  const out = {};
  for (const w of WINDOWS) {
    const then = closeNearDaysAgo(points, w.days);
    out[w.key] = (last != null && then != null && then > 0)
      ? r1(((last / then) - 1) * 100)
      : null;
  }
  return out;
}

/**
 * One index's report: where it stands now, how it has moved, and how that compares with the
 * market.
 *
 * The benchmark fetch is best-effort. An index report without relative strength is diminished but
 * still worth showing; failing the whole request because the Nifty 50 call timed out would take
 * away the price, trend and volatility too.
 */
async function build(keyRaw, { days = 22 } = {}) {
  const idx = indexRegistry.getIndex(keyRaw);
  if (!idx) {
    throw Object.assign(new Error(`"${keyRaw}" is not a known index.`), { code: 'NOT_AN_INDEX' });
  }

  const [histResult, snapResult] = await Promise.allSettled([
    nseService.fetchPriceHistory(idx.key),
    nseService.fetchMomentumSnapshot(idx.key),
  ]);

  if (histResult.status === 'rejected') {
    throw Object.assign(
      new Error(`Could not load price history for ${idx.label} (${idx.yahoo}): ${histResult.reason.message}`),
      { code: 'INDEX_DATA_UNAVAILABLE' });
  }

  const points = histResult.value.points;
  const own = returnsFor(points);

  // ── Relative strength, in PERCENTAGE POINTS ────────────────────────────────
  // A difference of two percentages is a number of points, not a percentage. Calling it "%" would
  // invite reading it as a ratio — "IT is 1.4% better than the Nifty" — when it means the sector
  // returned 1.4 points more. The client renders these visibly differently for the same reason.
  let benchmark = null;
  if (idx.benchmark) {
    const bench = indexRegistry.getIndex(idx.benchmark);
    try {
      const bHist = await nseService.fetchPriceHistory(bench.key);
      const bRet = returnsFor(bHist.points);
      const relative = {};
      for (const w of WINDOWS) {
        relative[w.key] = (own[w.key] != null && bRet[w.key] != null)
          ? r1(own[w.key] - bRet[w.key])
          : null;
      }
      benchmark = { key: bench.key, label: bench.label, returns: bRet, relative };
    } catch (_e) { benchmark = null; }
  }

  const snap = snapResult.status === 'fulfilled' ? snapResult.value : null;
  const live = snap ? {
    currentPrice: snap.currentPrice, asOf: snap.asOf,
    dma50: snap.dma50, dma200: snap.dma200,
    cmpVs50DmaPct: snap.cmpVs50DmaPct, cmpVs200DmaPct: snap.cmpVs200DmaPct,
    high52Week: snap.high52Week, distanceFrom52WeekHighPct: snap.distanceFrom52WeekHighPct,
    low52Week: snap.low52Week, distanceFrom52WeekLowPct: snap.distanceFrom52WeekLowPct,
    trendStatus: snap.trendStatus, emaLadder: snap.emaLadder, ema50SlopePct: snap.ema50SlopePct,
  } : null;

  // Same best-effort treatment as the stock report: volatility is useful context, never a reason
  // for the page to fail.
  let garch = null;
  try {
    garch = await require('./garchService').getGarchVolatility(idx.key);
  } catch (_e) { garch = null; }

  return {
    isIndex: true,
    key: idx.key,
    label: idx.label,
    group: idx.group,
    yahoo: idx.yahoo,
    sourceSymbol: histResult.value.sourceSymbol,
    asOfDate: new Date(points[points.length - 1].timestamp * 1000).toISOString().slice(0, 10),
    pointsCovered: points.length,
    windows: WINDOWS.map(({ key, label }) => ({ key, label })),
    returns: own,
    benchmark,
    live,
    garch,
    // Said in the payload rather than assumed by the client, so the card can explain itself
    // instead of silently lacking half a stock report.
    omits: [
      'universe rank', 'combined / technical / fundamental scores',
      'quarterly fundamentals', 'shareholding', 'holdings',
    ],
    days,
  };
}

module.exports = { build, WINDOWS };
