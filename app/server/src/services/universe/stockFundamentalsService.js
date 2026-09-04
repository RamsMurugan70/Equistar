// Fundamentals + peer context for the Stock Sleuth report.
//
// Two very different sources, on purpose:
//
//   FUNDAMENTALS come from yfinance (scripts/fetch_fundamentals.py). Slow (~5-15s) and
//   network-bound, so they are CACHED — quarterly results move these numbers, not ticks.
//
//   PEER CONTEXT comes from universe_scores, which already carries an `industry` for every
//   scanned stock. That makes "how is this doing against its industry" a local query with no
//   external call and no lag — and it answers the question far better than a sector label
//   ever could: CUPID is #1 of 65 FMCG names on 3M against an industry median of -0.4%.
//
// NOT INCLUDED: FII/DII holdings. Yahoo gives one blended `heldPercentInstitutions` (0.55%
// for CUPID, empty holders table) with no foreign/domestic split and no history, and NSE's
// shareholding endpoints returned 404/403. Presenting that as "FII holding" would be
// fabrication, so it is surfaced only as a clearly-labelled blended figure.
const { execFile } = require('child_process');
const path = require('path');
const { openDatabase, allAsync, getAsync, runAsync, closeAsync } = require('../../db/connection');

const ENGINES = require('../../config/engines');
const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'fetch_fundamentals.py');
const SHP_SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'fetch_shareholding.py');
const CACHE_DAYS = 3;
// Shareholding is filed four times a year. A weekly refresh picks up a new quarter well
// inside its 21-day filing window while costing almost nothing.
const SHP_CACHE_DAYS = 7;

async function ensureSchema(db) {
  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS stock_fundamentals (
      symbol      TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      fetched_at  TEXT NOT NULL
    )`);
}

function runFetcher(symbol) {
  return new Promise((resolve, reject) => {
    // windowsHide keeps the console window from flashing up on Windows — without it every
    // lookup pops a cmd box in front of whatever the user is doing. Every other spawn in
    // this codebase already sets it; these two were the exception.
    execFile(ENGINES.python, [SCRIPT, symbol],
      { timeout: 90_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(new Error(`fundamentals fetch failed: ${err.message}`));
        try {
          // yfinance can emit warnings before the JSON; take from the first brace.
          const i = stdout.indexOf('{');
          if (i < 0) throw new Error('no JSON in output');
          resolve(JSON.parse(stdout.slice(i)));
        } catch (e) { reject(new Error(`fundamentals parse failed: ${e.message}`)); }
      });
  });
}

async function getFundamentals(symbol, { force = false } = {}) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return null;
  const db = openDatabase();
  try {
    await ensureSchema(db);
    if (!force) {
      const row = await getAsync(db, 'SELECT payload_json, fetched_at FROM stock_fundamentals WHERE symbol = ?', [sym]);
      if (row) {
        const ageDays = (Date.now() - new Date(row.fetched_at).getTime()) / 86400000;
        if (ageDays < CACHE_DAYS) {
          try { return { ...JSON.parse(row.payload_json), fetchedAt: row.fetched_at, cached: true }; }
          catch { /* refetch */ }
        }
      }
    }
  } finally { await closeAsync(db); }

  let data;
  try { data = await runFetcher(sym); }
  catch (e) { return { symbol: sym, error: e.message }; }
  if (!data || data.error) return { symbol: sym, error: data?.error || 'no data' };

  const db2 = openDatabase();
  try {
    await ensureSchema(db2);
    await runAsync(db2,
      `INSERT INTO stock_fundamentals (symbol, payload_json, fetched_at) VALUES (?,?,?)
       ON CONFLICT(symbol) DO UPDATE SET payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`,
      [sym, JSON.stringify(data), new Date().toISOString()]);
  } finally { await closeAsync(db2); }

  return { ...data, fetchedAt: new Date().toISOString(), cached: false };
}

// Quarterly shareholding: promoter, FII and DII, with the change over the last one and two
// quarters. Sourced from the company's own SEBI filing via NSE (see fetch_shareholding.py).
//
// CADENCE: these are filed quarterly, so "3 months" is one quarter's change and "6 months" is
// two. The deltas are labelled with the actual quarter-end dates they span rather than a bare
// "3M", because a filing can be late or a quarter skipped, and a delta whose endpoints are
// invisible is a number nobody can check.
function runShpFetcher(symbol) {
  return new Promise((resolve, reject) => {
    // Three quarters = current plus the two comparison points. Each XBRL is ~150KB and NSE is
    // slow, so this is given a generous timeout and then cached hard.
    execFile(ENGINES.python, [SHP_SCRIPT, symbol, '3'],
      { timeout: 150_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(new Error(`shareholding fetch failed: ${err.message}`));
        try {
          const i = stdout.indexOf('{');
          if (i < 0) throw new Error('no JSON in output');
          resolve(JSON.parse(stdout.slice(i)));
        } catch (e) { reject(new Error(`shareholding parse failed: ${e.message}`)); }
      });
  });
}

async function ensureShpSchema(db) {
  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS stock_shareholding (
      symbol       TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      fetched_at   TEXT NOT NULL
    )`);
}

