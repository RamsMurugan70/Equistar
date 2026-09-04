const portfolioRepository = require('../../repositories/portfolioRepository');
const holdingScoresRepository = require('../../repositories/holdingScoresRepository');
const { getAvgCostBySymbol } = require('../../repositories/ordersRepository');
const { getOverridesMap } = require('../../repositories/costBasisRepository');
const { labelScore } = require('../scoring/scoringService');
const nseService = require('../market/nseService');
const { openDatabase, allAsync, closeAsync } = require('../../db/connection');
const { isFno } = require('../../utils/tradeClassification');
const PF = require('../../config/portfolios');

// ── ICICI broker code → NSE ticker map ────────────────────────────────────────
// ICICI Direct uses its own short codes which differ from NSE symbols.
// This map translates them before calling Yahoo Finance / NSE market APIs,
// and also for score lookups (scores are stored under NSE tickers).
const ICICI_TO_NSE = {
  // Equities
  // Verified the way the rest of this map was: by matching value, not by the names looking
  // alike. A holding of 15 UltraTech shares worth Rs 175,380 disappeared with no sale on
  // record, while ULTCEM sold 5 + 10 shares at ~Rs 11,692 — 15 x 11,692 is exactly 175,380.
  // Unmapped, the same position was reported as a Rs 1.75L gain and a Rs 1.75L loss side by side.
  ULTCEM: 'ULTRACEMCO',
  ANARAT: 'ANANDRATHI',
  ENGIND:      'ENGINERSIN',
  ENGINEERSIN: 'ENGINERSIN',
  SHYMET: 'SHYAMMETL',   // Shyam Metalics and Energy
  EMMPHO: 'EMMVEE',      // Emmvee Photovoltaic Power
  FIRSOU: 'FSL',         // Firstsource Solutions
  RBLBAN: 'RBLBANK',     // RBL Bank
  NIPNIT: 'ITBEES',      // Nippon India Nifty IT ETF
  RAIIND: 'RAIN',        // Rain Industries
  DATGLO: 'DATAMATICS',  // Datamatics Global Services
  KARVYS: 'KARURVYSYA',  // Karur Vysya Bank
  TORPHA: 'TORNTPHARM',  // Torrent Pharmaceuticals
  BAAUTO: 'BAJAJ-AUTO',  // Bajaj Auto
  BAJFI:  'BAJFINANCE',
  BHAELE: 'BEL',
  BHAPET: 'BPCL',
  BILGAR: 'GROWW',
  CITUNI: 'CUB',
  GUJMI:  'GMDCLTD',
  HDFAMC: 'HDFCAMC',
  HDFBAN: 'HDFCBANK',
  ICIBAN: 'ICICIBANK',
  INDOIL: 'IOC',
  LARTOU: 'LT',
  LAULAB: 'LAURUSLABS',
  MAPHA:  'MANKIND',
  MARUTI: 'MARUTI',
  MCX:    'MCX',
  POWFIN: 'PFC',
  RELIND: 'RELIANCE',
  RURELE: 'RECLTD',
  STABAN: 'SBIN',
  SUNHIT: 'SUNILHITEC',
  UJJSMA: 'UJJIVANSFB',
  // ETFs
  BANBEE: 'BANKBEES',
  GOLDEX: 'GOLDBEES',
  HDFGOL: 'HDFCGOLD',
  // ── Verified 2026-08-17 by matching the broker's own LTP against the candidate's live
  // quote. ICIGOL/ICINIF previously mapped to ICICIGOLD/ICICINIFTY, which are not NSE symbols
  // at all — both 404 — so these holdings silently had no price anywhere in the app.
  ICIGOL: 'GOLDIETF',      // ICICI Pru Gold ETF. broker 129.60 vs GOLDIETF 131.02 (1.1%);
                           // GOLDBEES was 2.45% off, so not that one.
  ICINIF: 'NIFTYIETF',     // ICICI Pru Nifty 50 ETF. broker 276.84 vs NIFTYIETF 276.50 (0.12%).
                           // NIFTYBEES also sits ~0.4% away (same index, similar NAV) — the
                           // tie is broken by the ICI- prefix and by NIFBEE already being the
                           // separate code for the Nippon fund.
  ADIAMC: 'ABSLAMC',       // Aditya Birla Sun Life AMC. broker 1011.20 vs 1019.00 (0.77%).
  EDEFIN: 'EDELWEISS',     // Edelweiss Financial Services. broker 121.98 vs 122.67 (0.57%).
  TATCOV: 'TMCV',          // Tata Motors (commercial vehicles) post-demerger. broker 474.30 vs
                           // TMCV 470.40 (0.82%); TMPV was 30% away, so definitively the CV arm.
  ICIPSE: 'ICICISILVE',
  NIFBEE: 'NIFTYBEES',
  NIFJUN: 'JUNIORBEES',
  ZEROGE: 'GOLDCASE',
};

// Symbols that are suspended, unlisted, or otherwise untradeable on NSE
// (verified absent from the scores DB)
const SKIP_SYMBOLS = new Set(['IMAMAR', 'ORASTA']);

