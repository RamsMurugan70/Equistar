// NIFTY 500 daily scanner — runs nifty500_scanner.py (same scoring functions as
// Portfolio Health), stores results in universe_scores, serves the Top-20 list.
const { execFile } = require('child_process');
const path = require('path');
const universeScoresRepository = require('../../repositories/universeScoresRepository');
const portfolioRepository = require('../../repositories/portfolioRepository');
const { resolveNseSymbol } = require('../portfolio/portfolioService');
const { openDatabase, allAsync, closeAsync } = require('../../db/connection');
const { ownsMarketData } = require('../../db/marketSchema');

const ENGINES = require('../../config/engines');

// Every universe this service can scan. NIFTY500 uses the original dedicated
// script; MIDCAP/SMALLCAP/MICROCAP share capscanner.py via --universe.
const UNIVERSES = ['NIFTY500', 'MIDCAP', 'SMALLCAP', 'MICROCAP'];
function _scriptArgs(universe) {
  if (universe === 'NIFTY500') return { script: 'nifty500_scanner.py', extraArgs: [] };
  const key = { MIDCAP: 'midcap', SMALLCAP: 'smallcap', MICROCAP: 'microcap' }[universe];
  if (!key) throw new Error(`Unknown universe "${universe}"`);
  return { script: 'capscanner.py', extraArgs: ['--universe', key] };
}

const QUALIFYING_LADDERS = new Set(['STRONG_UPTREND', 'PULLBACK']);
const TOP_N = 25;   // size of the daily ranked list (panel + frozen snapshot)

// Shared ranking rule: qualifying trend, sorted by combined score.
function _rankRows(rows) {
  return rows
    .filter((r) => r.combined_score != null && QUALIFYING_LADDERS.has(r.ema_ladder))
    .sort((a, b) => b.combined_score - a.combined_score);
}

// Freeze the day's Top-N and Bottom-N into their respective daily tables.
async function persistDailyTop(scanDate, universe = 'NIFTY500') {
  const rows = await universeScoresRepository.listScanRows(scanDate, universe);
  const ranked = _rankRows(rows);
  const total  = ranked.length;

  const top = ranked.slice(0, TOP_N).map((r, i) => ({ ...r, rank: i + 1 }));
  await universeScoresRepository.replaceDailyTop(scanDate, top, universe);

  // Bottom 25: worst-ranked (lowest scores), stored with rank counting from bottom
  const bottom = ranked.slice(-TOP_N).reverse().map((r, i) => ({ ...r, rank: i + 1 }));
  await universeScoresRepository.replaceBottomDaily(scanDate, bottom, universe);

  return top.length;
}

// ── Scan state (in-memory; per universe) ──────────────────────────────────────
const scanStates = Object.fromEntries(UNIVERSES.map((u) => [u,
  { running: false, startedAt: null, lastError: null, lastFinishedAt: null, trigger: null }]));

function getScanStatus(universe = 'NIFTY500') {
  // `canScan` tells the page whether to offer the button at all. A participant's instance reads
  // the shared market file but must not write it, and a button that always fails is worse than
  // no button — it reads as the app being broken.
  return { ...scanStates[universe], canScan: ownsMarketData() };
}

function _runScanner(script, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      ENGINES.python, [script, ...args],
      { cwd: ENGINES.dir, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const marker = 'SCAN_JSON:';
        const idx = (stdout || '').lastIndexOf(marker);
        if (idx === -1) {
          return reject(new Error(error ? `Scanner failed: ${error.message}` : `No JSON in scanner output. ${String(stderr).slice(0, 200)}`));
        }
        try {
          resolve(JSON.parse(stdout.slice(idx + marker.length)));
        } catch (e) {
          reject(new Error(`Scanner JSON parse failed: ${e.message}`));
        }
      }
    );
  });
}