function shpDeltas(quarters) {
  const q = (quarters || []).filter((r) => r && r.quarter);
  if (!q.length) return null;
  const latest = q[q.length - 1];
  const prev1 = q[q.length - 2] || null;   // one quarter back  ~ 3 months
  const prev2 = q[q.length - 3] || null;   // two quarters back ~ 6 months

  const d = (field, from) => {
    if (!from) return null;
    const a = from[field];
    const b = latest[field];
    if (a == null || b == null) return null;
    return Math.round((b - a) * 100) / 100;
  };
  const FIELDS = ['promoter', 'fii', 'dii', 'mutualFunds', 'insurance', 'nonInstitutions'];
  const pack = (from) => (from
    ? { since: from.quarter, ...Object.fromEntries(FIELDS.map((f) => [f, d(f, from)])) }
    : null);

  return {
    latest,
    quarters: q,
    change3m: pack(prev1),
    change6m: pack(prev2),
    // True when the breakdown came from XBRL; without it only promoter/public are known.
    hasDetail: !!latest.detail,
  };
}

async function getShareholding(symbol, { force = false } = {}) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return null;

  const db = openDatabase();
  try {
    await ensureShpSchema(db);
    if (!force) {
      const row = await getAsync(db, 'SELECT payload_json, fetched_at FROM stock_shareholding WHERE symbol = ?', [sym]);
      if (row) {
        const ageDays = (Date.now() - new Date(row.fetched_at).getTime()) / 86400000;
        if (ageDays < SHP_CACHE_DAYS) {
          try {
            const p = JSON.parse(row.payload_json);
            if (p.error) return { symbol: sym, error: p.error, fetchedAt: row.fetched_at };
            return { ...shpDeltas(p.quarters), fetchedAt: row.fetched_at, cached: true };
          } catch { /* refetch */ }
        }
      }
    }
  } finally { await closeAsync(db); }

  let data;
  try { data = await runShpFetcher(sym); }
  catch (e) { return { symbol: sym, error: e.message }; }

  const db2 = openDatabase();
  try {
    await ensureShpSchema(db2);
    await runAsync(db2,
      `INSERT INTO stock_shareholding (symbol, payload_json, fetched_at) VALUES (?,?,?)
       ON CONFLICT(symbol) DO UPDATE SET payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`,
      [sym, JSON.stringify(data), new Date().toISOString()]);
  } finally { await closeAsync(db2); }

  if (data.error) return { symbol: sym, error: data.error };
  return { ...shpDeltas(data.quarters), fetchedAt: new Date().toISOString(), cached: false };
}