// ── ICICI broker code → Sector / Industry ─────────────────────────────────────
const ICICI_META = {
  // Equities
  ANARAT: { sector: 'Financials',    industry: 'Capital Markets' },
  BAJFI:  { sector: 'Financials',    industry: 'NBFC' },
  BHAELE: { sector: 'Defence',       industry: 'Electronics' },
  BHAPET: { sector: 'Energy',        industry: 'Oil & Gas' },
  BILGAR: { sector: 'Financials',    industry: 'FinTech' },
  CITUNI: { sector: 'Financials',    industry: 'Private Banking' },
  GUJMI:  { sector: 'Materials',     industry: 'Mining & Minerals' },
  HDFAMC: { sector: 'Financials',    industry: 'Asset Management' },
  HDFBAN: { sector: 'Financials',    industry: 'Private Banking' },
  ICIBAN: { sector: 'Financials',    industry: 'Private Banking' },
  IMAMAR: { sector: 'Consumer',      industry: 'Consumer Electronics' },
  INDOIL: { sector: 'Energy',        industry: 'Oil & Gas' },
  LARTOU: { sector: 'Industrials',   industry: 'Infrastructure & Engineering' },
  LAULAB: { sector: 'Healthcare',    industry: 'Pharmaceuticals' },
  MAPHA:  { sector: 'Healthcare',    industry: 'Pharmaceuticals' },
  MARUTI: { sector: 'Consumer',      industry: 'Automobiles' },
  MCX:    { sector: 'Financials',    industry: 'Commodity Exchange' },
  MOHMEA: { sector: 'Consumer',      industry: 'Beverages' },
  ORASTA: { sector: 'Consumer',      industry: 'Hospitality' },
  POWFIN: { sector: 'Financials',    industry: 'PSU Finance' },
  RELIND: { sector: 'Energy',        industry: 'Conglomerate' },
  RURELE: { sector: 'Financials',    industry: 'PSU Finance' },
  STABAN: { sector: 'Financials',    industry: 'PSU Banking' },
  SUNHIT: { sector: 'Industrials',   industry: 'Infrastructure' },
  UJJSMA: { sector: 'Financials',    industry: 'Small Finance Bank' },
  // ETFs
  BANBEE: { sector: 'ETF',           industry: 'Banking Index ETF' },
  GOLDEX: { sector: 'ETF',           industry: 'Gold ETF' },
  HDFGOL: { sector: 'ETF',           industry: 'Gold ETF' },
  ICIGOL: { sector: 'ETF',           industry: 'Gold ETF' },
  ICINIF: { sector: 'ETF',           industry: 'Nifty 50 ETF' },
  ADIAMC: { sector: 'Financials',    industry: 'Asset Management' },
  EDEFIN: { sector: 'Financials',    industry: 'Diversified Financials' },
  TATCOV: { sector: 'Consumer',      industry: 'Automobiles' },
  ICIPSE: { sector: 'ETF',           industry: 'Silver ETF' },
  NIFBEE: { sector: 'ETF',           industry: 'Nifty 50 ETF' },
  NIFJUN: { sector: 'ETF',           industry: 'Nifty Next 50 ETF' },
  ZEROGE: { sector: 'ETF',           industry: 'Gold ETF' },
  // Geetha (Zerodha Kite) — keyed by NSE symbol
  SILVERBEES: { sector: 'ETF',         industry: 'Silver ETF' },
  MON100:     { sector: 'ETF',         industry: 'Nasdaq 100 ETF' },
  CUPID:      { sector: 'Healthcare',  industry: 'Medical Devices' },
  BSE:        { sector: 'Financials',  industry: 'Stock Exchange' },
  HINDCOPPER: { sector: 'Materials',   industry: 'Metals & Mining' },
  DATAPATTNS: { sector: 'Defence',     industry: 'Defence Electronics' },
};

function resolveNseSymbol(symbol) {
  return ICICI_TO_NSE[symbol] || symbol;
}

// ── Dead scrips: delisted or suspended, still sitting in the demat ────────────
//
// These are NOT a mapping gap, and marking them matters because the two look identical from
// the outside — a holding with no price. A missing MAPPING hides a real, valuable position
// (that was ADIAMC: ~Rs 50k invisible); a DEAD scrip has genuinely no market. Left
// undistinguished, the second kind trains you to ignore the "unpriced" warning that exists to
// catch the first.
//
// Shared evidence for all four (checked 2026-08-17): quantity > 0 but ZERO avg cost and ZERO
// invested, NO order history anywhere in the database, and no quote under any candidate symbol.
// The zero cost is the tell — they predate the order data or arrived via a corporate action.
//
// Deliberately NOT given a guessed NSE symbol. The price-match test that verified the live
// mappings needs a broker LTP to match against, and these have none — so any symbol here would
// be an unverifiable name guess. That is exactly how ICIGOL -> ICICIGOLD (not a real symbol)
// got in and stayed wrong.
const DEAD_SCRIPS = {
  SUNHIT: { name: 'Sunil Hitech Engineers', status: 'SUSPENDED',
            note: 'Resolves to SUNILHITEC, which is in the NSE master but returns no quote — long suspended.' },
  MOHMEA: { name: 'Mohit Industries', status: 'SUSPENDED',
            note: 'Resolves to MOHITIND, present in the NSE master but not quoting.' },
  IMAMAR: { name: null, status: 'UNIDENTIFIED',
            note: 'No name match in the 2,373-symbol NSE master and no quote under any candidate.' },
  ORASTA: { name: null, status: 'UNIDENTIFIED',
            note: 'No name match in the NSE master and no quote under any candidate.' },
};

