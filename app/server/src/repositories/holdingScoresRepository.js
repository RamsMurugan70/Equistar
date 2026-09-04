const { openDatabase, allAsync, runAsync, closeAsync } = require('../db/connection');

async function withDatabase(work) {
  const db = openDatabase();
  try {
    return await work(db);
  } finally {
    await closeAsync(db);
  }
}

// Ensure the holding_scores table has the v2 columns (safe migration)
async function ensureSchema(db) {
  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS holding_scores (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      score_date       TEXT NOT NULL,
      portfolio        TEXT NOT NULL,
      symbol           TEXT NOT NULL,
      name             TEXT,
      momentum_score   REAL,
      fundamental_score REAL,
      technical_score  REAL,
      combined_score   REAL,
      rating           TEXT,
      rsi              REAL,
      r1m              REAL,
      r3m              REAL,
      r6m              REAL,
      is_etf           INTEGER DEFAULT 0,
      note             TEXT,
      cmp              REAL,
      qty              REAL,
      score_version    TEXT,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Add v2 columns to existing tables if missing
  const cols = await allAsync(db, "PRAGMA table_info(holding_scores)");
  const colNames = cols.map((c) => c.name);
  const toAdd = [
    ['name',    'TEXT'],
    ['rating',  'TEXT'],
    ['rsi',     'REAL'],
    ['r1m',     'REAL'],
    ['r3m',     'REAL'],
    ['r6m',     'REAL'],
    ['is_etf',  'INTEGER DEFAULT 0'],
    ['note',    'TEXT'],
    ['cmp',     'REAL'],
    ['qty',     'REAL'],
    ['ema_ladder',  'TEXT'],
    ['ema50_slope', 'REAL'],
  ];
  for (const [col, def] of toAdd) {
    if (!colNames.includes(col)) {
      await runAsync(db, `ALTER TABLE holding_scores ADD COLUMN ${col} ${def}`);
    }
  }
}

async function replaceScoresForSnapshots(rows) {
  return withDatabase(async (db) => {
    await ensureSchema(db);
    // Delete per (date, portfolio) — deleting by date alone wiped OTHER
    // portfolios' same-day scans (e.g. Geetha's refresh erased Rams' rows).
    const datePortfolios = [...new Set(
      rows.map((r) => `${r.scoreDate}::${r.portfolio}`).filter((k) => !k.startsWith('::'))
    )];

    await runAsync(db, 'BEGIN TRANSACTION');
    try {
      for (const key of datePortfolios) {
        const [scoreDate, portfolio] = key.split('::');
        await runAsync(db, 'DELETE FROM holding_scores WHERE score_date = ? AND portfolio = ?', [scoreDate, portfolio]);
      }
      for (const row of rows) {
        await runAsync(
          db,
          `INSERT INTO holding_scores
            (score_date, portfolio, symbol, name, momentum_score, fundamental_score,
             technical_score, combined_score, rating, rsi, r1m, r3m, r6m,
             is_etf, note, cmp, qty, ema_ladder, ema50_slope, score_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.scoreDate, row.portfolio, row.symbol, row.name,
            row.momentumScore, row.fundamentalScore, row.technicalScore, row.combinedScore,
            row.rating, row.rsi, row.r1m, row.r3m, row.r6m,
            row.isEtf, row.note, row.cmp, row.qty,
            row.emaLadder ?? null, row.ema50Slope ?? null, row.scoreVersion,
          ]
        );
      }
      await runAsync(db, 'COMMIT');
    } catch (error) {
      await runAsync(db, 'ROLLBACK');
      throw error;
    }
  });
}

async function listScoresForDate(scoreDate, portfolio = '') {
  return withDatabase(async (db) => {
    await ensureSchema(db);
    const params = [scoreDate];
    let where = 'WHERE score_date = ?';
    if (portfolio) {
      where += ' AND portfolio = ?';
      params.push(portfolio);
    }
    return allAsync(
      db,
      `SELECT * FROM holding_scores ${where} ORDER BY combined_score DESC NULLS LAST`,
      params
    );
  });
}

async function listLatestScores(portfolio = '') {
  return withDatabase(async (db) => {
    await ensureSchema(db);
    if (portfolio) {
      // Single portfolio: use that portfolio's own latest date
      return allAsync(
        db,
        `SELECT * FROM holding_scores
         WHERE portfolio = ?
           AND score_date = (
             SELECT MAX(score_date) FROM holding_scores WHERE portfolio = ?
           )
         ORDER BY combined_score DESC`,
        [portfolio, portfolio]
      );
    }
    // All portfolios: return each portfolio's own latest scored rows
    // (portfolios may have different score_dates — show the freshest for each)
    return allAsync(
      db,
      `SELECT hs.*
       FROM holding_scores hs
       INNER JOIN (
         SELECT portfolio, MAX(score_date) AS latest_date
         FROM holding_scores
         GROUP BY portfolio
       ) latest ON hs.portfolio = latest.portfolio
                AND hs.score_date = latest.latest_date
       ORDER BY hs.portfolio, hs.combined_score DESC`,
      []
    );
  });
}

module.exports = {
  replaceScoresForSnapshots,
  listScoresForDate,
  listLatestScores,
};
