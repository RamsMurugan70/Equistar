const { openDatabase, allAsync, getAsync, closeAsync } = require('../db/connection');

async function withDatabase(work) {
  const db = openDatabase();
  try {
    return await work(db);
  } finally {
    await closeAsync(db);
  }
}

async function getLatestPortfolioSummary(portfolio) {
  return withDatabase(async (db) => {
    const params = [];
    let where = '';
    if (portfolio) {
      where = 'WHERE portfolio = ?';
      params.push(portfolio);
    }
    return getAsync(
      db,
      `SELECT summary_date, portfolio, total_invested, total_value, day_change_value, day_change_pct, net_inflow, stock_count
       FROM portfolio_summary
       ${where}
       ORDER BY summary_date DESC, id DESC
       LIMIT 1`,
      params
    );
  });
}

async function listPortfolioSummaries(portfolio, limit = 30) {
  return withDatabase(async (db) => {
    const params = [];
    let where = '';
    if (portfolio) {
      where = 'WHERE portfolio = ?';
      params.push(portfolio);
    }
    params.push(limit);
    return allAsync(
      db,
      `SELECT summary_date, portfolio, total_invested, total_value, day_change_value, day_change_pct, net_inflow, stock_count
       FROM portfolio_summary
       ${where}
       ORDER BY summary_date DESC, id DESC
       LIMIT ?`,
      params
    );
  });
}

async function listPortfolioSnapshots(portfolio, limit = 10) {
  return withDatabase(async (db) => {
    const params = [];
    let where = '';
    if (portfolio) {
      where = 'WHERE portfolio = ?';
      params.push(portfolio);
    }
    params.push(limit);
    return allAsync(
      db,
      `SELECT id, portfolio, snapshot_date, payload_json, created_at
       FROM portfolio_snapshots
       ${where}
       ORDER BY snapshot_date DESC, id DESC
       LIMIT ?`,
      params
    );
  });
}

async function getPortfolioSnapshot(portfolio, snapshotDate) {
  return withDatabase((db) =>
    getAsync(
      db,
      `SELECT id, portfolio, snapshot_date, payload_json, created_at
       FROM portfolio_snapshots
       WHERE portfolio = ? AND snapshot_date = ?
       ORDER BY id DESC
       LIMIT 1`,
      [portfolio, snapshotDate]
    )
  );
}

async function listPortfolioSnapshotPayloads(limit = 250) {
  return withDatabase((db) =>
    allAsync(
      db,
      `SELECT id, portfolio, snapshot_date, payload_json, created_at
       FROM portfolio_snapshots
       ORDER BY snapshot_date DESC, id DESC
       LIMIT ?`,
      [limit]
    )
  );
}

// Distinct snapshot dates we have data for (newest first), optionally per portfolio.
async function listSnapshotDates(portfolio) {
  return withDatabase(async (db) => {
    const params = [];
    let where = '';
    if (portfolio) { where = 'WHERE portfolio = ?'; params.push(portfolio); }
    const rows = await allAsync(
      db,
      `SELECT DISTINCT snapshot_date
         FROM portfolio_snapshots
         ${where}
        ORDER BY snapshot_date DESC`,
      params
    );
    return rows.map((r) => r.snapshot_date);
  });
}

module.exports = {
  getLatestPortfolioSummary,
  listPortfolioSummaries,
  listPortfolioSnapshots,
  getPortfolioSnapshot,
  listPortfolioSnapshotPayloads,
  listSnapshotDates,
};