function deadScripInfo(symbol) {
  return DEAD_SCRIPS[String(symbol || '').toUpperCase()] || null;
}

function parseSnapshotPayload(snapshot) {
  try {
    return {
      ...snapshot,
      payload: JSON.parse(snapshot.payload_json),
    };
  } catch (_error) {
    return {
      ...snapshot,
      payload: null,
    };
  }
}

function buildHoldingFromSnapshot(snapshot, holding) {
  const momentumScore = Number(holding.momentumScore || 0);
  const fundamentalScore = Number(holding.fundamentalScore || 0);
  const technicalScore = Number(holding.technicalScore || 0);
  const combinedScore = Number(holding.momFunTechScore || 0);

  return {
    portfolio: snapshot.portfolio,
    snapshotDate: snapshot.snapshot_date,
    symbol: holding.instrument,
    quantity: Number(holding.qty || 0),
    avgCost: Number(holding.avgCost || 0),
    ltp: Number(holding.ltp || 0),
    invested: Number(holding.invested || 0),
    currentValue: Number(holding.curVal || 0),
    pnl: Number(holding.pnl || 0),
    netChangePct: Number(holding.netChg || 0),
    dayChangePct: Number(holding.dayChg || 0),
    beta: Number(holding.beta || 0),
    sector: (holding.sector && holding.sector !== 'Unknown')
      ? holding.sector
      : (ICICI_META[holding.instrument]?.sector || 'Unknown'),
    industry: (holding.industry && holding.industry !== 'Unknown')
      ? holding.industry
      : (ICICI_META[holding.instrument]?.industry || 'Unknown'),
    fiftyTwoWeekHigh: Number(holding.fiftyTwoWeekHigh || 0),
    drawdown: Number(holding.drawdown || 0),
    // Delisted/suspended — carries no price BY NATURE, so it must not be counted alongside
    // holdings that are unpriced because something is broken.
    dead: !!deadScripInfo(holding.instrument),
    deadInfo: deadScripInfo(holding.instrument),
    scores: {
      momentum: {
        value: momentumScore,
        label: holding.momentumLabel || 'Pending',
      },
      fundamental: {
        value: fundamentalScore,
        label: holding.fundamentalLabel || 'Pending',
      },
      technical: {
        value: technicalScore,
        label: holding.technicalLabel || 'Pending',
      },
      combined: {
        value: combinedScore,
        label: holding.momFunTechLabel || 'Pending',
      },
      status:
        momentumScore || fundamentalScore || technicalScore || combinedScore
          ? 'migrated'
          : 'pending',
    },
  };
}

function deriveCurrentHoldings(snapshots) {
  return snapshots
    .flatMap((snapshot) => {
      const holdings = snapshot.payload?.portfolio || [];
      return holdings.map((holding) => buildHoldingFromSnapshot(snapshot, holding));
    })
    .sort((left, right) => right.currentValue - left.currentValue);
}

function mergeRecomputedScores(holdings, scoreRows) {
  const scoreMap = new Map(
    scoreRows.map((row) => [`${row.portfolio}::${row.symbol}`, row])
  );

  return holdings.map((holding) => {
    // Scores are stored under NSE codes; holdings use ICICI broker codes.
    // Try NSE-translated symbol first, fall back to raw symbol.
    const nseSymbol = resolveNseSymbol(holding.symbol);
    const scoreRow =
      scoreMap.get(`${holding.portfolio}::${nseSymbol}`) ||
      scoreMap.get(`${holding.portfolio}::${holding.symbol}`);

    // Skip rows where the scorer ran but produced no data (all null scores)
    const hasRealScore =
      scoreRow &&
      (scoreRow.combined_score != null ||
        scoreRow.momentum_score != null ||
        scoreRow.technical_score != null);

    if (!hasRealScore) {
      // Even without a usable score, the scorer may still have recorded the
      // company name (holding_scores.name) — worth keeping for display.
      return scoreRow?.name ? { ...holding, name: holding.name || scoreRow.name } : holding;
    }

    return {
      ...holding,
      name: holding.name || scoreRow.name || null,
      scores: {
        momentum: {
          value: Number(scoreRow.momentum_score || 0),
          label: labelScore(Number(scoreRow.momentum_score || 0)),
        },
        fundamental: {
          value: Number(scoreRow.fundamental_score || 0),
          label: labelScore(Number(scoreRow.fundamental_score || 0)),
        },
        technical: {
          value: Number(scoreRow.technical_score || 0),
          label: labelScore(Number(scoreRow.technical_score || 0)),
        },
        combined: {
          value: Number(scoreRow.combined_score || 0),
          label: labelScore(Number(scoreRow.combined_score || 0)),
        },
        status: 'recomputed',
        scoreVersion: scoreRow.score_version || 'v1-local',
      },
    };
  });
}

function buildLatestSummary(portfolio, summaries) {
  if (portfolio) {
    return summaries[0] || null;
  }

  if (!summaries.length) {
    return null;
  }

  const latestDate = summaries[0].summary_date;
  const latestRows = summaries.filter((item) => item.summary_date === latestDate);

  return {
    summary_date: latestDate,
    portfolio: 'All',
    total_invested: latestRows.reduce((sum, item) => sum + Number(item.total_invested || 0), 0),
    total_value: latestRows.reduce((sum, item) => sum + Number(item.total_value || 0), 0),
    day_change_value: latestRows.reduce((sum, item) => sum + Number(item.day_change_value || 0), 0),
    day_change_pct:
      latestRows.reduce((sum, item) => sum + Number(item.day_change_pct || 0), 0) / latestRows.length,
    stock_count: latestRows.reduce((sum, item) => sum + Number(item.stock_count || 0), 0),
  };
}

