// Daily price history per NSE symbol, cached in this participant's own database.
//
// WHY A CACHE OF ITS OWN. The scan-derived tables cover only the index constituents, so an ETF
// or an off-index holding had no 3-month or 1-year move anywhere in the app. Fetching each
// holding's history once and keeping it gives every holding the same treatment.
//
// ADJUSTED closes, deliberately. Yahoo's adjclose folds in splits, bonuses and dividends, so a
// 1-year return is the real total return. On raw closes CUPID's 4:1 bonus in March 2026 reads as
// an 80% collapse. The raw close is kept alongside for anything that needs the traded price.
//
// WHERE IT LIVES, and why not market.db. The shared market file is written by the hub alone and
// only read by instances (see db/marketSchema.js); an instance creating tables there would break
// that rule. This participant's app.db sits on the persistent data volume, so the cache survives
// restarts and redeploys. Tables are created with an explicit `main.` so they can never land in,
// or be shadowed by, the attached market file.
//
// A FAILED FETCH IS NOT A DEAD SYMBOL. Yahoo rate-limits and sometimes blocks server addresses.
// If every refused request were recorded as NO_DATA, a blocked afternoon would mark every holding
// "delisted" for twelve hours. So a request that got an answer saying "no such symbol" is NO_DATA;
// a request that failed (network, 429, 5xx) is ERROR, retried much sooner, and reported to the
// caller so the screen can say the price source is down instead of showing an empty table.
const { openDatabase, allAsync, runAsync, closeAsync } = require('../../db/connection');

// Two years: a 1-year window plus enough history before it to warm up a 200-day EMA.
const RANGE = '2y';
const STALE_HOURS = 12;
const ERROR_RETRY_MINUTES = 30;
// Six at a time: a first load of ~50 holdings takes seconds, not minutes, without hammering Yahoo.
const BATCH = 6;

// The internal key for the Nifty 50 index. Stored beside the stocks so it comes from the same
// source, on the same calendar, refreshed on the same schedule.
const NIFTY_KEY = '^NSEI';

async function ensureTables(db) {
  await runAsync(db, `CREATE TABLE IF NOT EXISTS main.stock_daily_prices (
    symbol   TEXT NOT NULL,
    date     TEXT NOT NULL,
    close    REAL,
    adjclose REAL,
    PRIMARY KEY (symbol, date))`);
  await runAsync(db, `CREATE TABLE IF NOT EXISTS main.stock_price_meta (
    symbol     TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL,
    last_date  TEXT,
    status     TEXT,
    source     TEXT,
    detail     TEXT)`);
}