async function runScan({ refreshFundamentals = false, trigger = 'manual', universe = 'NIFTY500' } = {}) {
  // ONLY THE PROCESS THAT OWNS THE MARKET FILE MAY SCAN INTO IT.
  //
  // A participant's instance ATTACHes market.db, so its unqualified writes land in the SHARED
  // file — replaceScanRows would DELETE that day's rows for all twenty-five people and refill
  // them from its own run. Worse, each scan is five hundred requests to Yahoo from one server
  // address; a handful of participants pressing the same button gets that address rate-limited
  // and leaves everybody's Top 25 and Industry Scorecard empty at once.
  //
  // The hub's scanner runs with MARKET_DB_PATH unset — market.db IS its main database — so it
  // owns the data and passes. The same predicate already decides who may create these tables.
  if (!ownsMarketData()) {
    throw Object.assign(
      new Error('The scan is run once for everyone by the admin, not per participant. '
        + 'Ask them to run it from the admin page; the result appears here as soon as it lands.'),
      { code: 'SCAN_NOT_OWNER' });
  }
  if (!UNIVERSES.includes(universe)) throw new Error(`Unknown universe "${universe}"`);
  if (scanStates[universe].running) throw new Error(`A ${universe} scan is already running.`);
  scanStates[universe] = { ...scanStates[universe], running: true, startedAt: new Date().toISOString(), lastError: null, trigger };
  try {
    const { script, extraArgs } = _scriptArgs(universe);
    const args = ['--json', ...extraArgs];
    if (refreshFundamentals) args.push('--refresh-fundamentals');
    // Fundamentals crawl can take ~60 min on stale weeks; price-only ~10 min.
    const result = await _runScanner(script, args, 100 * 60 * 1000);
    await universeScoresRepository.replaceScanRows(result.scanDate, result.rows || [], universe);
    await persistDailyTop(result.scanDate, universe);   // freeze the day's official Top 25
    scanStates[universe] = {
      ...scanStates[universe], running: false, lastFinishedAt: new Date().toISOString(),
      lastScanDate: result.scanDate, lastScored: result.scored,
      fundamentalsAsOf: result.fundamentalsAsOf, fundamentalsCoverage: result.fundamentalsCoverage,
    };
    return { ok: true, universe, scanDate: result.scanDate, scored: result.scored,
             fundamentalsAsOf: result.fundamentalsAsOf, fundamentalsCoverage: result.fundamentalsCoverage };
  } catch (e) {
    scanStates[universe] = { ...scanStates[universe], running: false, lastError: e.message };
    throw e;
  }
}

// ── Held-by lookup: NSE symbol → portfolios that hold it ─────────────────────
// Primary source: latest portfolio snapshot per portfolio.
// Fallback: orders table — any symbol with net buy qty > 0 that isn't already
// covered by a snapshot (catches same-day buys before a snapshot is saved).
async function _heldBySymbol() {
  const held = new Map();
  const snapshotCoveredPortfolios = new Set();
  try {
    const snapshots = await portfolioRepository.listPortfolioSnapshots('', 20);
    const seen = new Set();
    for (const snap of snapshots) {
      if (seen.has(snap.portfolio)) continue;
      seen.add(snap.portfolio);
      snapshotCoveredPortfolios.add(snap.portfolio);
      let payload;
      try { payload = JSON.parse(snap.payload_json); } catch { continue; }
      for (const h of (payload?.portfolio || [])) {
        const raw = h.instrument || h.symbol || '';
        if (!raw) continue;
        const nse = resolveNseSymbol(raw) || raw;
        if (!held.has(nse)) held.set(nse, new Set());
        held.get(nse).add(snap.portfolio);
      }
    }
  } catch { /* snapshots are best-effort */ }

  // Fallback: derive net holdings from orders for any portfolio that has a snapshot
  // (to catch same-day buys not yet in the snapshot) and portfolios with no snapshot.
  const db = openDatabase();
  try {
    const netRows = await allAsync(db,
      `SELECT portfolio, symbol,
              SUM(CASE WHEN UPPER(side) IN ('BUY','B') THEN quantity ELSE 0 END) -
              SUM(CASE WHEN UPPER(side) IN ('SELL','S') THEN quantity ELSE 0 END) AS net_qty
         FROM orders
        WHERE UPPER(side) IN ('BUY','B','SELL','S')
        GROUP BY portfolio, symbol
       HAVING net_qty > 0`
    );
    for (const row of netRows) {
      const nse = resolveNseSymbol(row.symbol) || row.symbol;
      // For portfolios with snapshots: only add if the symbol wasn't in the snapshot
      // (the snapshot is authoritative for existing holdings; orders fill the gap for new buys)
      if (snapshotCoveredPortfolios.has(row.portfolio)) {
        if (!held.has(nse) || !held.get(nse).has(row.portfolio)) {
          if (!held.has(nse)) held.set(nse, new Set());
          held.get(nse).add(row.portfolio);
        }
      } else {
        // No snapshot for this portfolio — use orders as the sole source
        if (!held.has(nse)) held.set(nse, new Set());
        held.get(nse).add(row.portfolio);
      }
    }
  } catch { /* orders fallback is best-effort */ }
  finally { try { closeAsync(db); } catch {} }

  return held;
}