function pickLatestSnapshots(snapshots, portfolio) {
  if (portfolio) {
    return snapshots.slice(0, 1);
  }

  const seen = new Set();
  const latest = [];

  for (const snapshot of snapshots) {
    if (!seen.has(snapshot.portfolio)) {
      latest.push(snapshot);
      seen.add(snapshot.portfolio);
    }
  }

  return latest;
}

// Value-weighted day change from a snapshot payload's per-stock dayChg (%).
// The broker/market 1-day move each holding carried when the snapshot was captured.
function dayChangeFromPayload(payload) {
  const holdings = payload?.portfolio || [];
  let totalValue = 0, weighted = 0, dayValue = 0;
  for (const h of holdings) {
    const qty    = Number(h.qty ?? h.quantity ?? 0);
    const ltp    = Number(h.ltp || 0);
    const dayChg = Number(h.dayChg || 0);                       // percent
    const curVal = Number(h.curVal != null ? h.curVal : qty * ltp);
    if (!(curVal > 0)) continue;
    totalValue += curVal;
    weighted   += curVal * dayChg;
    const d = dayChg / 100;
    const prevPrice = (1 + d) !== 0 ? ltp / (1 + d) : ltp;
    dayValue += (ltp - prevPrice) * qty;
  }
  return { dayPct: totalValue > 0 ? weighted / totalValue : 0, dayValue, totalValue };
}

