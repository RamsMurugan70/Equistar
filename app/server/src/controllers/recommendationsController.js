const recommendationsService = require('../services/recommendations/recommendationsService');
const universeScannerService = require('../services/universe/universeScannerService');
const pickerMatchService = require('../services/recommendations/pickerMatchService');
const nseService = require('../services/market/nseService');
const { openDatabase, allAsync, closeAsync } = require('../db/connection');

async function listRecommendations(_req, res, next) {
  try {
    const data = await recommendationsService.getRecommendations();
    res.json(data);
  } catch (error) {
    next(error);
  }
}

async function addRecommendation(req, res, next) {
  try {
    const result = await recommendationsService.addRecommendation(req.body || {});
    if (result.duplicate) {
      return res.status(409).json({ error: 'An active recommendation for this symbol + action already exists.', id: result.id });
    }
    res.json({ saved: true, id: result.id });
  } catch (error) {
    if (/required/i.test(error.message)) return res.status(400).json({ error: error.message });
    next(error);
  }
}

// Accepts ?universe=NIFTY500|MIDCAP|SMALLCAP|MICROCAP (default NIFTY500) — one set
// of endpoints serves the main Nifty 500 list and the 3 cap-size lists alike.
function _universeParam(req) {
  const u = String(req.query.universe || 'NIFTY500').toUpperCase();
  if (!universeScannerService.UNIVERSES.includes(u)) {
    throw new Error(`Unknown universe "${u}"`);
  }
  return u;
}

async function nifty500Top(req, res, next) {
  try {
    const limit = Math.min(Number(req.query.limit) || 25, 50);
    const universe = _universeParam(req);
    res.json(await universeScannerService.getTopList(limit, universe));
  } catch (error) { next(error); }
}

async function nifty500Consistent(req, res, next) {
  try {
    res.json(await universeScannerService.getConsistentTops(_universeParam(req)));
  } catch (error) { next(error); }
}

async function nifty500Symbols(req, res, next) {
  try {
    const universeScoresRepository = require('../repositories/universeScoresRepository');
    res.json({ rows: await universeScoresRepository.listLatestSymbols(_universeParam(req)) });
  } catch (error) { next(error); }
}

async function nifty500StockPosition(req, res, next) {
  try {
    const symbol = req.query.symbol || '';
    const days = Math.min(Number(req.query.days) || 22, 60);
    if (!symbol.trim()) return res.status(400).json({ error: 'symbol is required' });
    res.json(await universeScannerService.getStockPosition(symbol, days, _universeParam(req)));
  } catch (error) { next(error); }
}

async function nifty500TopHistory(req, res, next) {
  try {
    const since = req.query.since || '';
    const days  = Math.min(Number(req.query.days) || 60, 365);
    res.json(await universeScannerService.getTopHistory({ since, days, universe: _universeParam(req) }));
  } catch (error) { next(error); }
}

// Kicks off a scan in the background and returns immediately (a full run can
// take 10–60 min). The UI polls /nifty500-top whose `status` reflects progress.
async function nifty500Scan(req, res, next) {
  try {
    const refreshFundamentals = !!req.body?.refreshFundamentals;
    const universe = String(req.body?.universe || 'NIFTY500').toUpperCase();
    if (!universeScannerService.UNIVERSES.includes(universe)) {
      return res.status(400).json({ error: `Unknown universe "${universe}"` });
    }
    // Refused synchronously, before the fire-and-forget below. runScan guards itself too, but a
    // rejected promise there would be swallowed by the .catch and this would still answer
    // "started: true" — telling a participant a scan is running when nothing is.
    const status = universeScannerService.getScanStatus(universe);
    if (!status.canScan) {
      return res.status(403).json({
        error: 'The scan is run once for everyone by the admin, not per participant. Ask them to '
          + 'run it; the result appears here as soon as it lands.',
        code: 'SCAN_NOT_OWNER',
        status,
      });
    }
    universeScannerService.runScan({ refreshFundamentals, trigger: 'manual', universe })
      .catch((e) => console.error(`${universe} manual scan failed:`, e.message));
    return res.json({ started: true, status: universeScannerService.getScanStatus(universe) });
  } catch (error) { next(error); }
}