// ── Public: full rank map (NSE symbol → rank) across the qualifying universe ──
// Rank is the stock's position in the same trend-filtered, score-sorted list that
// powers the "Nifty 500 Daily Top 25". Non-qualifying stocks (not in a healthy
// trend) get no rank. Used to tag portfolio holdings with their current rank.
async function getRankMap(universe = 'NIFTY500') {
  const dates = await universeScoresRepository.latestScanDates(1, universe);
  if (!dates.length) return { scanDate: null, ranks: {}, total: 0 };
  const scanDate = dates[0];
  const rows   = await universeScoresRepository.listScanRows(scanDate, universe);
  const ranked = _rankRows(rows);
  const ranks  = {};
  ranked.forEach((r, i) => { ranks[String(r.symbol).toUpperCase()] = i + 1; });
  return { scanDate, ranks, total: ranked.length };
}

// ── Public: FULL rank map — every scored stock ranked 1..N by combined score ──
// Not trend-filtered, so a stock in any trend gets its true position in the full
// Nifty 500 scan (e.g. Wipro #401). Used to tag external picks with their rank.
const _normName = (s) => String(s || '').toUpperCase()
  .replace(/\b(LTD|LIMITED|CORPORATION|CORP|COMPANY|CO|INDIA|INDIAN|THE|AND|&)\b/g, '')
  .replace(/[^A-Z0-9]/g, '');

async function getFullRankMap(universe = 'NIFTY500') {
  const dates = await universeScoresRepository.latestScanDates(1, universe);
  if (!dates.length) return { scanDate: null, ranks: {}, names: {}, total: 0 };
  const scanDate = dates[0];
  const rows = await universeScoresRepository.listScanRows(scanDate, universe);
  const ranked = rows
    .filter((r) => r.combined_score != null)
    .sort((a, b) => b.combined_score - a.combined_score);
  const ranks = {};
  const names = {};   // normalized company name → NSE symbol (for BSE/name-only picks)
  ranked.forEach((r, i) => {
    const sym = String(r.symbol).toUpperCase();
    ranks[sym] = i + 1;
    names[_normName(r.symbol)] = sym;
    if (r.name) names[_normName(r.name)] = sym;
  });
  return { scanDate, ranks, names, total: ranked.length };
}