async function getPortfolioOverview(portfolio) {
  const summaries = await portfolioRepository.listPortfolioSummaries(portfolio || '', 20);
  const snapshots = await portfolioRepository.listPortfolioSnapshots(portfolio || '', 20);
  const parsedSnapshots = snapshots.map(parseSnapshotPayload);

  // Day % is stored as 0 in portfolio_summary — recompute it at read time from each
  // snapshot's per-stock dayChg so the Recent Summaries table shows real numbers.
  const payloadByKey = new Map();
  for (const s of parsedSnapshots) {
    if (s.payload) payloadByKey.set(`${s.portfolio}::${s.snapshot_date}`, s.payload);
  }
  for (const row of summaries) {
    const payload = payloadByKey.get(`${row.portfolio}::${row.summary_date}`);
    if (payload) {
      const dc = dayChangeFromPayload(payload);
      row.day_change_pct   = dc.dayPct;
      row.day_change_value = dc.dayValue;
    }
  }
  const currentSnapshots = pickLatestSnapshots(parsedSnapshots, portfolio || '');
  const scoreDates = [...new Set(currentSnapshots.map((snapshot) => snapshot.snapshot_date).filter(Boolean))];
  // Use latest scores for each portfolio — scores and snapshots often have different dates
  const portfoliosInView = [...new Set(currentSnapshots.map((s) => s.portfolio).filter(Boolean))];
  const storedScoresArrays = await Promise.all(
    portfoliosInView.map((p) => holdingScoresRepository.listLatestScores(p))
  );
  const storedScores = storedScoresArrays.flat();
  // ── Inject cost basis for portfolios where broker doesn't supply avgCost ─────
  // Priority: 1) cost_basis_overrides (user-supplied from historical CSV)
  //           2) orders table (weighted-average of all equity buy orders)
  //           3) snapshot value (already present for Zerodha / new-format imports)
  const portfoliosInSnapshots = [...new Set(currentSnapshots.map((s) => s.portfolio).filter(Boolean))];

  const [overridesByPortfolio, orderCostByPortfolio] = await Promise.all([
    // 1. Load user-supplied cost basis overrides (highest priority)
    Promise.all(
      portfoliosInSnapshots.map(async (p) => [p, await getOverridesMap(p)])
    ).then(Object.fromEntries),
    // 2. Load computed cost basis from equity orders (fallback)
    Promise.all(
      portfoliosInSnapshots.map(async (p) => {
        const rows = await getAvgCostBySymbol(p);
        return [p, new Map(rows.map((r) => [r.symbol, r]))];
      })
    ).then(Object.fromEntries),
  ]);

  function injectCostBasis(holding) {
    if (Number(holding.invested) > 0 && Number(holding.avgCost) > 0) return holding;

    const overrides = overridesByPortfolio[holding.portfolio];
    const orderCosts = orderCostByPortfolio[holding.portfolio];
    const qty = Number(holding.quantity) || 0;

    // 1. Try cost_basis_overrides first
    const override = overrides?.get(holding.symbol);
    if (override && Number(override.avg_cost) > 0) {
      const avgCost = Number(override.avg_cost);
      return {
        ...holding,
        avgCost,
        invested: avgCost * qty,
        costSource: 'override',
      };
    }

    // 2. Fall back to orders-computed weighted average
    const cb = orderCosts?.get(holding.symbol);
    if (cb && Number(cb.avg_cost) > 0) {
      const avgCost = Number(cb.avg_cost);
      return {
        ...holding,
        avgCost,
        invested: avgCost * qty,
        costSource: 'orders',
      };
    }

    return holding;
  }

  const currentHoldingsWithScores = mergeRecomputedScores(
    deriveCurrentHoldings(currentSnapshots).map(injectCostBasis),
    storedScores
  );
  const currentHoldings = await Promise.all(currentHoldingsWithScores.map(async (holding) => {
    // Mark suspended / unlisted / untradeable stocks so the UI can filter them out
    if (SKIP_SYMBOLS.has(holding.symbol)) {
      return {
        ...holding,
        tradeable: false,
        note: 'Suspended or unlisted — no market data available',
        momentumMetrics: {
          dma50: null,
          dma200: null,
          cmpVs50DmaPct: null,
          cmpVs200DmaPct: null,
          high52Week: null,
          distanceFrom52WeekHighPct: null,
          return3M: null,
          trendStatus: 'Not tradeable',
          asOf: '',
        },
      };
    }

    // Translate ICICI broker code → NSE ticker before calling market APIs
    const nseSymbol = resolveNseSymbol(holding.symbol);
    try {
      const momentum = await nseService.fetchMomentumSnapshot(nseSymbol);
      // Use the live price for valuation when the snapshot has no price (e.g. Breeze
      // demat holdings report qty but no LTP). This keeps Current Value — and hence
      // portfolio weights — accurate even without broker cost basis.
      const livePrice    = Number(momentum.currentPrice || 0);
      const haveSnapLtp  = Number(holding.ltp || 0) > 0;
      const ltp          = haveSnapLtp ? holding.ltp : (livePrice || holding.ltp);
      const currentValue = (ltp > 0 && holding.quantity > 0) ? holding.quantity * ltp : holding.currentValue;
      const invested     = Number(holding.invested || 0);
      const pnl          = invested > 0 ? currentValue - invested : null;   // null = no cost basis
      return {
        ...holding,
        tradeable: true,
        nseSymbol,
        ltp,
        currentValue,
        pnl,
        priceSource: haveSnapLtp ? 'broker' : (livePrice ? 'live' : 'none'),
        momentumMetrics: {
          dma50: momentum.dma50,
          dma200: momentum.dma200,
          cmpVs50DmaPct: momentum.cmpVs50DmaPct,
          cmpVs200DmaPct: momentum.cmpVs200DmaPct,
          high52Week: momentum.high52Week,
          distanceFrom52WeekHighPct: momentum.distanceFrom52WeekHighPct,
          return3M: momentum.return3M,
          trendStatus: momentum.trendStatus,
          // EMA trend metrics (Action Queue early triggers + ladder badge)
          emaLadder: momentum.emaLadder ?? null,
          ema50SlopePct: momentum.ema50SlopePct ?? null,
          cmpVs20EmaPct: momentum.cmpVs20EmaPct ?? null,
          cmpVs50EmaPct: momentum.cmpVs50EmaPct ?? null,
          ema20Below50: momentum.ema20Below50 ?? null,
          daysBelow20Ema: momentum.daysBelow20Ema ?? null,
          daysBelow50Ema: momentum.daysBelow50Ema ?? null,
          asOf: momentum.asOf || '',
        },
      };
    } catch (error) {
      return {
        ...holding,
        tradeable: true,
        nseSymbol,
        momentumMetrics: {
          dma50: null,
          dma200: null,
          cmpVs50DmaPct: null,
          cmpVs200DmaPct: null,
          high52Week: null,
          distanceFrom52WeekHighPct: null,
          return3M: null,
          trendStatus: 'Data unavailable',
          asOf: '',
          error: error.message,
        },
      };
    }
  }));
  // Tag each holding with its current Nifty 500 rank (same trend-filtered ranked
  // list that powers the Daily Top 25). Lazy require avoids a circular import
  // (universeScannerService imports resolveNseSymbol from this module).
  try {
    const { getRankMap } = require('../universe/universeScannerService');
    const { ranks, total, scanDate } = await getRankMap();
    for (const h of currentHoldings) {
      const key = String(h.nseSymbol || resolveNseSymbol(h.symbol) || h.symbol).toUpperCase();
      h.n500Rank  = ranks[key] ?? null;
      h.n500Total = total || null;
      h.n500ScanDate = scanDate || null;
    }
  } catch { /* rank tagging is best-effort */ }

  // holding_scores (the manual "Refresh Scores" pipeline) can go stale for weeks
  // per portfolio, while the daily universe scan (NIFTY500/MIDCAP/SMALLCAP/MICROCAP)
  // runs every evening automatically. Backfill technical/fundamental/momentum/
  // combined for any holding still showing "pending" from the freshest scan that
  // covers it, so the score/exit-signal logic isn't working off stale-or-missing data.
  try {
    const universeScoresRepository = require('../../repositories/universeScoresRepository');
    const UNIVERSE_PRIORITY = ['NIFTY500', 'MIDCAP', 'SMALLCAP', 'MICROCAP'];
    const byUniverse = {};
    for (const universe of UNIVERSE_PRIORITY) {
      const [scanDate] = await universeScoresRepository.latestScanDates(1, universe);
      if (!scanDate) continue;
      const rows = await universeScoresRepository.listScanRows(scanDate, universe);
      const map = new Map();
      for (const r of rows) map.set(String(r.symbol).toUpperCase(), { ...r, scanDate });
      byUniverse[universe] = map;
    }
    for (const h of currentHoldings) {
      const key = String(h.nseSymbol || resolveNseSymbol(h.symbol) || h.symbol).toUpperCase();
      let hit = null, fromUniverse = null;
      for (const universe of UNIVERSE_PRIORITY) {
        const row = byUniverse[universe]?.get(key);
        if (row) { hit = row; fromUniverse = universe; break; }
      }
      // Company name: the daily universe scan is refreshed every evening and has
      // been more reliable than holding_scores.name (which has had stale runs
      // that stored the raw broker code as "name" instead of the real company
      // name) — so prefer it whenever the scan covers this symbol, regardless
      // of which source ends up supplying the actual score below.
      if (hit?.name && hit.name.toUpperCase() !== key) h.name = hit.name;

      if (h.scores?.status !== 'pending') continue;   // already has real holding_scores data
      if (!hit || hit.combined_score == null) continue;
      h.scores = {
        momentum:    { value: Number(hit.momentum_score || 0),    label: labelScore(Number(hit.momentum_score || 0)) },
        fundamental: { value: Number(hit.fundamental_score || 0), label: labelScore(Number(hit.fundamental_score || 0)) },
        technical:   { value: Number(hit.technical_score || 0),   label: labelScore(Number(hit.technical_score || 0)) },
        combined:    { value: Number(hit.combined_score || 0),    label: labelScore(Number(hit.combined_score || 0)) },
        status: 'universe-scan-fallback',
        scoreSource: fromUniverse,
        scoreAsOf: hit.scanDate,
      };
    }
  } catch { /* backfill is best-effort */ }

  const latestSummary = buildLatestSummary(portfolio || '', summaries);

  const scoreSummary = currentHoldings.reduce(
    (accumulator, holding) => {
      accumulator.total += 1;
      accumulator.momentumAverage += holding.scores.momentum.value;
      accumulator.fundamentalAverage += holding.scores.fundamental.value;
      accumulator.technicalAverage += holding.scores.technical.value;
      accumulator.combinedAverage += holding.scores.combined.value;
      if (holding.scores.status === 'migrated' || holding.scores.status === 'recomputed') {
        accumulator.scored += 1;
      }
      return accumulator;
    },
    {
      total: 0,
      scored: 0,
      momentumAverage: 0,
      fundamentalAverage: 0,
      technicalAverage: 0,
      combinedAverage: 0,
    }
  );

  if (scoreSummary.total > 0) {
    scoreSummary.momentumAverage /= scoreSummary.total;
    scoreSummary.fundamentalAverage /= scoreSummary.total;
    scoreSummary.technicalAverage /= scoreSummary.total;
    scoreSummary.combinedAverage /= scoreSummary.total;
  }

  return {
    selectedPortfolio: portfolio || 'All',
    scoreDate: scoreDates.length === 1 ? scoreDates[0] : (scoreDates[0] || null),
    scoreDates,
    latestSummary,
    summaries,
    snapshots: parsedSnapshots.slice(0, 5),
    currentHoldings,
    scoreSummary,
  };
}

