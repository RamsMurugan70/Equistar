// Full NSE equity symbol master — every listed stock, not just index constituents.
//
// WHY: the advisor writes plain company names ("Kusumgar"), and universe_scores only covers
// the 751 names inside Nifty 500 / Midcap 150 / Smallcap 250 / Microcap 250. Small companies
// simply are not in it — Kusumgar is not — so name resolution failed on exactly the kind of
// stock an advisor is most likely to tip.
//
// EQUITY_L.csv carries all ~2,400 listed symbols with their company names. Verified reachable
// 2026-08-12 (169KB, 2402 rows) via nsearchives.nseindia.com after the usual NSE cookie
// handshake. Cached in SQLite so a fetch failure never blocks parsing.
const https = require('https');
const { openDatabase, allAsync, getAsync, runAsync, closeAsync } = require('../../db/connection');
const { onlyWhenOwned } = require('../../db/marketSchema');

const CSV_URLS = [
  'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv',
  'https://archives.nseindia.com/content/equities/EQUITY_L.csv',
];

function normName(s) {
  return String(s || '').toUpperCase()
    .replace(/\b(LTD|LIMITED|CORPORATION|CORPORATES|CORP|COMPANY|CO|INDIA|INDIAN|THE|AND|&)\b/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

function nseCookies() {
  return new Promise((resolve) => {
    const req = https.get('https://www.nseindia.com', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124' },
      timeout: 10000,
    }, (res) => {
      const c = (res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
      res.resume();
      resolve(c);
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

function fetchUrl(url, cookie, depth = 0) {
  return new Promise((resolve) => {
    if (depth > 4) return resolve(null);
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124',
        Accept: '*/*', Referer: 'https://www.nseindia.com/', Cookie: cookie,
      },
      timeout: 25000,
    }, (res) => {
      // The archive host redirects; follow it rather than treating a 301 as failure.
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(fetchUrl(res.headers.location, cookie, depth + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const ensureSchema = onlyWhenOwned(async (db) => {
  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS nse_symbol_master (
      symbol      TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      norm_name   TEXT NOT NULL,
      series      TEXT,
      isin        TEXT,
      updated_at  TEXT
    )`);
  await runAsync(db, `CREATE INDEX IF NOT EXISTS idx_symmaster_norm ON nse_symbol_master (norm_name)`);
});

async function refreshSymbolMaster() {
  const cookie = await nseCookies();
  let csv = null;
  for (const url of CSV_URLS) {
    csv = await fetchUrl(url, cookie);
    if (csv && csv.length > 1000) break;
  }
  if (!csv || csv.length < 1000) throw new Error('EQUITY_L.csv unavailable from NSE');

  const lines = csv.split(/\r?\n/).filter(Boolean);
  const rows = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(',');
    if (parts.length < 3) continue;
    const symbol = parts[0].trim().toUpperCase();
    const name = parts[1].trim();
    const series = parts[2].trim();
    const isin = (parts[6] || '').trim();
    // EQ / BE are the tradable cash-market series; the rest are debt, warrants etc.
    if (!symbol || !name || !['EQ', 'BE'].includes(series)) continue;
    rows.push({ symbol, name, series, isin });
  }
  if (!rows.length) throw new Error('EQUITY_L.csv parsed to zero rows');

  const db = openDatabase();
  try {
    await ensureSchema(db);
    await runAsync(db, 'BEGIN TRANSACTION');
    const now = new Date().toISOString();
    for (const r of rows) {
      await runAsync(db,
        `INSERT INTO nse_symbol_master (symbol, name, norm_name, series, isin, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(symbol) DO UPDATE SET
           name=excluded.name, norm_name=excluded.norm_name,
           series=excluded.series, isin=excluded.isin, updated_at=excluded.updated_at`,
        [r.symbol, r.name, normName(r.name), r.series, r.isin, now]);
    }
    await runAsync(db, 'COMMIT');
  } catch (e) {
    await runAsync(db, 'ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await closeAsync(db);
  }
  return { symbols: rows.length };
}

// normalised company name -> { symbol, name }. Falls back to the scan universe when the
// master has not been fetched yet, so parsing degrades rather than breaking.
async function getNameIndex() {
  const db = openDatabase();
  try {
    await ensureSchema(db);
    const idx = new Map();
    const master = await allAsync(db, 'SELECT symbol, name, norm_name FROM nse_symbol_master');
    for (const r of master) if (r.norm_name && !idx.has(r.norm_name)) idx.set(r.norm_name, { symbol: r.symbol, name: r.name });

    if (!idx.size) {
      const uni = await allAsync(db, 'SELECT DISTINCT symbol, name FROM universe_scores');
      for (const r of uni) {
        const k = normName(r.name);
        if (k && !idx.has(k)) idx.set(k, { symbol: r.symbol, name: r.name });
      }
    }
    // The symbol itself is also a valid way to name a stock ("INFY").
    for (const r of master) {
      const k = normName(r.symbol);
      if (k && !idx.has(k)) idx.set(k, { symbol: r.symbol, name: r.name });
    }
    return idx;
  } finally { await closeAsync(db); }
}

async function status() {
  const db = openDatabase();
  try {
    await ensureSchema(db);
    const row = await getAsync(db, 'SELECT COUNT(*) AS n, MAX(updated_at) AS updated FROM nse_symbol_master');
    return { symbols: row?.n || 0, updatedAt: row?.updated || null };
  } finally { await closeAsync(db); }
}

module.exports = { refreshSymbolMaster, getNameIndex, status, normName };
