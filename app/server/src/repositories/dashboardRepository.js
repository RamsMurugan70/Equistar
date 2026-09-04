const fs = require('fs');
const { openDatabase, getAsync, allAsync, closeAsync } = require('../db/connection');
const { getInsightActions } = require('../services/corporateActions/corporateActionsService');

// Shared NSE/BSE holiday list (same file the Optix workflow status reads) — used to
// tell the Dashboard's Portfolio Pulse lists when to show a flat "market closed today"
// indicator instead of the (stale, last-trading-day) dayChg figure.
const HOLIDAYS_PATH = 'D:\\AI Projects\\ZTA\\Options_Data_Agent\\trading_holidays.json';
function _isTradingDay(d = new Date()) {
  const dow = d.getDay();   // 0 = Sunday, 6 = Saturday
  if (dow === 0 || dow === 6) return false;
  try {
    const { holidays } = JSON.parse(fs.readFileSync(HOLIDAYS_PATH, 'utf8'));
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    const today = `${y}-${m}-${day}`;
    if ((holidays || []).some((h) => h.date === today)) return false;
  } catch (_e) { /* no holiday file — fall back to weekday-only check */ }
  return true;
}

async function withDatabase(work) {
  const db = openDatabase();
  try {
    return await work(db);
  } finally {
    await closeAsync(db);
  }
}

async function getDashboardSummary() {
  return withDatabase(async (db) => {
    const latestImport = await getAsync(
      db,
      `SELECT id, source_type, source_name, status, started_at, completed_at, rows_seen, rows_inserted, rows_skipped
       FROM import_runs
       ORDER BY id DESC
       LIMIT 1`
    );

    const latestSummaryDateRow = await getAsync(db, 'SELECT MAX(summary_date) AS latestDate FROM portfolio_summary');
    const latestSummaryDate = latestSummaryDateRow ? latestSummaryDateRow.latestDate : null;

    const totals = latestSummaryDate
      ? await getAsync(
          db,
          `WITH order_cost AS (
             SELECT
               portfolio,
               SUM(
                 CASE WHEN side = 'BUY' THEN quantity * price ELSE 0 END
               ) / NULLIF(SUM(CASE WHEN side = 'BUY' THEN quantity ELSE 0 END), 0)
               * SUM(CASE WHEN side = 'BUY' THEN quantity ELSE -quantity END)
               AS computed_per_symbol
             FROM orders
             GROUP BY portfolio, symbol
             HAVING SUM(CASE WHEN side = 'BUY' THEN quantity ELSE -quantity END) > 0
           ),
           order_total AS (
             SELECT portfolio, SUM(computed_per_symbol) AS total_computed
             FROM order_cost
             GROUP BY portfolio
           )
           SELECT
             COUNT(DISTINCT ps.portfolio) AS portfolio_count,
             SUM(
               CASE WHEN ps.total_invested > 0 THEN ps.total_invested
                    ELSE COALESCE(ot.total_computed, 0)
               END
             ) AS total_invested,
             SUM(ps.total_value) AS total_value,
             SUM(ps.day_change_value) AS day_change_value,
             SUM(ps.stock_count) AS stock_count
           FROM portfolio_summary ps
           LEFT JOIN order_total ot ON ot.portfolio = ps.portfolio
           WHERE ps.summary_date = ?`,
          [latestSummaryDate]
        )
      : { portfolio_count: 0, total_invested: 0, total_value: 0, day_change_value: 0, stock_count: 0 };

    const recommendationCountRow = await getAsync(db, 'SELECT COUNT(*) AS count FROM recommendations WHERE COALESCE(status, "Active") = "Active"');
    const orderCountRow = await getAsync(db, 'SELECT COUNT(*) AS count FROM orders');
    const snapshotCountRow = await getAsync(db, 'SELECT COUNT(*) AS count FROM portfolio_snapshots');
    // For portfolios where total_invested = 0 (e.g. ICICI Breeze demat imports
    // don't carry cost basis), compute invested from the orders table using the
    // weighted-average method: avgCost * net_qty per symbol, summed per portfolio.
    const portfolioBreakdown = latestSummaryDate
      ? await allAsync(
          db,
          `WITH order_cost AS (
             SELECT
               portfolio,
               SUM(
                 CASE WHEN side = 'BUY' THEN quantity * price ELSE 0 END
               ) / NULLIF(SUM(CASE WHEN side = 'BUY' THEN quantity ELSE 0 END), 0)
               * SUM(CASE WHEN side = 'BUY' THEN quantity ELSE -quantity END)
               AS computed_invested_per_symbol
             FROM orders
             GROUP BY portfolio, symbol
             HAVING SUM(CASE WHEN side = 'BUY' THEN quantity ELSE -quantity END) > 0
           ),
           order_total AS (
             SELECT portfolio, SUM(computed_invested_per_symbol) AS total_computed_invested
             FROM order_cost
             GROUP BY portfolio
           )
           SELECT
             ps.portfolio,
             CASE
               WHEN ps.total_invested > 0 THEN ps.total_invested
               ELSE COALESCE(ot.total_computed_invested, 0)
             END AS total_invested,
             ps.total_value,
             ps.day_change_value,
             ps.day_change_pct,
             ps.stock_count,
             CASE WHEN ps.total_invested = 0 AND ot.total_computed_invested > 0
               THEN 1 ELSE 0
             END AS invested_from_orders
           FROM portfolio_summary ps
           LEFT JOIN order_total ot ON ot.portfolio = ps.portfolio
           WHERE ps.summary_date = ?
           ORDER BY ps.portfolio`,
          [latestSummaryDate]
        )
      : [];

    return {
      latestImport,
      latestSummaryDate,
      totals: {
        portfolioCount: totals.portfolio_count || 0,
        totalInvested: totals.total_invested || 0,
        totalValue: totals.total_value || 0,
        dayChangeValue: totals.day_change_value || 0,
        stockCount: totals.stock_count || 0,
        activeRecommendationCount: recommendationCountRow ? recommendationCountRow.count : 0,
        orderCount: orderCountRow ? orderCountRow.count : 0,
        snapshotCount: snapshotCountRow ? snapshotCountRow.count : 0,
      },
      portfolioBreakdown,
    };
  });
}