/**
 * Point-in-time portfolio report as of a given snapshot date. Uses the prices
 * stored in that date's snapshot (no live calls), so it reflects the portfolio
 * exactly as it stood then — with each stock's day-change on that date.
 */
async function getAsOfReport(portfolio, date) {
  const availableDates = await portfolioRepository.listSnapshotDates(portfolio || '');
  const targetDate = (date && availableDates.includes(date)) ? date : (availableDates[0] || null);
  if (!targetDate) return { date: null, availableDates, portfolios: [] };

  let names;
  if (portfolio) {
    names = [portfolio];
  } else {
    const snaps = await portfolioRepository.listPortfolioSnapshots('', 100);
    names = [...new Set(snaps.filter((s) => s.snapshot_date === targetDate).map((s) => s.portfolio))];
  }

  const portfolios = [];
  for (const name of names) {
    const snap = await portfolioRepository.getPortfolioSnapshot(name, targetDate);
    if (!snap) continue;
    let payload;
    try { payload = JSON.parse(snap.payload_json); } catch { payload = null; }
    const rawHoldings = payload?.portfolio || [];
    const holdings = rawHoldings.map((h) =>
      buildHoldingFromSnapshot({ portfolio: name, snapshot_date: targetDate }, h)
    );
    const value    = holdings.reduce((s, h) => s + (h.currentValue || 0), 0);
    const invested = holdings.reduce((s, h) => s + (h.invested || 0), 0);
    const pnl      = holdings.reduce((s, h) => s + (h.pnl || 0), 0);
    const dc = dayChangeFromPayload(payload);
    portfolios.push({
      portfolio: name,
      holdings: holdings.map((h) => ({
        symbol: h.symbol, sector: h.sector, quantity: h.quantity,
        avgCost: h.avgCost, ltp: h.ltp, invested: h.invested,
        currentValue: h.currentValue, pnl: h.pnl,
        dayChangePct: h.dayChangePct, netChangePct: h.netChangePct,
      })),
      totals: { invested, value, pnl, dayPct: dc.dayPct, dayValue: dc.dayValue },
    });
  }
  return { date: targetDate, availableDates, portfolios };
}

/**
 * Returns a lightweight per-portfolio breakdown with live-computed values.
 * Called by the dashboard to show correct invested/value even for Breeze portfolios.
 * We call getPortfolioOverview for each known portfolio and aggregate.
 */