// Where this stock sits inside its own industry, and how that industry is doing overall.
// "Is the stock strong?" and "is the whole sector being carried?" are different questions,
// and only the second explains a rising tide.
async function getPeerContext(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const db = openDatabase();
  try {
    const me = await getAsync(db,
      `SELECT symbol, name, industry, universe, scan_date, r1w, r1m, r3m, r6m, combined_score
         FROM universe_scores WHERE symbol = ? ORDER BY scan_date DESC LIMIT 1`, [sym]);
    if (!me || !me.industry) return null;

    const peers = await allAsync(db,
      `SELECT symbol, name, r1m, r3m, r6m, combined_score
         FROM universe_scores WHERE industry = ? AND scan_date = ?`, [me.industry, me.scan_date]);

    const rankOn = (field) => {
      const vals = peers.filter((p) => p[field] != null).sort((a, b) => b[field] - a[field]);
      const idx = vals.findIndex((p) => p.symbol === sym);
      if (idx < 0 || !vals.length) return null;
      const mid = Math.floor(vals.length / 2);
      const median = vals.length % 2
        ? vals[mid][field]
        : Math.round(((vals[mid - 1][field] + vals[mid][field]) / 2) * 10) / 10;
      return {
        rank: idx + 1,
        of: vals.length,
        // Percentile as "top X%" — the reading people actually want.
        topPct: Math.round(((idx + 1) / vals.length) * 100),
        value: me[field],
        median,
        vsMedian: me[field] != null && median != null ? Math.round((me[field] - median) * 10) / 10 : null,
      };
    };

    // How the industry itself is doing, so a strong stock in a strong sector is
    // distinguishable from a strong stock carrying a weak one.
    const industryMedian = (field) => {
      const vals = peers.map((p) => p[field]).filter((v) => v != null).sort((a, b) => a - b);
      if (!vals.length) return null;
      const mid = Math.floor(vals.length / 2);
      return vals.length % 2 ? vals[mid] : Math.round(((vals[mid - 1] + vals[mid]) / 2) * 10) / 10;
    };

    const allRows = await allAsync(db,
      `SELECT r1m, r3m FROM universe_scores WHERE scan_date = ? AND universe = ?`, [me.scan_date, me.universe]);
    const marketMedian = (field) => {
      const vals = allRows.map((r) => r[field]).filter((v) => v != null).sort((a, b) => a - b);
      if (!vals.length) return null;
      const mid = Math.floor(vals.length / 2);
      return vals.length % 2 ? vals[mid] : Math.round(((vals[mid - 1] + vals[mid]) / 2) * 10) / 10;
    };

    return {
      industry: me.industry,
      universe: me.universe,
      scanDate: me.scan_date,
      peerCount: peers.length,
      r1m: rankOn('r1m'),
      r3m: rankOn('r3m'),
      r6m: rankOn('r6m'),
      score: rankOn('combined_score'),
      industryVsMarket: {
        r1m: { industry: industryMedian('r1m'), market: marketMedian('r1m') },
        r3m: { industry: industryMedian('r3m'), market: marketMedian('r3m') },
      },
    };
  } finally { await closeAsync(db); }
}

// Derived read on the quarterly series. A single growth % can't distinguish accelerating
// from decelerating, which is the whole point of looking at a trend.
function summariseQuarters(quarters) {
  const q = (quarters || []).filter((x) => x.revenue != null);
  if (q.length < 2) return null;
  const pctChange = (a, b) => (a && b && a !== 0 ? Math.round(((b - a) / Math.abs(a)) * 1000) / 10 : null);

  const revQoQ = [];
  const epsQoQ = [];
  for (let i = 1; i < q.length; i += 1) {
    revQoQ.push(pctChange(q[i - 1].revenue, q[i].revenue));
    epsQoQ.push(pctChange(q[i - 1].eps, q[i].eps));
  }
  const last = q[q.length - 1];
  const first = q[0];
  const recent = revQoQ.slice(-2).filter((v) => v != null);
  const earlier = revQoQ.slice(0, -2).filter((v) => v != null);
  const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

  return {
    periods: q.length,
    from: first.period,
    to: last.period,
    revenueChangePct: pctChange(first.revenue, last.revenue),
    epsChangePct: pctChange(first.eps, last.eps),
    revQoQ,
    epsQoQ,
    // Accelerating when the latest quarters are growing faster than the earlier ones.
    accelerating: recent.length && earlier.length ? avg(recent) > avg(earlier) : null,
    marginTrend: (last.operatingIncome && last.revenue && first.operatingIncome && first.revenue)
      ? Math.round(((last.operatingIncome / last.revenue) - (first.operatingIncome / first.revenue)) * 1000) / 10
      : null,
    quartersUp: revQoQ.filter((v) => v != null && v > 0).length,
  };
}

async function getStockInsight(symbol, opts = {}) {
  const [fundamentals, peers, shareholding] = await Promise.all([
    getFundamentals(symbol, opts).catch((e) => ({ error: e.message })),
    getPeerContext(symbol).catch(() => null),
    getShareholding(symbol, opts).catch((e) => ({ error: e.message })),
  ]);
  return {
    symbol: String(symbol || '').toUpperCase(),
    fundamentals,
    peers,
    shareholding,
    quarterTrend: summariseQuarters(fundamentals?.quarters),
  };
}

module.exports = {
  getStockInsight, getFundamentals, getPeerContext, getShareholding, summariseQuarters, shpDeltas,
};
