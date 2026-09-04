const { openDatabase, allAsync, runAsync, getAsync, closeAsync } = require('../db/connection');

async function withDatabase(work) {
  const db = openDatabase();
  try {
    return await work(db);
  } finally {
    await closeAsync(db);
  }
}

async function ensureSchema(db) {
  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS universe_scores (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      universe      TEXT NOT NULL DEFAULT 'NIFTY500',
      scan_date     TEXT NOT NULL,
      symbol        TEXT NOT NULL,
      name          TEXT,
      industry      TEXT,
      cmp           REAL,
      technical_score   REAL,
      fundamental_score REAL,
      momentum_score    REAL,
      combined_score    REAL,
      rsi           REAL,
      r1m           REAL,
      r3m           REAL,
      r6m           REAL,
      ema_ladder    TEXT,
      ema50_slope   REAL,
      components    INTEGER,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await runAsync(db, 'CREATE INDEX IF NOT EXISTS idx_universe_scores_date ON universe_scores (scan_date)');
  // Frozen daily Top-N snapshot — the "official" ranked list for each day,
  // used by future weekly/monthly consistency reports. Immune to later
  // changes in ranking logic because ranks are persisted at scan time.
  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS universe_top_daily (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      universe      TEXT NOT NULL DEFAULT 'NIFTY500',
      scan_date     TEXT NOT NULL,
      rank          INTEGER NOT NULL,
      symbol        TEXT NOT NULL,
      name          TEXT,
      industry      TEXT,
      cmp           REAL,
      technical_score   REAL,
      fundamental_score REAL,
      momentum_score    REAL,
      combined_score    REAL,
      r1m           REAL,
      r3m           REAL,
      r6m           REAL,
      ema_ladder    TEXT,
      ema50_slope   REAL,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await runAsync(db, 'CREATE INDEX IF NOT EXISTS idx_universe_top_daily_date ON universe_top_daily (scan_date)');

  // Bottom-N daily snapshot — worst-ranked stocks each day (exit candidates)
  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS universe_bottom_daily (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      universe      TEXT NOT NULL DEFAULT 'NIFTY500',
      scan_date     TEXT NOT NULL,
      rank          INTEGER NOT NULL,
      symbol        TEXT NOT NULL,
      name          TEXT,
      industry      TEXT,
      cmp           REAL,
      technical_score   REAL,
      fundamental_score REAL,
      momentum_score    REAL,
      combined_score    REAL,
      r1w           REAL,
      r1m           REAL,
      r3m           REAL,
      r6m           REAL,
      ema_ladder    TEXT,
      ema50_slope   REAL,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await runAsync(db, 'CREATE INDEX IF NOT EXISTS idx_universe_bottom_daily_date   ON universe_bottom_daily (scan_date)');
  await runAsync(db, 'CREATE INDEX IF NOT EXISTS idx_universe_bottom_daily_symbol ON universe_bottom_daily (symbol)');

  // Safe column migrations for tables created before newer fields existed
  for (const table of ['universe_scores', 'universe_top_daily']) {
    const cols = await allAsync(db, `PRAGMA table_info(${table})`);
    const names = cols.map((c) => c.name);
    if (!names.includes('r1w')) {
      await runAsync(db, `ALTER TABLE ${table} ADD COLUMN r1w REAL`);
    }
  }
  // Small/Mid/Micro-cap scanners share these tables, distinguished by `universe`.
  // Existing rows predate this column and default to NIFTY500 (backfilled explicitly
  // since SQLite's ALTER-TABLE default only applies going forward on some versions).
  for (const table of ['universe_scores', 'universe_top_daily', 'universe_bottom_daily']) {
    const cols = await allAsync(db, `PRAGMA table_info(${table})`);
    const names = cols.map((c) => c.name);
    if (!names.includes('universe')) {
      await runAsync(db, `ALTER TABLE ${table} ADD COLUMN universe TEXT NOT NULL DEFAULT 'NIFTY500'`);
      await runAsync(db, `UPDATE ${table} SET universe = 'NIFTY500' WHERE universe IS NULL OR universe = ''`);
    }
  }
  // Universe-aware indexes — created only after the column is guaranteed to exist above.
  await runAsync(db, 'CREATE INDEX IF NOT EXISTS idx_universe_scores_universe_date ON universe_scores (universe, scan_date)');
  await runAsync(db, 'CREATE INDEX IF NOT EXISTS idx_universe_top_daily_universe_date ON universe_top_daily (universe, scan_date)');
}

// Replace the rows for one scan date (idempotent re-runs same day).
// `universe` distinguishes NIFTY500 (default) from the MIDCAP/SMALLCAP/MICROCAP scans.
async function replaceScanRows(scanDate, rows, universe = 'NIFTY500') {
  return withDatabase(async (db) => {
    await ensureSchema(db);
    await runAsync(db, 'BEGIN TRANSACTION');
    try {
      await runAsync(db, 'DELETE FROM universe_scores WHERE scan_date = ? AND universe = ?', [scanDate, universe]);
      for (const r of rows) {
        await runAsync(
          db,
          `INSERT INTO universe_scores
            (universe, scan_date, symbol, name, industry, cmp, technical_score, fundamental_score,
             momentum_score, combined_score, rsi, r1w, r1m, r3m, r6m, ema_ladder, ema50_slope, components)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            universe, scanDate, r.Symbol, r.Name, r.Industry, r.CMP,
            r.Tech ?? null, r.Fund ?? null, r.Mom ?? null, r.Score ?? null,
            r.RSI ?? null, r.R1W ?? null, r.R1M ?? null, r.R3M ?? null, r.R6M ?? null,
            r.EmaLadder ?? null, r.Ema50Slope ?? null, r.Components ?? null,
          ]
        );
      }
      await runAsync(db, 'COMMIT');
      return { inserted: rows.length };
    } catch (error) {
      await runAsync(db, 'ROLLBACK');
      throw error;
    }
  });
}

async function latestScanDates(n = 2, universe = 'NIFTY500') {
  return withDatabase(async (db) => {
    await ensureSchema(db);
    const rows = await allAsync(
      db, 'SELECT DISTINCT scan_date FROM universe_scores WHERE universe = ? ORDER BY scan_date DESC LIMIT ?', [universe, n]);
    return rows.map((r) => r.scan_date);
  });
}

async function listScanRows(scanDate, universe = 'NIFTY500') {
  return withDatabase(async (db) => {
    await ensureSchema(db);
    return allAsync(db, 'SELECT * FROM universe_scores WHERE scan_date = ? AND universe = ?', [scanDate, universe]);
  });
}

// Replace the frozen Top-N snapshot for one scan date.
async function replaceDailyTop(scanDate, rows, universe = 'NIFTY500') {
  return withDatabase(async (db) => {
    await ensureSchema(db);
    await runAsync(db, 'BEGIN TRANSACTION');
    try {
      await runAsync(db, 'DELETE FROM universe_top_daily WHERE scan_date = ? AND universe = ?', [scanDate, universe]);
      for (const r of rows) {
        await runAsync(
          db,
          `INSERT INTO universe_top_daily
            (universe, scan_date, rank, symbol, name, industry, cmp, technical_score, fundamental_score,
             momentum_score, combined_score, r1w, r1m, r3m, r6m, ema_ladder, ema50_slope)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            universe, scanDate, r.rank, r.symbol, r.name ?? null, r.industry ?? null, r.cmp ?? null,
            r.technical_score ?? null, r.fundamental_score ?? null, r.momentum_score ?? null,
            r.combined_score ?? null, r.r1w ?? null, r.r1m ?? null, r.r3m ?? null, r.r6m ?? null,
            r.ema_ladder ?? null, r.ema50_slope ?? null,
          ]
        );
      }
      await runAsync(db, 'COMMIT');
      return { inserted: rows.length };
    } catch (error) {
      await runAsync(db, 'ROLLBACK');
      throw error;
    }
  });
}

// Daily Top-N history (for weekly/monthly consistency reports).
async function listDailyTops(sinceDate = '', limitDays = 60, universe = 'NIFTY500') {
  return withDatabase(async (db) => {
    await ensureSchema(db);
    const dates = await allAsync(
      db,
      `SELECT DISTINCT scan_date FROM universe_top_daily
       WHERE universe = ? ${sinceDate ? 'AND scan_date >= ?' : ''}
       ORDER BY scan_date DESC LIMIT ?`,
      sinceDate ? [universe, sinceDate, limitDays] : [universe, limitDays]
    );
    if (!dates.length) return [];
    const ds = dates.map((d) => d.scan_date);
    const placeholders = ds.map(() => '?').join(', ');
    const rows = await allAsync(
      db,
      `SELECT * FROM universe_top_daily WHERE universe = ? AND scan_date IN (${placeholders}) ORDER BY scan_date DESC, rank ASC`,
      [universe, ...ds]
    );
    return rows;
  });
}

// Per-day history for ONE symbol: universe rank (among all scored that day),
// Top-25 rank if it made the frozen daily list, score, ladder.
async function stockHistory(symbol, days = 22, universe = 'NIFTY500') {
  return withDatabase(async (db) => {
    await ensureSchema(db);
    return allAsync(
      db,
      `SELECT s.scan_date, s.name, s.industry, s.combined_score, s.technical_score, s.fundamental_score,
              s.momentum_score, s.rsi, s.ema50_slope, s.ema_ladder, s.cmp, s.r1w, s.r1m, s.r3m, s.r6m,
              (SELECT COUNT(*) + 1 FROM universe_scores x
                WHERE x.scan_date = s.scan_date AND x.universe = s.universe AND x.combined_score > s.combined_score) AS uni_rank,
              (SELECT COUNT(*) FROM universe_scores x
                WHERE x.scan_date = s.scan_date AND x.universe = s.universe AND x.combined_score IS NOT NULL) AS uni_total,
              t.rank AS top25_rank
         FROM universe_scores s
         LEFT JOIN universe_top_daily t
                ON t.scan_date = s.scan_date AND t.symbol = s.symbol AND t.universe = s.universe
        WHERE s.symbol = ? AND s.universe = ? AND s.combined_score IS NOT NULL
        ORDER BY s.scan_date DESC
        LIMIT ?`,
      [symbol, universe, days]
    );
  });
}

// Symbol + name directory from the latest scan (for the lookup type-ahead).
async function listLatestSymbols(universe = 'NIFTY500') {
  return withDatabase(async (db) => {
    await ensureSchema(db);
    return allAsync(
      db,
      `SELECT symbol, name FROM universe_scores
        WHERE universe = ? AND scan_date = (SELECT MAX(scan_date) FROM universe_scores WHERE universe = ?)
        ORDER BY symbol`,
      [universe, universe]
    );
  });
}

// Replace the frozen Bottom-N snapshot for one scan date.
async function replaceBottomDaily(scanDate, rows, universe = 'NIFTY500') {
  return withDatabase(async (db) => {
    await ensureSchema(db);
    await runAsync(db, 'BEGIN TRANSACTION');
    try {
      await runAsync(db, 'DELETE FROM universe_bottom_daily WHERE scan_date = ? AND universe = ?', [scanDate, universe]);
      for (const r of rows) {
        await runAsync(
          db,
          `INSERT INTO universe_bottom_daily
            (universe, scan_date, rank, symbol, name, industry, cmp, technical_score, fundamental_score,
             momentum_score, combined_score, r1w, r1m, r3m, r6m, ema_ladder, ema50_slope)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            universe, scanDate, r.rank, r.symbol, r.name ?? null, r.industry ?? null, r.cmp ?? null,
            r.technical_score ?? null, r.fundamental_score ?? null, r.momentum_score ?? null,
            r.combined_score ?? null, r.r1w ?? null, r.r1m ?? null, r.r3m ?? null, r.r6m ?? null,
            r.ema_ladder ?? null, r.ema50_slope ?? null,
          ]
        );
      }
      await runAsync(db, 'COMMIT');
      return { inserted: rows.length };
    } catch (error) {
      await runAsync(db, 'ROLLBACK');
      throw error;
    }
  });
}

// Exit candidates: held stocks that appeared in bottom-25 most consistently
// over the given window (days). Returns per-symbol appearance count + latest rank data.
async function getExitCandidates(heldSymbols, windowDays = 30) {
  if (!heldSymbols || heldSymbols.length === 0) return [];
  return withDatabase(async (db) => {
    await ensureSchema(db);
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Total distinct scan days in the window (NIFTY500 only — cap-universe
    // scans share this table but must not mix into the portfolio exit-candidates view)
    const { total_days } = await getAsync(db,
      `SELECT COUNT(DISTINCT scan_date) AS total_days FROM universe_bottom_daily WHERE scan_date >= ? AND universe = 'NIFTY500'`,
      [since]
    ) || { total_days: 0 };

    if (!total_days) return [];

    const placeholders = heldSymbols.map(() => '?').join(', ');

    // Appearance count + best (worst) rank per held symbol
    const appearances = await allAsync(db,
      `SELECT symbol,
              COUNT(DISTINCT scan_date) AS appearances,
              MIN(rank)                 AS best_rank,
              MAX(rank)                 AS worst_rank,
              ROUND(AVG(rank), 1)       AS avg_rank
         FROM universe_bottom_daily
        WHERE scan_date >= ?
          AND universe = 'NIFTY500'
          AND UPPER(symbol) IN (${placeholders})
        GROUP BY UPPER(symbol)`,
      [since, ...heldSymbols.map((s) => s.toUpperCase())]
    );

    if (!appearances.length) return [];

    // Latest universe score for each candidate
    const latestDate = await getAsync(db,
      `SELECT MAX(scan_date) AS d FROM universe_scores WHERE universe = 'NIFTY500'`
    );
    const latestScores = latestDate?.d
      ? await allAsync(db,
          `SELECT symbol, combined_score, technical_score, fundamental_score,
                  momentum_score, cmp, ema_ladder, r1m, r3m, r6m,
                  (SELECT COUNT(*) + 1 FROM universe_scores x
                    WHERE x.scan_date = s.scan_date AND x.universe = 'NIFTY500' AND x.combined_score > s.combined_score) AS current_rank,
                  (SELECT COUNT(*) FROM universe_scores x
                    WHERE x.scan_date = s.scan_date AND x.universe = 'NIFTY500' AND x.combined_score IS NOT NULL)         AS total_scored
             FROM universe_scores s
            WHERE scan_date = ? AND s.universe = 'NIFTY500' AND UPPER(symbol) IN (${placeholders})`,
          [latestDate.d, ...heldSymbols.map((s) => s.toUpperCase())]
        )
      : [];

    const scoreMap = new Map(latestScores.map((r) => [r.symbol.toUpperCase(), r]));

    return appearances.map((a) => {
      const score = scoreMap.get(a.symbol.toUpperCase()) || {};
      return {
        symbol:          a.symbol,
        appearances:     a.appearances,
        total_days:      total_days,
        appearance_pct:  Math.round((a.appearances / total_days) * 100),
        best_rank:       a.best_rank,
        worst_rank:      a.worst_rank,
        avg_rank:        a.avg_rank,
        current_rank:    score.current_rank    ?? null,
        total_scored:    score.total_scored    ?? null,
        combined_score:  score.combined_score  ?? null,
        technical_score: score.technical_score ?? null,
        momentum_score:  score.momentum_score  ?? null,
        cmp:             score.cmp             ?? null,
        ema_ladder:      score.ema_ladder      ?? null,
        r1m:             score.r1m             ?? null,
        r3m:             score.r3m             ?? null,
        r6m:             score.r6m             ?? null,
        scan_date:       latestDate?.d         ?? null,
      };
    }).sort((a, b) => b.appearance_pct - a.appearance_pct || (a.current_rank ?? 999) - (b.current_rank ?? 999));
  });
}

module.exports = {
  replaceScanRows, latestScanDates, listScanRows,
  replaceDailyTop, listDailyTops,
  replaceBottomDaily, getExitCandidates,
  stockHistory, listLatestSymbols,
};
