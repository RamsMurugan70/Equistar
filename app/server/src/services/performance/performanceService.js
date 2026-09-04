const { openDatabase, allAsync, closeAsync } = require('../../db/connection');
const { fetchAndStoreNiftyCandles, getNiftyCandles } = require('../market/niftyService');
const PF = require('../../config/portfolios');

// ─── Portfolio summary data ───────────────────────────────────────────────────

async function getPortfolioSummaryRows({ fromDate, toDate, portfolio }) {
  const db = openDatabase();
  try {
    const params = [fromDate, toDate];
    let sql =
      'SELECT summary_date, portfolio, total_invested, total_value ' +
      'FROM portfolio_summary WHERE summary_date >= ? AND summary_date <= ?';
    if (portfolio && portfolio !== 'both') {
      sql += ' AND portfolio = ?';
      params.push(portfolio);
    }
    sql += ' ORDER BY summary_date ASC';
    return await allAsync(db, sql, params);
  } finally {
    await closeAsync(db);
  }
}

function buildDailySnapshots(rows, portfolio) {
  const byDate = {};
  for (const row of rows) {
    if (portfolio !== 'both' && row.portfolio !== portfolio) continue;
    if (!byDate[row.summary_date]) {
      byDate[row.summary_date] = { date: row.summary_date, invested: 0, value: 0 };
    }
    byDate[row.summary_date].invested += row.total_invested;
    byDate[row.summary_date].value    += row.total_value;
  }
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

function findNearest(snapshots, targetDate, maxDays = 7) {
  const target = new Date(targetDate).getTime();
  let best = null, bestDiff = Infinity;
  for (const s of snapshots) {
    const diff = Math.abs(new Date(s.date).getTime() - target);
    if (diff < bestDiff && diff <= maxDays * 86_400_000) {
      best = s; bestDiff = diff;
    }
  }
  return best;
}

// ─── Stock-level snapshot data ────────────────────────────────────────────────

async function getStockSnapshotsByDate(portfolioList, fromDate, toDate) {
  const db = openDatabase();
  try {
    const placeholders = portfolioList.map(() => '?').join(',');
    const rows = await allAsync(
      db,
      `SELECT portfolio, snapshot_date, payload_json
       FROM portfolio_snapshots
       WHERE portfolio IN (${placeholders}) AND snapshot_date >= ? AND snapshot_date <= ?
       ORDER BY snapshot_date ASC`,
      [...portfolioList, fromDate, toDate]
    );

    // { portfolio: { date: Map<symbol, {curVal, invested}> } }
    const byPortfolioDate = {};
    for (const row of rows) {
      let payload;
      try { payload = JSON.parse(row.payload_json); } catch { continue; }
      const holdings = Array.isArray(payload?.portfolio) ? payload.portfolio : [];

      if (!byPortfolioDate[row.portfolio]) byPortfolioDate[row.portfolio] = {};
      const symbolMap = new Map();
      for (const h of holdings) {
        const sym = String(h.instrument || '').trim().toUpperCase();
        if (sym) symbolMap.set(sym, {
          curVal:   Number(h.curVal   || 0),
          invested: Number(h.invested || 0),
        });
      }
      byPortfolioDate[row.portfolio][row.snapshot_date] = symbolMap;
    }
    return byPortfolioDate;
  } finally {
    await closeAsync(db);
  }
}

function findNearestDateFromSet(dateSet, targetDate, maxDays) {
  const target = new Date(targetDate).getTime();
  let bestDate = null, bestDiff = Infinity;
  for (const d of dateSet) {
    const diff = Math.abs(new Date(d).getTime() - target);
    if (diff < bestDiff && diff <= maxDays * 86_400_000) {
      bestDate = d; bestDiff = diff;
    }
  }
  return bestDate;
}

// Merge symbol maps from multiple portfolios for a single snapshot date
function mergedSymbolMap(byPortfolioDate, portfolioList, date) {
  const merged = new Map();
  for (const p of portfolioList) {
    const sym = (byPortfolioDate[p] || {})[date];
    if (!sym) continue;
    for (const [s, v] of sym) {
      const existing = merged.get(s);
      merged.set(s, existing
        ? { curVal: existing.curVal + v.curVal, invested: existing.invested + v.invested }
        : { ...v }
      );
    }
  }
  return merged;
}

function computeLikeForLike(startMap, endMap) {
  if (!startMap?.size || !endMap?.size) return null;

  let lfStart = 0, lfEnd = 0, exitedCount = 0, newCount = 0, newInvested = 0;

  for (const [sym, sv] of startMap) {
    const ev = endMap.get(sym);
    if (ev) {
      lfStart += sv.curVal;
      lfEnd   += ev.curVal;
    } else {
      exitedCount++;
    }
  }

  for (const [sym, ev] of endMap) {
    if (!startMap.has(sym)) {
      newCount++;
      newInvested += ev.invested;
    }
  }

  if (lfStart === 0) return null;

  return {
    startValue:   lfStart,
    endValue:     lfEnd,
    changePct:    ((lfEnd - lfStart) / lfStart) * 100,
    newAdditions: { count: newCount, invested: newInvested },
    exited:       { count: exitedCount },
  };
}

// ─── Period bucket generators ─────────────────────────────────────────────────

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function isoDate(d) { return d.toISOString().slice(0, 10); }

function isoWeek(d) {
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  return Math.ceil((((tmp - yearStart) / 86_400_000) + 1) / 7);
}

function generateWeekly(fromDate, toDate) {
  const periods = [];
  const to = new Date(toDate);
  let monday = new Date(toDate);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  monday.setDate(monday.getDate() - 7);
  const limitDate = new Date(fromDate);
  while (monday >= limitDate) {
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    const yr = String(monday.getFullYear()).slice(2);
    periods.unshift({
      label: `W${isoWeek(monday)} '${yr}`,
      start: isoDate(monday),
      end:   isoDate(sunday > to ? to : sunday),
    });
    monday.setDate(monday.getDate() - 7);
    if (periods.length >= 52) break;
  }
  return periods;
}

function generateMonthly(fromDate, toDate) {
  const periods = [];
  const to  = new Date(toDate);
  let   cur = new Date(new Date(fromDate).getFullYear(), new Date(fromDate).getMonth(), 1);
  while (cur <= to) {
    const start = new Date(cur);
    const end   = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    const yr    = String(start.getFullYear()).slice(2);
    periods.push({
      label: `${MONTH_SHORT[start.getMonth()]} '${yr}`,
      start: isoDate(start),
      end:   isoDate(end > to ? to : end),
    });
    cur.setMonth(cur.getMonth() + 1);
    if (periods.length >= 13) break;
  }
  return periods;
}

function generateQuarterly(fromDate, toDate) {
  const periods = [];
  const to   = new Date(toDate);
  const from = new Date(fromDate);
  let   year = from.getFullYear();
  let   q    = Math.floor(from.getMonth() / 3);
  while (true) {
    const startMonth = q * 3;
    const start = new Date(year, startMonth, 1);
    const end   = new Date(year, startMonth + 3, 0);
    if (start > to) break;
    const yr = String(year).slice(2);
    periods.push({
      label: `Q${q + 1} '${yr}`,
      start: isoDate(start),
      end:   isoDate(end > to ? to : end),
    });
    q++;
    if (q > 3) { q = 0; year++; }
    if (periods.length >= 8) break;
  }
  return periods;
}

// ─── Nifty aggregation ────────────────────────────────────────────────────────

function aggregateNiftyPeriod(candles, startDate, endDate) {
  const slice = candles.filter(c => c.date >= startDate && c.date <= endDate);
  if (!slice.length) return null;
  const open  = slice[0].open;
  const close = slice[slice.length - 1].close;
  return {
    open,
    close,
    high:      Math.max(...slice.map(c => c.high)),
    low:       Math.min(...slice.map(c => c.low)),
    changePct: ((close - open) / open) * 100,
  };
}

// ─── Daily invested/value trend (from portfolio_summary) ──────────────────────
// One point per day that ACTUALLY has a saved snapshot — this is not interpolated
// to be continuous. Coverage is only as good as how often holdings were fetched
// and saved; gaps in the returned series reflect real gaps in the data, not a bug.
async function getPortfolioTrend({ portfolio = 'both', fromDate, toDate } = {}) {
  const db = openDatabase();
  try {
    const norm = portfolio || 'both';
    const params = [];
    let sql = 'SELECT summary_date, portfolio, total_invested, total_value FROM portfolio_summary WHERE 1=1';
    if (fromDate) { sql += ' AND summary_date >= ?'; params.push(fromDate); }
    if (toDate)   { sql += ' AND summary_date <= ?'; params.push(toDate); }
    if (norm !== 'both') { sql += ' AND portfolio = ?'; params.push(norm); }
    sql += ' ORDER BY summary_date ASC';
    const rows = await allAsync(db, sql, params);

    // Combine portfolios per day when 'both' — a stock's portfolio_summary row is
    // already a per-portfolio daily total, so this just sums Rams + Geetha for that date.
    const byDate = new Map();
    for (const r of rows) {
      const cur = byDate.get(r.summary_date) || { date: r.summary_date, invested: 0, value: 0 };
      cur.invested += Number(r.total_invested || 0);
      cur.value    += Number(r.total_value    || 0);
      byDate.set(r.summary_date, cur);
    }
    const series = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

    const first = series[0], last = series[series.length - 1];
    return {
      portfolio: norm,
      series,
      summary: series.length ? {
        firstDate:      first.date,
        lastDate:       last.date,
        firstInvested:  first.invested,
        lastInvested:   last.invested,
        lastValue:      last.value,
        gainSinceFirst: last.value - last.invested,
        gainPctSinceFirst: last.invested > 0 ? ((last.value - last.invested) / last.invested) * 100 : null,
        investedAddedSinceFirst: last.invested - first.invested,
        daysWithData:   series.length,
      } : null,
    };
  } finally {
    await closeAsync(db);
  }
}

// ─── Investment Trend REPORT — weekly/monthly bucketed rows over a date range ──
// Unlike getPortfolioTrend (raw daily series for a chart), this buckets into
// report periods (weekly = Mon-Sun, monthly = calendar month) and picks the
// latest snapshot ON OR BEFORE each period's end date as that row's "as of"
// figure — i.e. a period's row reflects where the portfolio stood by the close
// of that period, not an average. Includes the range's edge periods even if
// partial (e.g. the report's last row can be a still-in-progress week/month).
function generateReportPeriods(fromDate, toDate, frequency) {
  const periods = [];
  const from = new Date(fromDate), to = new Date(toDate);
  if (frequency === 'weekly') {
    let monday = new Date(from);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));   // snap to Monday on/before `from`
    while (monday <= to) {
      const sunday = new Date(monday);
      sunday.setDate(sunday.getDate() + 6);
      const yr = String(monday.getFullYear()).slice(2);
      periods.push({
        label: `W${isoWeek(monday)} '${yr}`,
        start: isoDate(monday),
        end:   isoDate(sunday > to ? to : sunday),
      });
      monday.setDate(monday.getDate() + 7);
      if (periods.length >= 260) break;   // ~5 years of weeks, generous safety cap
    }
  } else {
    let cur = new Date(from.getFullYear(), from.getMonth(), 1);
    while (cur <= to) {
      const start = new Date(cur);
      const end   = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
      const yr    = String(start.getFullYear()).slice(2);
      periods.push({
        label: `${MONTH_SHORT[start.getMonth()]} '${yr}`,
        start: isoDate(start < from ? from : start),
        end:   isoDate(end > to ? to : end),
      });
      cur.setMonth(cur.getMonth() + 1);
      if (periods.length >= 120) break;   // 10 years of months, generous safety cap
    }
  }
  return periods;
}