async function getLiveBreakdown() {
  const snapshots = await portfolioRepository.listPortfolioSnapshots('', 20);
  const parsed = snapshots.map(parseSnapshotPayload);
  const seen = new Set();
  const portfolioNames = [];
  for (const s of parsed) {
    if (s.portfolio && !seen.has(s.portfolio)) {
      portfolioNames.push(s.portfolio);
      seen.add(s.portfolio);
    }
  }

  const results = await Promise.all(
    portfolioNames.map(async (p) => {
      try {
        const overview = await getPortfolioOverview(p);
        const holdings = overview.currentHoldings.filter((h) => h.tradeable !== false);
        const totalValue = holdings.reduce((s, h) => s + (Number(h.currentValue) || 0), 0);
        const totalInvested = holdings.reduce((s, h) => s + (Number(h.invested) || 0), 0);
        const stockCount = holdings.filter((h) => Number(h.quantity) > 0).length;
        const costSources = [...new Set(holdings.map((h) => h.costSource).filter(Boolean))];
        return {
          portfolio: p,
          total_value: totalValue,
          total_invested: totalInvested,
          stock_count: stockCount,
          cost_sources: costSources,
          invested_complete: holdings.filter((h) => Number(h.quantity) > 0).every((h) => Number(h.invested) > 0),
        };
      } catch (err) {
        return { portfolio: p, error: err.message };
      }
    })
  );

  return results;
}

// Currently-held symbols per portfolio, computed LIVE from the orders table (net BUY -
// SELL qty > 0) — never stale, unlike the qty field in a saved portfolio_snapshots row,
// which only updates when holdings are next fetched/uploaded. A stock sold 2 days ago
// can still show qty > 0 in the latest snapshot if nobody's re-saved holdings since; this
// is the source of truth to cross-check against before flagging something as "held" for
// the Dashboard's Exit Candidates / Action Queue (a false alarm on an already-sold stock
// is worse than a slightly slow-to-appear new one).
async function getHeldSymbolsFromOrders() {
  const portfolios = PF.ALL;
  const out = {};
  for (const p of portfolios) {
    const rows = await getAvgCostBySymbol(p);
    out[p] = [...new Set(rows.map((r) => (resolveNseSymbol(r.symbol) || r.symbol).toUpperCase()))];
  }
  return out;
}

// Currently-held symbols (+ full holding figures) per portfolio, from the latest
// broker-confirmed holdings SNAPSHOT (not reconstructed from orders) — the ground truth
// for "is this actually still in the demat account right now, and what's it actually
// worth." Unlike getHeldSymbolsFromOrders (FIFO/net-qty replay over the orders table),
// this is immune to order-history noise that doesn't perfectly net to zero — partial-fill
// rounding, a corporate action recorded outside the orders table, a stale/wrong broker
// code, or (critically) a STOCK SPLIT/BONUS that was never logged as an order at all,
// which leaves the orders table's raw historical quantities and prices unadjusted and
// no longer comparable to today's price. `holdingsBySymbol` carries the broker's own
// qty/avgCost/ltp/invested/currentValue/pnl — figures that already reflect whatever
// actually happened to the position — which callers should prefer over recomputing P&L
// from possibly split-unaware order history.
//
// Also returns each portfolio's snapshot date — a snapshot is only as fresh as the last
// holdings fetch/upload, so a stock bought AFTER that date won't be in it yet despite
// being a real, current position; callers should treat "not in the snapshot" as
// inconclusive (not "not held") for orders dated after asOf, and only trust an absence
// as "not held" for older orders.
async function getCurrentHoldingSymbols() {
  const portfolios = PF.ALL;
  const out = {};
  for (const p of portfolios) {
    const snapshots = await portfolioRepository.listPortfolioSnapshots(p, 1);
    const snapshot = snapshots[0] ? parseSnapshotPayload(snapshots[0]) : null;
    const holdings = (snapshot?.payload?.portfolio || []).filter((h) => Number(h.qty || 0) > 0);
    const holdingsBySymbol = {};
    for (const h of holdings) {
      const sym = (resolveNseSymbol(h.instrument) || h.instrument).toUpperCase();
      holdingsBySymbol[sym] = {
        quantity: Number(h.qty || 0),
        avgCost: Number(h.avgCost || 0),
        ltp: Number(h.ltp || 0),
        invested: Number(h.invested || 0),
        currentValue: h.curVal != null ? Number(h.curVal) : Number(h.qty || 0) * Number(h.ltp || 0),
        pnl: Number(h.pnl || 0),
      };
    }
    out[p] = {
      asOf: snapshot?.snapshot_date || null,
      symbols: Object.keys(holdingsBySymbol),
      holdingsBySymbol,
    };
  }
  return out;
}