// ── Public: Top-N (score-ranked, trend-filtered) with movement + held tags ────
async function getTopList(limit = TOP_N, universe = 'NIFTY500') {
  const dates = await universeScoresRepository.latestScanDates(2, universe);
  if (!dates.length) return { ok: true, scanDate: null, rows: [], status: getScanStatus(universe) };

  const [latest, prev] = dates;
  const rows = await universeScoresRepository.listScanRows(latest, universe);
  const prevRows = prev ? await universeScoresRepository.listScanRows(prev, universe) : [];

  const ranked     = _rankRows(rows);
  const prevRanked = _rankRows(prevRows);
  const prevRankBySym = new Map(prevRanked.map((r, i) => [r.symbol, i + 1]));

  const held = await _heldBySymbol();

  const top = ranked.slice(0, limit).map((r, i) => ({
    rank: i + 1,
    symbol: r.symbol,
    name: r.name,
    industry: r.industry,
    cmp: r.cmp,
    technical: r.technical_score,
    fundamental: r.fundamental_score,
    momentum: r.momentum_score,
    combined: r.combined_score,
    rsi: r.rsi, r1w: r.r1w, r1m: r.r1m, r3m: r.r3m, r6m: r.r6m,
    emaLadder: r.ema_ladder, ema50Slope: r.ema50_slope,
    components: r.components,
    prevRank: prevRankBySym.get(r.symbol) ?? null,
    isNew: prev ? !prevRankBySym.has(r.symbol) : false,
    heldBy: [...(held.get(r.symbol) || [])],
  }));

  // Held holdings that QUALIFY (healthy trend) but rank outside the Top-N —
  // "how close are my own stocks to the list".
  const heldNearMiss = ranked
    .map((r, i) => ({ r, rank: i + 1 }))
    .filter((x) => x.rank > limit && held.has(x.r.symbol))
    .slice(0, 8)
    .map((x) => ({
      rank: x.rank,
      symbol: x.r.symbol,
      name: x.r.name,
      combined: x.r.combined_score,
      emaLadder: x.r.ema_ladder,
      heldBy: [...(held.get(x.r.symbol) || [])],
    }));

  return {
    ok: true,
    universe,
    scanDate: latest,
    prevScanDate: prev || null,
    universeScored: rows.length,
    qualifying: ranked.length,
    fundamentalsAsOf: scanStates[universe].fundamentalsAsOf || null,
    fundamentalsPending: rows.length > 0 && rows.every((r) => r.fundamental_score == null),
    rows: top,
    heldNearMiss,
    status: getScanStatus(universe),
  };
}

// ── Scheduler: auto-scan at 18:30 IST on trading days ────────────────────────
function _istNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  if (p.hour === '24') p.hour = '00';
  return p;
}

// Each universe gets its own daily slot (offset 15 min apart) so their scans
// don't compete for CPU / yfinance rate limits. NIFTY500 keeps its original 18:30.
const SCHEDULE_SLOTS = {
  NIFTY500:  { h: 18, m: 30 },
  MIDCAP:    { h: 18, m: 45 },
  SMALLCAP:  { h: 19, m: 0  },
  MICROCAP:  { h: 19, m: 15 },
};

function _scheduleOne(universe) {
  const { h: SCAN_H, m: SCAN_M } = SCHEDULE_SLOTS[universe];

  // Lazy catch-up on boot: weekday, past scan time, no scan stored for today.
  (async () => {
    try {
      const p = _istNow();
      const today = `${p.year}-${p.month}-${p.day}`;
      const isWeekday = !['Sat', 'Sun'].includes(p.weekday);
      const pastTime = (+p.hour) * 60 + (+p.minute) >= SCAN_H * 60 + SCAN_M;
      if (isWeekday && pastTime) {
        const dates = await universeScoresRepository.latestScanDates(1, universe);
        if (!dates.length || dates[0] !== today) {
          console.log(`◇ ${universe} scan catch-up starting (missed today's ${SCAN_H}:${String(SCAN_M).padStart(2, '0')} run)...`);
          runScan({ trigger: 'startup-catchup', universe })
            .then((r) => console.log(`◇ ${universe} catch-up scan done: ${r.scored} scored.`))
            .catch((e) => console.error(`${universe} catch-up scan failed:`, e.message));
        }
      }
    } catch (e) { console.error(`${universe} catch-up check failed:`, e.message); }
  })();

  const schedule = () => {
    const p = _istNow();
    const nowMin = (+p.hour) * 60 + (+p.minute);
    let ms = ((SCAN_H * 60 + SCAN_M) - nowMin) * 60000;
    if (ms <= 0) ms += 24 * 3600 * 1000;
    setTimeout(async () => {
      try {
        const q = _istNow();
        if (!['Sat', 'Sun'].includes(q.weekday)) {
          console.log(`◇ ${universe} scheduled scan starting (${SCAN_H}:${String(SCAN_M).padStart(2, '0')} IST)...`);
          const r = await runScan({ trigger: 'scheduled', universe });
          console.log(`◇ ${universe} scheduled scan done: ${r.scored} scored.`);
        }
      } catch (e) { console.error(`${universe} scheduled scan failed:`, e.message); }
      schedule();
    }, ms);
  };
  schedule();
}