// One Yahoo ticker -> { status: 'OK'|'NO_DATA'|'ERROR', bars, detail }.
function fetchTicker(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`
    + `?range=${RANGE}&interval=1d&events=div%2Csplit`;
  return fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  }).then(async (res) => {
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON: a block page or an outage */ }
    // Yahoo answers an unknown symbol with 404 and a "No data found" error body. That is an
    // answer about the symbol. Anything else that is not 200 is an answer about the request.
    if (res.status === 404 || body?.chart?.error?.code === 'Not Found') {
      return { status: 'NO_DATA', bars: [], detail: body?.chart?.error?.description || 'Not found' };
    }
    if (!res.ok || !body) return { status: 'ERROR', bars: [], detail: `HTTP ${res.status}` };
    const r = body?.chart?.result?.[0];
    const ts = r?.timestamp || [];
    const close = r?.indicators?.quote?.[0]?.close || [];
    // An index carries no adjclose (nothing to adjust); a stock missing it is treated as
    // unpriced rather than silently falling back to raw closes, which is the bonus-crash bug.
    const adj = r?.indicators?.adjclose?.[0]?.adjclose || (ticker.startsWith('^') ? close : null);
    if (!adj) return { status: 'NO_DATA', bars: [], detail: 'No adjusted closes returned' };
    const bars = [];
    for (let i = 0; i < ts.length; i += 1) {
      if (close[i] == null || adj[i] == null || !(adj[i] > 0)) continue;
      // IST calendar date of the bar (NSE bars are stamped at the 09:15 IST open).
      bars.push({ date: new Date((ts[i] + 19800) * 1000).toISOString().slice(0, 10),
        close: close[i], adjclose: adj[i] });
    }
    return bars.length
      ? { status: 'OK', bars, detail: null }
      : { status: 'NO_DATA', bars: [], detail: 'Empty price history' };
  }).catch((e) => ({ status: 'ERROR', bars: [], detail: e.name === 'TimeoutError' ? 'timeout' : e.message }));
}

// NSE first, BSE only when Yahoo says the NSE listing does not exist — never after a failed
// request, or a rate-limited NSE lookup would quietly price the holding off another exchange.
async function fetchSymbol(symbol) {
  if (symbol === NIFTY_KEY) return { ...(await fetchTicker(NIFTY_KEY)), source: NIFTY_KEY };
  const ns = await fetchTicker(`${symbol}.NS`);
  if (ns.status !== 'NO_DATA') return { ...ns, source: `${symbol}.NS` };
  const bo = await fetchTicker(`${symbol}.BO`);
  if (bo.status === 'OK') return { ...bo, source: `${symbol}.BO` };
  return { ...ns, source: `${symbol}.NS`, detail: `${ns.detail}; no BSE listing either` };
}

async function store(db, symbol, got) {
  const now = new Date().toISOString();
  if (got.status !== 'OK') {
    // ERROR keeps whatever bars are already cached: a stale price is better than none.
    await runAsync(db, `INSERT OR REPLACE INTO main.stock_price_meta
      (symbol, fetched_at, last_date, status, source, detail)
      VALUES (?, ?, (SELECT MAX(date) FROM main.stock_daily_prices WHERE symbol = ?), ?, ?, ?)`,
    [symbol, now, symbol, got.status, got.source, got.detail]);
    return;
  }
  await runAsync(db, 'BEGIN IMMEDIATE');
  try {
    for (const b of got.bars) {
      await runAsync(db, 'INSERT OR REPLACE INTO main.stock_daily_prices (symbol, date, close, adjclose) VALUES (?,?,?,?)',
        [symbol, b.date, b.close, b.adjclose]);
    }
    await runAsync(db, `INSERT OR REPLACE INTO main.stock_price_meta
      (symbol, fetched_at, last_date, status, source, detail) VALUES (?,?,?,?,?,?)`,
    [symbol, now, got.bars[got.bars.length - 1].date, 'OK', got.source, null]);
    await runAsync(db, 'COMMIT');
  } catch (e) {
    await runAsync(db, 'ROLLBACK').catch(() => {});
    throw e;
  }
}

function isStale(meta) {
  if (!meta) return true;
  const age = Date.now() - Date.parse(meta.fetched_at);
  if (meta.status === 'ERROR') return age > ERROR_RETRY_MINUTES * 60000;
  return age > STALE_HOURS * 3600000;
}

// A period switch fires a second request while the first is still fetching; without this both
// would fetch the same symbols from Yahoo and race to write them.
let inFlight = Promise.resolve();

/**
 * symbols -> { history: Map(symbol -> ascending [{date, close, adjclose}]), meta: Map(symbol -> meta) }
 * Refreshes only what is stale.
 */
async function getHistory(symbols) {
  const syms = [...new Set((symbols || []).map((s) => String(s || '').toUpperCase()).filter(Boolean))];
  const run = inFlight.then(() => load(syms));
  inFlight = run.catch(() => {});
  return run;
}

async function load(syms) {
  const db = openDatabase();
  try {
    await ensureTables(db);
    const metaRows = await allAsync(db, 'SELECT * FROM main.stock_price_meta');
    const meta = new Map(metaRows.map((r) => [r.symbol, r]));
    const stale = syms.filter((s) => isStale(meta.get(s)));
    for (let i = 0; i < stale.length; i += BATCH) {
      const slice = stale.slice(i, i + BATCH);
      const got = await Promise.all(slice.map((s) => fetchSymbol(s).then((g) => ({ s, g }))));
      for (const { s, g } of got) await store(db, s, g);
    }

    const history = new Map();
    const metaOut = new Map();
    if (!syms.length) return { history, meta: metaOut };
    const marks = syms.map(() => '?').join(',');
    for (const r of await allAsync(db, `SELECT * FROM main.stock_price_meta WHERE symbol IN (${marks})`, syms)) {
      metaOut.set(r.symbol, r);
    }
    const rows = await allAsync(db,
      `SELECT symbol, date, close, adjclose FROM main.stock_daily_prices
        WHERE symbol IN (${marks}) ORDER BY symbol, date`, syms);
    for (const r of rows) {
      if (!history.has(r.symbol)) history.set(r.symbol, []);
      history.get(r.symbol).push({ date: r.date, close: r.close, adjclose: r.adjclose });
    }
    return { history, meta: metaOut };
  } finally {
    await closeAsync(db);
  }
}

module.exports = { getHistory, NIFTY_KEY, fetchTicker };