// One symbol's position across BOTH portfolios, for the Stock Sleuth holdings box.
//
// Deliberately reuses getCurrentHoldingSymbols (latest snapshot, NSE-symbol resolved so a
// retired broker code still matches) and then applies the SAME cost-basis precedence as
// getPortfolioOverview — override, then orders-computed average, then whatever the snapshot
// carried. Recomputing cost by any other route here would let this box quietly disagree with
// the Portfolio page for holdings whose broker snapshot has no avgCost, which is exactly the
// kind of discrepancy that destroys trust in both numbers.
async function getHoldingForSymbol(symbol) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return { symbol: sym, held: false, positions: [] };

  const byPortfolio = await getCurrentHoldingSymbols();
  const positions = [];

  for (const [portfolio, data] of Object.entries(byPortfolio)) {
    const h = data.holdingsBySymbol?.[sym];
    if (!h || !(Number(h.quantity) > 0)) continue;

    let { avgCost, invested } = h;
    let costSource = 'broker';
    const qty = Number(h.quantity) || 0;

    if (!(Number(invested) > 0) || !(Number(avgCost) > 0)) {
      const override = (await getOverridesMap(portfolio))?.get(sym);
      if (override && Number(override.avg_cost) > 0) {
        avgCost = Number(override.avg_cost); invested = avgCost * qty; costSource = 'override';
      } else {
        const rows = await getAvgCostBySymbol(portfolio);
        const cb = rows.find((r) => (resolveNseSymbol(r.symbol) || r.symbol).toUpperCase() === sym);
        if (cb && Number(cb.avg_cost) > 0) {
          avgCost = Number(cb.avg_cost); invested = avgCost * qty; costSource = 'orders';
        }
      }
    }

    const currentValue = Number(h.currentValue) || qty * Number(h.ltp || 0);
    // P&L is recomputed from cost rather than taken from the broker's own pnl field: when the
    // cost came from orders or an override, the broker's figure was derived from a cost basis
    // it did not have, so the two would not agree.
    const cost = Number(invested) > 0 ? Number(invested) : null;
    const pnl = cost != null ? currentValue - cost : null;

    positions.push({
      portfolio,
      asOf: data.asOf || null,
      quantity: qty,
      avgCost: Number(avgCost) > 0 ? Number(avgCost) : null,
      ltp: Number(h.ltp) || null,
      invested: cost,
      currentValue,
      pnl,
      pnlPct: cost ? Math.round((pnl / cost) * 10000) / 100 : null,
      costSource,
    });
  }

  if (!positions.length) return { symbol: sym, held: false, positions: [] };

  const sum = (f) => positions.reduce((s, p) => s + (Number(p[f]) || 0), 0);
  const investedTotal = positions.every((p) => p.invested == null) ? null : sum('invested');
  const valueTotal = sum('currentValue');

  return {
    symbol: sym,
    held: true,
    positions,
    total: {
      quantity: sum('quantity'),
      invested: investedTotal,
      currentValue: valueTotal,
      pnl: investedTotal != null ? valueTotal - investedTotal : null,
      pnlPct: investedTotal ? Math.round(((valueTotal - investedTotal) / investedTotal) * 10000) / 100 : null,
      // Flagged so the UI can say the cost is incomplete rather than implying a precise P&L.
      costIncomplete: positions.some((p) => p.invested == null),
    },
  };
}

// FIFO lot matching, per (portfolio, resolved NSE symbol) — same approach as
// pickerMatchService's _computeOpenLotRemaining, reused here because holding period
// has the identical "two different broker codes for the same real stock" problem: a
// symbol's raw order code can change over time (e.g. HDFAMC -> HDFCAMC), so matching
// lots by the CURRENT holding's raw symbol alone silently misses older buys under a
// since-retired code and understates (or nulls out) how long the position's been held.
function _computeOpenLotDates(resolvedOrders) {
  const sorted = [...resolvedOrders].sort((a, b) =>
    (a.trade_date || '').localeCompare(b.trade_date || '') || (a.id - b.id));

  const lotsByKey = new Map();   // `${portfolio}::${nseSymbol}` -> [{date, qty}, ...] (FIFO order)
  for (const o of sorted) {
    const key = `${o.portfolio}::${o.nseSymbol}`;
    if (!lotsByKey.has(key)) lotsByKey.set(key, []);
    const lots = lotsByKey.get(key);
    const qty = Number(o.quantity || 0);
    const side = String(o.side || '').toUpperCase();

    if (side === 'BUY' || side === 'B') {
      lots.push({ date: o.trade_date, qty });
    } else if (side === 'SELL' || side === 'S') {
      let remaining = qty;
      while (remaining > 0 && lots.length > 0) {
        if (lots[0].qty <= remaining) { remaining -= lots[0].qty; lots.shift(); }
        else { lots[0].qty -= remaining; remaining = 0; }
      }
    }
  }

  const earliestByKey = {};
  for (const [key, lots] of lotsByKey) {
    if (lots.length) earliestByKey[key] = lots.reduce((a, b) => (a.date < b.date ? a : b)).date;
  }
  return earliestByKey;
}

// Earliest still-open buy date per (portfolio, resolved NSE symbol) — "how long have
// I actually held this" for currently-open positions, resolved across any broker-code
// changes over the stock's order history (see _computeOpenLotDates above).
async function getHoldingPeriods() {
  const db = openDatabase();
  try {
    const allOrdersRaw = await allAsync(
      db,
      `SELECT id, trade_date, portfolio, symbol, side, quantity, exchange FROM orders`,
    );
    const resolved = allOrdersRaw
      .filter((o) => !isFno(o))
      .map((o) => ({ ...o, nseSymbol: (resolveNseSymbol(o.symbol) || o.symbol).toUpperCase() }));
    return _computeOpenLotDates(resolved);   // `${portfolio}::${nseSymbol}` -> earliest open-lot date
  } finally {
    await closeAsync(db);
  }
}

module.exports = {
  getPortfolioOverview,
  getAsOfReport,
  getLiveBreakdown,
  getHeldSymbolsFromOrders,
  getCurrentHoldingSymbols,
  getHoldingForSymbol,
  getHoldingPeriods,
  resolveNseSymbol,
  deadScripInfo,
  DEAD_SCRIPS,
};