// No scheduler here. The scan writes shared market data that every instance reads, so it is the
// hub's job to run it once for everyone rather than 25 instances scanning the same 500 symbols
// in the same minute. runScan below is what the hub calls.
// Daily Top-25 history grouped by date — feed for weekly/monthly consistency
// reports ("which stocks stay in the Top 25 across days").
async function getTopHistory({ since = '', days = 60, universe = 'NIFTY500' } = {}) {
  const rows = await universeScoresRepository.listDailyTops(since, days, universe);
  const byDate = {};
  for (const r of rows) {
    (byDate[r.scan_date] = byDate[r.scan_date] || []).push({
      rank: r.rank, symbol: r.symbol, name: r.name, industry: r.industry,
      combined: r.combined_score, emaLadder: r.ema_ladder, cmp: r.cmp,
    });
  }
  const dates = Object.keys(byDate).sort().reverse();
  // Appearance counts across the window — the raw material for "consistent top 25"
  const counts = {};
  for (const d of dates) for (const r of byDate[d]) counts[r.symbol] = (counts[r.symbol] || 0) + 1;
  return { ok: true, days: dates.length, dates, byDate, appearanceCounts: counts };
}

// Consistency view: stocks present in EVERY daily Top-25 over the last
// 2 / 5 / 15 / 22 (≈1 month) stored scan days.
const CONSISTENCY_WINDOWS = [
  { key: '2d',  days: 2,  label: '2 days' },
  { key: '5d',  days: 5,  label: '5 days' },
  { key: '15d', days: 15, label: '15 days' },
  { key: '1m',  days: 22, label: '1 month' },
];

async function getConsistentTops(universe = 'NIFTY500') {
  const rows = await universeScoresRepository.listDailyTops('', 60, universe);
  const byDate = {};
  for (const r of rows) (byDate[r.scan_date] = byDate[r.scan_date] || []).push(r);
  const dates = Object.keys(byDate).sort().reverse();   // newest first

  const windows = CONSISTENCY_WINDOWS.map((w) => {
    if (dates.length < w.days) {
      return { ...w, available: false, have: dates.length, rows: [] };
    }
    const windowDates = dates.slice(0, w.days);
    // Start from the newest day's list, keep symbols present on every day
    let candidates = new Map(byDate[windowDates[0]].map((r) => [r.symbol, [r]]));
    for (const d of windowDates.slice(1)) {
      const daySet = new Map(byDate[d].map((r) => [r.symbol, r]));
      const next = new Map();
      for (const [sym, hist] of candidates) {
        if (daySet.has(sym)) next.set(sym, [...hist, daySet.get(sym)]);
      }
      candidates = next;
    }
    const out = [...candidates.entries()].map(([sym, hist]) => {
      const latest = hist[0];
      const ranks = hist.map((h) => h.rank);
      return {
        symbol: sym,
        name: latest.name,
        latestRank: latest.rank,
        latestScore: latest.combined_score,
        emaLadder: latest.ema_ladder,
        avgRank: Math.round((ranks.reduce((a, b) => a + b, 0) / ranks.length) * 10) / 10,
        bestRank: Math.min(...ranks),
        worstRank: Math.max(...ranks),
      };
    }).sort((a, b) => a.avgRank - b.avgRank);
    return { ...w, available: true, have: w.days, from: windowDates[w.days - 1], to: windowDates[0], rows: out };
  });

  return { ok: true, daysStored: dates.length, latestDate: dates[0] || null, windows };
}