// Exit candidates: held stocks consistently ranked in the bottom 25 of the Nifty 500 scan.
// Query: ?window=30  (days: 7, 30, 90, 180)
async function exitCandidates(req, res, next) {
  try {
    const windowDays = Math.min(Number(req.query.window) || 30, 365);
    const portfolioRepository = require('../repositories/portfolioRepository');
    const { getExitCandidates } = require('../repositories/universeScoresRepository');
    const { resolveNseSymbol } = require('../services/portfolio/portfolioService');

    // Collect all currently held symbols across both portfolios
    const snapshots = await portfolioRepository.listPortfolioSnapshots('', 20);
    const seen      = new Set();
    const heldMap   = new Map(); // NSE symbol → { portfolios: Set, qty, avgCost }

    for (const snap of snapshots) {
      if (seen.has(snap.portfolio)) continue;
      seen.add(snap.portfolio);
      let payload;
      try { payload = JSON.parse(snap.payload_json); } catch { continue; }
      for (const h of (payload?.portfolio || [])) {
        const qty = Number(h.qty ?? h.quantity ?? 0);
        if (qty <= 0) continue;
        const raw = h.instrument || h.symbol || '';
        if (!raw) continue;
        const nse = resolveNseSymbol(raw) || raw;
        if (!heldMap.has(nse)) heldMap.set(nse, { portfolios: new Set(), qty: 0, avgCost: h.avgCost || null });
        heldMap.get(nse).portfolios.add(snap.portfolio);
        heldMap.get(nse).qty += qty;
      }
    }

    const heldSymbols = [...heldMap.keys()];
    const candidates  = await getExitCandidates(heldSymbols, windowDays);

    // Merge portfolio info back in
    const result = candidates.map((c) => {
      const meta = heldMap.get(c.symbol) || heldMap.get(
        [...heldMap.keys()].find((k) => k.toUpperCase() === c.symbol.toUpperCase())
      ) || {};
      return {
        ...c,
        portfolios: meta.portfolios ? [...meta.portfolios] : [],
        held_qty:   meta.qty        || 0,
        avg_cost:   meta.avgCost    || null,
      };
    });

    // ── Held stocks ranked by today's Nifty 500 scan position (worst rank first) ──
    const { openDatabase: openDb2, allAsync: allAsync2, getAsync: getAsync2, closeAsync: closeAsync2 } = require('../db/connection');
    const db2 = openDb2();
    let todayBottom = [];
    try {
      const latestDate = await getAsync2(db2, `SELECT MAX(scan_date) AS d FROM universe_scores WHERE universe = 'NIFTY500'`);
      if (latestDate?.d && heldSymbols.length > 0) {
        const placeholders2 = heldSymbols.map(() => '?').join(', ');
        const scored = await allAsync2(db2,
          `SELECT s.symbol, s.name, s.industry, s.cmp,
                  s.combined_score, s.technical_score, s.momentum_score,
                  s.r1m, s.r3m, s.r6m, s.ema_ladder,
                  (SELECT COUNT(*) + 1 FROM universe_scores x
                    WHERE x.scan_date = s.scan_date AND x.universe = 'NIFTY500' AND x.combined_score > s.combined_score) AS rank,
                  (SELECT COUNT(*) FROM universe_scores x
                    WHERE x.scan_date = s.scan_date AND x.universe = 'NIFTY500' AND x.combined_score IS NOT NULL)         AS total
             FROM universe_scores s
            WHERE s.scan_date = ? AND s.universe = 'NIFTY500'
              AND UPPER(s.symbol) IN (${placeholders2})
            ORDER BY s.combined_score ASC`,
          [latestDate.d, ...heldSymbols.map((s) => s.toUpperCase())]
        );
        todayBottom = scored.map((r) => {
          const meta = [...heldMap.entries()].find(([k]) => k.toUpperCase() === r.symbol.toUpperCase())?.[1];
          return {
            ...r,
            scan_date:  latestDate.d,
            held:       true,
            portfolios: meta?.portfolios ? [...meta.portfolios] : [],
            held_qty:   meta?.qty   ?? 0,
            avg_cost:   meta?.avgCost ?? null,
          };
        });
      }
    } finally {
      await closeAsync2(db2);
    }

    res.json({ window_days: windowDays, candidates: result, total_held: heldSymbols.length, today_bottom: todayBottom });
  } catch (e) { next(e); }
}

// Returns orders placed for a symbol on or after rec_date, aggregated by portfolio.
// Query: ?symbol=RELIANCE&rec_date=2026-06-01
async function matchedOrders(req, res, next) {
  try {
    const { symbol, rec_date } = req.query;
    if (!symbol || !rec_date) return res.status(400).json({ error: 'symbol and rec_date are required' });

    const db = openDatabase();
    let orders, summary;
    try {
      orders = await allAsync(db,
        `SELECT trade_date, portfolio, side, quantity, price, exchange,
                ROUND(quantity * price, 2) AS value
           FROM orders
          WHERE UPPER(symbol) = UPPER(?)
            AND trade_date >= ?
          ORDER BY trade_date ASC`,
        [symbol, rec_date],
      );

      // Aggregate per portfolio
      const agg = {};
      for (const o of orders) {
        const p = o.portfolio;
        if (!agg[p]) agg[p] = { portfolio: p, buy_qty: 0, sell_qty: 0, buy_value: 0, sell_value: 0, orders: 0 };
        agg[p].orders++;
        if (o.side === 'BUY')  { agg[p].buy_qty   += o.quantity; agg[p].buy_value  += o.value; }
        if (o.side === 'SELL') { agg[p].sell_qty  += o.quantity; agg[p].sell_value += o.value; }
      }
      summary = Object.values(agg).map((a) => ({
        ...a,
        net_qty:       a.buy_qty - a.sell_qty,
        avg_buy_price: a.buy_qty > 0 ? Math.round((a.buy_value / a.buy_qty) * 100) / 100 : null,
        avg_sell_price: a.sell_qty > 0 ? Math.round((a.sell_value / a.sell_qty) * 100) / 100 : null,
        total_invested: Math.round(a.buy_value * 100) / 100,
      }));
    } finally {
      await closeAsync(db);
    }

    res.json({ symbol, rec_date, orders, summary });
  } catch (e) { next(e); }
}