async function getInvestmentTrendReport({ portfolio = 'both', frequency = 'monthly', fromDate, toDate } = {}) {
  const freq = frequency === 'weekly' ? 'weekly' : 'monthly';
  const { series } = await getPortfolioTrend({ portfolio, fromDate, toDate });

  if (!series.length) {
    return { portfolio, frequency: freq, fromDate: fromDate || null, toDate: toDate || null, rows: [] };
  }

  const effectiveFrom = fromDate || series[0].date;
  const effectiveTo   = toDate   || series[series.length - 1].date;
  const periods = generateReportPeriods(effectiveFrom, effectiveTo, freq);

  const rows = [];
  let prev = null;
  for (const period of periods) {
    // Latest snapshot on or before this period's end (last-known-value carried into the period).
    let asOf = null;
    for (const point of series) {
      if (point.date > period.end) break;
      asOf = point;
    }
    if (!asOf) continue;   // no data yet as of this period — skip rather than show a zero row

    const gain    = asOf.value - asOf.invested;
    const gainPct = asOf.invested > 0 ? (gain / asOf.invested) * 100 : null;
    const addedThisPeriod   = prev ? asOf.invested - prev.invested : null;
    const valueChgThisPeriod   = prev ? asOf.value - prev.value : null;
    const valueChgPctThisPeriod = prev && prev.value > 0 ? (valueChgThisPeriod / prev.value) * 100 : null;

    rows.push({
      label:     period.label,
      periodStart: period.start,
      periodEnd:   period.end,
      asOfDate:  asOf.date,
      invested:  asOf.invested,
      value:     asOf.value,
      gain,
      gainPct,
      addedThisPeriod,
      valueChgThisPeriod,
      valueChgPctThisPeriod,
    });
    prev = asOf;
  }

  return { portfolio, frequency: freq, fromDate: effectiveFrom, toDate: effectiveTo, rows };
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function getPerformanceSummary({ periodType = 'monthly', portfolio = 'both' }) {
  const toDate   = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  try { await fetchAndStoreNiftyCandles(); } catch (e) {
    console.warn('Nifty refresh skipped:', e.message);
  }

  const norm         = portfolio || 'both';
  const portfolioList = norm === 'both' ? PF.ALL : [norm];

  const [summaryRows, niftyCandles, stockSnapshots] = await Promise.all([
    getPortfolioSummaryRows({ fromDate, toDate, portfolio: norm }),
    getNiftyCandles({ fromDate, toDate }),
    getStockSnapshotsByDate(portfolioList, fromDate, toDate),
  ]);

  const snapshots = buildDailySnapshots(summaryRows, norm);

  const periods =
    periodType === 'weekly'    ? generateWeekly(fromDate, toDate)    :
    periodType === 'quarterly' ? generateQuarterly(fromDate, toDate) :
                                 generateMonthly(fromDate, toDate);

  const maxDays = periodType === 'weekly' ? 4 : periodType === 'quarterly' ? 20 : 10;

  // Collect all available stock snapshot dates across portfolios
  const allSnapshotDates = new Set();
  for (const p of portfolioList) {
    for (const d of Object.keys(stockSnapshots[p] || {})) allSnapshotDates.add(d);
  }

  const result = periods.map(period => {
    // ── Summary-level portfolio data (unchanged) ──
    const startSnap = findNearest(snapshots, period.start, maxDays);
    const endSnap   = findNearest(snapshots, period.end,   maxDays);

    let portfolioData = null;
    if (startSnap && endSnap && startSnap.date !== endSnap.date) {
      const rawChange  = endSnap.value - startSnap.value;
      const changePct  = startSnap.value > 0 ? (rawChange / startSnap.value) * 100 : 0;
      const marketGain =
        (endSnap.value - endSnap.invested) - (startSnap.value - startSnap.invested);
      portfolioData = {
        startValue:    startSnap.value,
        endValue:      endSnap.value,
        startInvested: startSnap.invested,
        endInvested:   endSnap.invested,
        rawChange,
        changePct,
        marketGain,
        marketGainPct: startSnap.value > 0 ? (marketGain / startSnap.value) * 100 : 0,
        startDate:     startSnap.date,
        endDate:       endSnap.date,
      };
    }

    // ── Stock-level like-for-like data ──
    const startSnapDate = findNearestDateFromSet(allSnapshotDates, period.start, maxDays);
    const endSnapDate   = findNearestDateFromSet(allSnapshotDates, period.end,   maxDays);

    let likeForLike = null;
    if (startSnapDate && endSnapDate && startSnapDate !== endSnapDate) {
      const startMap = mergedSymbolMap(stockSnapshots, portfolioList, startSnapDate);
      const endMap   = mergedSymbolMap(stockSnapshots, portfolioList, endSnapDate);
      likeForLike    = computeLikeForLike(startMap, endMap);
    }

    return {
      label:       period.label,
      start:       period.start,
      end:         period.end,
      portfolio:   portfolioData,
      likeForLike,
      nifty:       aggregateNiftyPeriod(niftyCandles, period.start, period.end),
    };
  });

  // Stats based on like-for-like where available, fall back to total portfolio
  const withData = result.filter(p => p.likeForLike ?? p.portfolio);
  const pctOf    = p => p.likeForLike?.changePct ?? p.portfolio?.changePct ?? 0;
  const upPeriods   = withData.filter(p => pctOf(p) >= 0);
  const downPeriods = withData.filter(p => pctOf(p) <  0);
  const best  = withData.reduce((a, b) => (!a || pctOf(b) > pctOf(a) ? b : a), null);
  const worst = withData.reduce((a, b) => (!a || pctOf(b) < pctOf(a) ? b : a), null);

  return {
    periods: result,
    periodType,
    portfolio: norm,
    stats: {
      totalPeriods:   withData.length,
      upCount:        upPeriods.length,
      downCount:      downPeriods.length,
      bestLabel:      best?.label   || '-',
      bestChangePct:  best  ? pctOf(best)  : null,
      worstLabel:     worst?.label  || '-',
      worstChangePct: worst ? pctOf(worst) : null,
    },
  };
}

module.exports = { getPerformanceSummary, getPortfolioTrend, getInvestmentTrendReport };