// Position lookup for one stock across recent scan days.
async function getStockPosition(symbolRaw, days = 22, universe = 'NIFTY500') {
  const { resolveNseSymbol } = require('../portfolio/portfolioService');
  const nseService = require('../market/nseService');
  const symbol = resolveNseSymbol(String(symbolRaw || '').trim().toUpperCase());
  if (!symbol) throw new Error('Symbol is required.');
  const hist = await universeScoresRepository.stockHistory(symbol, days, universe);
  const daysInTop = hist.filter((h) => h.top25_rank != null).length;
  const uniRanks = hist.map((h) => h.uni_rank).filter((n) => n != null);
  // hist is DESC by scan_date, so hist[0] = latest scan, hist[1] = the scan before it.
  const latest = hist[0] || null;
  const prev   = hist[1] || null;

  // Live "as of right now" snapshot for the report's header — current price, where it
  // sits vs 50/200 DMA and the 52-week range, and the EMA trend read, all independent
  // of the daily scan cadence (a scan is at most a day old; this is live/near-live).
  // Best-effort: the report is still useful with just the scan-history rows if this fails.
  let liveSnapshot = null;
  try {
    const snap = await nseService.fetchMomentumSnapshot(symbol);
    liveSnapshot = {
      currentPrice: snap.currentPrice, asOf: snap.asOf,
      dma50: snap.dma50, dma200: snap.dma200,
      cmpVs50DmaPct: snap.cmpVs50DmaPct, cmpVs200DmaPct: snap.cmpVs200DmaPct,
      high52Week: snap.high52Week, distanceFrom52WeekHighPct: snap.distanceFrom52WeekHighPct,
      low52Week: snap.low52Week, distanceFrom52WeekLowPct: snap.distanceFrom52WeekLowPct,
      return3M: snap.return3M, trendStatus: snap.trendStatus,
      emaLadder: snap.emaLadder, ema50SlopePct: snap.ema50SlopePct,
    };
  } catch (_e) { /* leave liveSnapshot null — scan-history rows still work */ }

  // GARCH(1,1) conditional volatility, plus where it stood 1/3/6 months ago. Best-effort and
  // fetched alongside everything else: a stock with too little history, or a fit that will not
  // converge, returns a reason rather than a number, and the rest of the report is unaffected.
  let garch = null;
  try {
    garch = await require('../market/garchService').getGarchVolatility(symbol);
  } catch (_e) { /* leave null — the volatility panel simply does not render */ }

  return {
    ok: true,
    symbol,
    universe,
    garch,
    name: latest?.name || null,
    industry: latest?.industry || null,
    daysCovered: hist.length,
    daysInTop25: daysInTop,
    top25Pct: hist.length ? Math.round((daysInTop / hist.length) * 100) : 0,
    bestUniRank:  uniRanks.length ? Math.min(...uniRanks) : null,
    worstUniRank: uniRanks.length ? Math.max(...uniRanks) : null,
    avgUniRank:   uniRanks.length ? Math.round(uniRanks.reduce((a, b) => a + b, 0) / uniRanks.length) : null,
    latest: latest ? {
      date: latest.scan_date,
      r1w: latest.r1w, r1m: latest.r1m, r3m: latest.r3m, r6m: latest.r6m,
      uniRank: latest.uni_rank,
      prevUniRank: prev ? prev.uni_rank : null,
      rsi: latest.rsi,
      combinedScore: latest.combined_score,
      technicalScore: latest.technical_score,
      fundamentalScore: latest.fundamental_score,
      momentumScore: latest.momentum_score,
    } : null,
    live: liveSnapshot,
    days: hist.map((h) => ({
      date: h.scan_date,
      top25Rank: h.top25_rank,
      uniRank: h.uni_rank,
      uniTotal: h.uni_total,
      score: h.combined_score,
      technicalScore: h.technical_score,
      fundamentalScore: h.fundamental_score,
      momentumScore: h.momentum_score,
      rsi: h.rsi,
      ema50Slope: h.ema50_slope,
      emaLadder: h.ema_ladder,
      cmp: h.cmp,
    })),
  };
}

module.exports = { runScan, getTopList, getRankMap, getFullRankMap, getScanStatus, persistDailyTop, getTopHistory, getConsistentTops, getStockPosition, UNIVERSES };