// Matches every BUY order (all portfolios, or ?portfolio=X) against the daily Top-25
// universe scans and Investing.com ProPicks — "which picker's list led me to this trade?"
async function pickerMatches(req, res, next) {
  try {
    const { from = '', portfolio = '' } = req.query;
    const result = await pickerMatchService.getPickerMatches({ from, portfolio });
    res.json(result);
  } catch (e) { next(e); }
}

// Batch RSI lookup (latest scan) for a list of symbols — used by the Dashboard's
// Exit Candidates card to show "current RSI" without one request per stock.
async function rsiBatch(req, res, next) {
  try {
    const symbols = String(req.query.symbols || '')
      .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 200);
    if (!symbols.length) return res.status(400).json({ error: 'symbols is required (comma-separated)' });
    res.json(await pickerMatchService.getRsiBatch(symbols));
  } catch (e) { next(e); }
}

// Batch 52-week high/low distance for a list of symbols — used when a picker-performance
// category card is expanded, so the whole category's stock list can show "closeness to
// 52w high/low" without one request per stock. Tolerates individual symbol failures.
async function symbol52wBatch(req, res, next) {
  try {
    const symbols = String(req.query.symbols || '')
      .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 100);
    if (!symbols.length) return res.status(400).json({ error: 'symbols is required (comma-separated)' });

    const results = await Promise.all(symbols.map(async (symbol) => {
      try {
        const snap = await nseService.fetchMomentumSnapshot(symbol);
        return [symbol, {
          currentPrice: snap.currentPrice,
          high52Week: snap.high52Week, distanceFrom52WeekHighPct: snap.distanceFrom52WeekHighPct,
          low52Week: snap.low52Week, distanceFrom52WeekLowPct: snap.distanceFrom52WeekLowPct,
        }];
      } catch (_e) {
        return [symbol, null];
      }
    }));

    res.json(Object.fromEntries(results));
  } catch (e) { next(e); }
}

// Batch current universe rank + rank ~1 week ago for a list of symbols — used by the
// Dashboard's Exit Candidates card to show "current position, and how far it moved in
// the last week" without one request per stock.
async function rankMovementBatch(req, res, next) {
  try {
    const symbols = String(req.query.symbols || '')
      .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 200);
    if (!symbols.length) return res.status(400).json({ error: 'symbols is required (comma-separated)' });
    res.json(await pickerMatchService.getRankMovementBatch(symbols));
  } catch (e) { next(e); }
}

// On-demand technical detail (RSI, EMA ladder, universe rank, 200 EMA distance) for one
// symbol — used to lazily fill in the row expander on "Your Trades vs Recommendations".
async function symbolTechnicals(req, res, next) {
  try {
    const { symbol = '' } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });
    const result = await pickerMatchService.getSymbolTechnicals(symbol);
    res.json(result);
  } catch (e) { next(e); }
}

// Fundamentals + industry-peer context for one symbol (Stock Sleuth right panel).
// `force=1` bypasses the cache — used by the panel's manual refresh.
async function stockInsight(req, res, next) {
  try {
    const { symbol, force } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });
    const svc = require('../services/universe/stockFundamentalsService');
    const data = await svc.getStockInsight(symbol, { force: force === '1' || force === 'true' });
    res.json(data);
  } catch (e) { next(e); }
}

// Industry Scorecard — each NSE sector's return profile across 1W/1M/3M/6M/1Y, built from the
// latest NIFTY 500 scan, with every member stock so the UI can expand a sector in place.
async function industryScorecard(req, res, next) {
  try {
    const svc = require('../services/universe/industryScorecardService');
    res.json(await svc.build({ universe: req.query.universe || undefined }));
  } catch (e) { next(e); }
}

module.exports = {
  industryScorecard,
  stockInsight,
  listRecommendations,
  addRecommendation,
  exitCandidates,
  matchedOrders,
  pickerMatches,
  symbolTechnicals,
  symbol52wBatch,
  rsiBatch,
  rankMovementBatch,
  nifty500Top,
  nifty500TopHistory,
  nifty500Consistent,
  nifty500StockPosition,
  nifty500Symbols,
  nifty500Scan,
};