// Insights: per-stock signals for the dashboard — gainers, losers, concentration, sector skew.
async function getDashboardInsights() {
  return withDatabase(async (db) => {
    // Latest portfolio snapshots (one per portfolio)
    const snapshots = await allAsync(db,
      `SELECT portfolio, payload_json FROM portfolio_snapshots
        WHERE id IN (
          SELECT MAX(id) FROM portfolio_snapshots GROUP BY portfolio
        )`
    );

    // Collect all holdings across portfolios
    const allHoldings = [];
    let totalInvested = 0;
    for (const snap of snapshots) {
      let payload;
      try { payload = JSON.parse(snap.payload_json); } catch { continue; }
      for (const h of (payload.portfolio || [])) {
        const qty      = Number(h.qty ?? h.quantity ?? 0);
        const invested = Number(h.invested || 0);
        const avgCost  = Number(h.avgCost || 0);
        const ltp      = Number(h.ltp || 0);
        const pnl      = Number(h.pnl || 0);
        const netChg   = Number(h.netChg || 0);
        const dayChg   = Number(h.dayChg || 0);
        if (qty <= 0) continue;
        allHoldings.push({
          symbol:    (h.instrument || h.symbol || '').toUpperCase(),
          portfolio: snap.portfolio,
          qty, invested, avgCost, ltp, pnl, netChg, dayChg,
          sector:    h.sector || 'Unknown',
        });
        totalInvested += invested;
      }
    }

    if (!allHoldings.length) return { alerts: [], totalInvested: 0, holdings: [] };

    // Join with latest universe_scores for r1w / r1m / r3m / combined_score / ema_ladder
    // (NIFTY500 only — MIDCAP/SMALLCAP/MICROCAP scans share this table under `universe`)
    const latestScan = await getAsync(db, `SELECT MAX(scan_date) AS d FROM universe_scores WHERE universe = 'NIFTY500'`);
    const scoreMap   = new Map();
    if (latestScan?.d) {
      const symbols = [...new Set(allHoldings.map((h) => h.symbol))];
      const ph      = symbols.map(() => '?').join(', ');
      const scores  = await allAsync(db,
        `SELECT symbol, combined_score, r1w, r1m, r3m, ema_ladder, rsi,
                (SELECT COUNT(*)+1 FROM universe_scores x
                  WHERE x.scan_date=s.scan_date AND x.universe = 'NIFTY500' AND x.combined_score > s.combined_score) AS rank,
                (SELECT COUNT(*) FROM universe_scores x
                  WHERE x.scan_date=s.scan_date AND x.universe = 'NIFTY500' AND x.combined_score IS NOT NULL) AS total
           FROM universe_scores s
          WHERE scan_date = ? AND s.universe = 'NIFTY500' AND UPPER(symbol) IN (${ph})`,
        [latestScan.d, ...symbols]
      );
      for (const s of scores) scoreMap.set(s.symbol.toUpperCase(), s);
    }

    // Enrich holdings with scores
    const enriched = allHoldings.map((h) => {
      const s = scoreMap.get(h.symbol) || {};
      return { ...h, ...s, investedPct: totalInvested > 0 ? (h.invested / totalInvested) * 100 : 0 };
    });

    // ── Generate alerts ──────────────────────────────────────────────────────
    const alerts = [];

    // 1. Weekly gainers (r1w >= +3%)
    const weekGainers = enriched.filter((h) => h.r1w != null && h.r1w >= 3)
      .sort((a, b) => b.r1w - a.r1w).slice(0, 5);
    if (weekGainers.length) alerts.push({
      type: 'momentum_up', icon: '🚀', title: 'Gaining Momentum',
      subtitle: 'Up 3%+ in the past week',
      items: weekGainers.map((h) => ({
        symbol: h.symbol, portfolio: h.portfolio,
        metric: `+${h.r1w.toFixed(1)}% (1W)`,
        sub: h.r1m != null ? `${h.r1m >= 0 ? '+' : ''}${h.r1m.toFixed(1)}% (1M)` : '',
        signal: 'positive', invested: h.invested,
        ltp: h.ltp, dayChg: h.dayChg,
        action: h.r1m > 10 ? 'Consider booking partial profit' : 'Watch for continuation',
      })),
    });

    // 2. Weekly losers (r1w <= -3%)
    const weekLosers = enriched.filter((h) => h.r1w != null && h.r1w <= -3)
      .sort((a, b) => a.r1w - b.r1w).slice(0, 5);
    if (weekLosers.length) alerts.push({
      type: 'momentum_down', icon: '🔴', title: 'Cracking This Week',
      subtitle: 'Down 3%+ in the past week',
      items: weekLosers.map((h) => ({
        symbol: h.symbol, portfolio: h.portfolio,
        metric: `${h.r1w.toFixed(1)}% (1W)`,
        sub: h.r1m != null ? `${h.r1m >= 0 ? '+' : ''}${h.r1m.toFixed(1)}% (1M)` : '',
        signal: 'negative', invested: h.invested,
        ltp: h.ltp, dayChg: h.dayChg,
        action: h.r1w < -7 ? 'Review — steep weekly fall' : 'Monitor closely',
      })),
    });

    // 3. Monthly losers (r1m <= -5%)
    const monthLosers = enriched.filter((h) => h.r1m != null && h.r1m <= -5 && !(h.r1w != null && h.r1w <= -3))
      .sort((a, b) => a.r1m - b.r1m).slice(0, 5);
    if (monthLosers.length) alerts.push({
      type: 'weak_month', icon: '📉', title: 'Weak Over Last Month',
      subtitle: 'Down 5%+ in 1 month (not already in weekly alert)',
      items: monthLosers.map((h) => ({
        symbol: h.symbol, portfolio: h.portfolio,
        metric: `${h.r1m.toFixed(1)}% (1M)`,
        sub: h.r3m != null ? `${h.r3m >= 0 ? '+' : ''}${h.r3m.toFixed(1)}% (3M)` : '',
        signal: 'negative', invested: h.invested,
        ltp: h.ltp, dayChg: h.dayChg,
        action: 'Check fundamentals — persistent weakness',
      })),
    });

    // 4. Concentration: single stock > 15% of portfolio
    const heavyPositions = enriched.filter((h) => h.investedPct > 15)
      .sort((a, b) => b.investedPct - a.investedPct);
    if (heavyPositions.length) alerts.push({
      type: 'concentration', icon: '⚖️', title: 'Heavy Concentration',
      subtitle: 'Single position > 15% of total portfolio',
      items: heavyPositions.map((h) => ({
        symbol: h.symbol, portfolio: h.portfolio,
        metric: `${h.investedPct.toFixed(1)}% of portfolio`,
        sub: `₹${Math.round(h.invested).toLocaleString('en-IN')} invested`,
        signal: h.investedPct > 25 ? 'negative' : 'warning', invested: h.invested,
        ltp: h.ltp, dayChg: h.dayChg,
        action: h.investedPct > 25 ? 'Significant concentration — consider trimming' : 'Monitor position size',
      })),
    });

    // 5. Sector concentration (> 30%)
    const sectorMap = {};
    for (const h of enriched) {
      const sec = h.sector || 'Unknown';
      if (!sectorMap[sec]) sectorMap[sec] = { sector: sec, invested: 0, symbols: [] };
      sectorMap[sec].invested += h.invested;
      sectorMap[sec].symbols.push(h.symbol);
    }
    const heavySectors = Object.values(sectorMap)
      .map((s) => ({ ...s, pct: totalInvested > 0 ? (s.invested / totalInvested) * 100 : 0 }))
      .filter((s) => s.pct > 30 && s.sector !== 'Unknown')
      .sort((a, b) => b.pct - a.pct);
    if (heavySectors.length) alerts.push({
      type: 'sector_skew', icon: '🏭', title: 'Sector Skew',
      subtitle: 'One sector takes up more than 30% of portfolio',
      items: heavySectors.map((s) => ({
        symbol: s.sector, portfolio: s.symbols.slice(0, 3).join(', ') + (s.symbols.length > 3 ? '…' : ''),
        metric: `${s.pct.toFixed(1)}% of portfolio`,
        sub: `${s.symbols.length} stocks · ₹${Math.round(s.invested).toLocaleString('en-IN')}`,
        signal: 'warning', invested: s.invested,
        action: 'Diversify — sector concentration risk',
      })),
    });

    // 6. Strong 3-month performers (r3m >= 15%) — add more capital candidates
    const strongPerformers = enriched.filter((h) => h.r3m != null && h.r3m >= 15)
      .sort((a, b) => b.r3m - a.r3m).slice(0, 5);
    if (strongPerformers.length) alerts.push({
      type: 'add_capital', icon: '💡', title: 'Strong 3-Month Run',
      subtitle: 'Up 15%+ in 3 months — momentum candidates for adding capital',
      items: strongPerformers.map((h) => ({
        symbol: h.symbol, portfolio: h.portfolio,
        metric: `+${h.r3m.toFixed(1)}% (3M)`,
        sub: h.combined_score != null ? `Score: ${h.combined_score.toFixed(0)}` : '',
        signal: 'positive', invested: h.invested,
        ltp: h.ltp, dayChg: h.dayChg,
        action: 'Strong performer — consider adding on dips',
      })),
    });

    // ── Corporate actions for held stocks ───────────────────────────────────
    const heldSymbols = [...new Set(enriched.map((h) => h.symbol))];
    const { upcoming, recent } = await getInsightActions(heldSymbols).catch(() => ({ upcoming: [], recent: [] }));

    const ACTION_ICONS = { DIVIDEND: '💰', SPLIT: '✂️', BONUS: '🎁', BUYBACK: '🔄', RIGHTS: '📋', MERGER: '🤝', OTHER: '📢' };

    if (upcoming.length) alerts.push({
      type: 'corp_upcoming', icon: '📅', title: 'Upcoming Corporate Actions',
      subtitle: 'Ex-dates in the next 3 weeks for your held stocks',
      items: upcoming.map((a) => ({
        symbol: a.symbol, portfolio: '',
        metric: `${ACTION_ICONS[a.action_type] || '📢'} ${a.action_type}`,
        sub: `Ex-date: ${a.ex_date}${a.record_date && a.record_date !== a.ex_date ? ` · Record: ${a.record_date}` : ''}`,
        signal: 'positive', invested: 0,
        action: a.subject,
      })),
    });

    if (recent.length) alerts.push({
      type: 'corp_recent', icon: '🗓', title: 'Recent Corporate Actions',
      subtitle: 'Happened in the last 30 days on your held stocks',
      items: recent.map((a) => ({
        symbol: a.symbol, portfolio: '',
        metric: `${ACTION_ICONS[a.action_type] || '📢'} ${a.action_type}`,
        sub: `Ex-date was: ${a.ex_date}`,
        signal: 'warning', invested: 0,
        action: a.subject,
      })),
    });

    return {
      alerts,
      totalInvested,
      holdingCount: enriched.length,
      scanDate: latestScan?.d || null,
      isTradingDay: _isTradingDay(),
    };
  });
}

module.exports = {
  getDashboardSummary,
  getDashboardInsights,
};
