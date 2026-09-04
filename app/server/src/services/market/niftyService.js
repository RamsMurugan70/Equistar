const { openDatabase, allAsync, runAsync, closeAsync } = require('../../db/connection');

const YAHOO_CHART_BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const NIFTY_SYMBOL = '^NSEI';

async function ensureTable(db) {
  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS nifty_candles (
      date TEXT PRIMARY KEY,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL
    )
  `);
}

async function fetchAndStoreNiftyCandles() {
  const url = `${YAHOO_CHART_BASE_URL}/${encodeURIComponent(NIFTY_SYMBOL)}?range=1y&interval=1d&includePrePost=false`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  });

  if (!response.ok) throw new Error(`Yahoo Nifty fetch failed: ${response.status}`);

  const data = await response.json();
  const result = data?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const q = result?.indicators?.quote?.[0] || {};

  if (!timestamps.length) throw new Error('No Nifty data from Yahoo');

  const candles = timestamps
    .map((ts, i) => ({
      date: new Date(ts * 1000).toISOString().slice(0, 10),
      open:  Number(q.open?.[i]),
      high:  Number(q.high?.[i]),
      low:   Number(q.low?.[i]),
      close: Number(q.close?.[i]),
    }))
    .filter(c =>
      c.date &&
      Number.isFinite(c.open)  && c.open  > 0 &&
      Number.isFinite(c.high)  && c.high  > 0 &&
      Number.isFinite(c.low)   && c.low   > 0 &&
      Number.isFinite(c.close) && c.close > 0,
    );

  const db = openDatabase();
  try {
    await ensureTable(db);
    for (const c of candles) {
      await runAsync(
        db,
        'INSERT OR REPLACE INTO nifty_candles (date, open, high, low, close) VALUES (?, ?, ?, ?, ?)',
        [c.date, c.open, c.high, c.low, c.close],
      );
    }
    console.log(`Nifty: stored ${candles.length} candles`);
    return candles.length;
  } finally {
    await closeAsync(db);
  }
}

async function getNiftyCandles({ fromDate, toDate }) {
  const db = openDatabase();
  try {
    await ensureTable(db);
    return await allAsync(
      db,
      'SELECT date, open, high, low, close FROM nifty_candles WHERE date >= ? AND date <= ? ORDER BY date ASC',
      [fromDate, toDate],
    );
  } finally {
    await closeAsync(db);
  }
}

module.exports = { fetchAndStoreNiftyCandles, getNiftyCandles };
