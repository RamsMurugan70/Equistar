const { openDatabase, allAsync, getAsync, runAsync, closeAsync } = require('../db/connection');

// ── Schema bootstrap (idempotent) ─────────────────────────────────────────────
// Adds `charges` column to existing orders tables that pre-date this feature.
async function ensureSchema() {
  const db = openDatabase();
  try {
    const cols = await allAsync(db, `PRAGMA table_info(orders)`);
    const names = cols.map((c) => c.name);
    if (!names.includes('charges')) {
      await runAsync(db, `ALTER TABLE orders ADD COLUMN charges REAL DEFAULT 0`);
      console.log('◇ brokerageRepository: added charges column to orders');
    }
    // Ensure daily_brokerage table exists (created by schema migration, but safe to repeat)
    await runAsync(db, `
      CREATE TABLE IF NOT EXISTS daily_brokerage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_date TEXT NOT NULL,
        portfolio TEXT NOT NULL,
        exchange TEXT NOT NULL DEFAULT '',
        brokerage REAL DEFAULT 0,
        stt REAL DEFAULT 0,
        exchange_charges REAL DEFAULT 0,
        gst REAL DEFAULT 0,
        stamp_duty REAL DEFAULT 0,
        sebi_charges REAL DEFAULT 0,
        other_charges REAL DEFAULT 0,
        total_charges REAL DEFAULT 0,
        trade_count INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(trade_date, portfolio, exchange)
      )
    `);
  } finally {
    await closeAsync(db);
  }
}

// Run once at startup
ensureSchema().catch((e) => console.error('brokerageRepository ensureSchema:', e.message));

// ── Upsert daily aggregate ────────────────────────────────────────────────────
// Called after saving Breeze F&O orders. chargesMap: { brokerage, stt, exchange_charges,
// gst, stamp_duty, sebi_charges, other_charges, total_charges, trade_count }
async function upsertDailyBrokerage(tradeDate, portfolio, exchange, chargesMap) {
  const db = openDatabase();
  try {
    await runAsync(db, `
      INSERT INTO daily_brokerage
        (trade_date, portfolio, exchange, brokerage, stt, exchange_charges, gst,
         stamp_duty, sebi_charges, other_charges, total_charges, trade_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(trade_date, portfolio, exchange) DO UPDATE SET
        brokerage        = excluded.brokerage,
        stt              = excluded.stt,
        exchange_charges = excluded.exchange_charges,
        gst              = excluded.gst,
        stamp_duty       = excluded.stamp_duty,
        sebi_charges     = excluded.sebi_charges,
        other_charges    = excluded.other_charges,
        total_charges    = excluded.total_charges,
        trade_count      = excluded.trade_count,
        updated_at       = CURRENT_TIMESTAMP
    `, [
      tradeDate, portfolio, exchange,
      chargesMap.brokerage || 0,
      chargesMap.stt || 0,
      chargesMap.exchange_charges || 0,
      chargesMap.gst || 0,
      chargesMap.stamp_duty || 0,
      chargesMap.sebi_charges || 0,
      chargesMap.other_charges || 0,
      chargesMap.total_charges || 0,
      chargesMap.trade_count || 0,
    ]);
  } finally {
    await closeAsync(db);
  }
}

// ── Query helpers ─────────────────────────────────────────────────────────────

async function listBrokerage({ from, to, portfolio } = {}) {
  const db = openDatabase();
  try {
    const params = [];
    let where = 'WHERE 1=1';
    if (from)      { where += ' AND trade_date >= ?'; params.push(from); }
    if (to)        { where += ' AND trade_date <= ?'; params.push(to); }
    if (portfolio) { where += ' AND portfolio = ?';   params.push(portfolio); }
    return await allAsync(db,
      `SELECT trade_date, portfolio, exchange, brokerage, stt, exchange_charges,
              gst, stamp_duty, sebi_charges, other_charges, total_charges, trade_count
         FROM daily_brokerage ${where}
        ORDER BY trade_date DESC`,
      params,
    );
  } finally {
    await closeAsync(db);
  }
}

async function totalBrokerage({ from, to, portfolio } = {}) {
  const db = openDatabase();
  try {
    const params = [];
    let where = 'WHERE 1=1';
    if (from)      { where += ' AND trade_date >= ?'; params.push(from); }
    if (to)        { where += ' AND trade_date <= ?'; params.push(to); }
    if (portfolio) { where += ' AND portfolio = ?';   params.push(portfolio); }
    const row = await getAsync(db,
      `SELECT
         SUM(brokerage)        AS brokerage,
         SUM(stt)              AS stt,
         SUM(exchange_charges) AS exchange_charges,
         SUM(gst)              AS gst,
         SUM(stamp_duty)       AS stamp_duty,
         SUM(sebi_charges)     AS sebi_charges,
         SUM(other_charges)    AS other_charges,
         SUM(total_charges)    AS total_charges,
         SUM(trade_count)      AS trade_count
         FROM daily_brokerage ${where}`,
      params,
    );
    // Return zeros when no data
    return {
      brokerage:        row?.brokerage        || 0,
      stt:              row?.stt              || 0,
      exchange_charges: row?.exchange_charges || 0,
      gst:              row?.gst              || 0,
      stamp_duty:       row?.stamp_duty       || 0,
      sebi_charges:     row?.sebi_charges     || 0,
      other_charges:    row?.other_charges    || 0,
      total_charges:    row?.total_charges    || 0,
      trade_count:      row?.trade_count      || 0,
    };
  } finally {
    await closeAsync(db);
  }
}

module.exports = { upsertDailyBrokerage, listBrokerage, totalBrokerage };
