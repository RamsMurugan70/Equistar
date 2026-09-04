const { openDatabase, allAsync, getAsync, runAsync, closeAsync } = require('../db/connection');

async function withDatabase(work) {
  const db = openDatabase();
  try {
    return await work(db);
  } finally {
    await closeAsync(db);
  }
}

async function listOverrides(portfolio) {
  return withDatabase((db) => {
    const params = [];
    const where = portfolio ? 'WHERE portfolio = ?' : '';
    if (portfolio) params.push(portfolio);
    return allAsync(
      db,
      `SELECT id, portfolio, symbol, avg_cost, qty_at_override, as_of_date, source, notes, created_at, updated_at
       FROM cost_basis_overrides
       ${where}
       ORDER BY portfolio, symbol`,
      params
    );
  });
}

async function getOverridesMap(portfolio) {
  const rows = await listOverrides(portfolio);
  return new Map(rows.map((r) => [r.symbol, r]));
}

/** Upsert a single override. Returns the number of changes. */
async function upsertOverride({ portfolio, symbol, avgCost, qtyAtOverride = null, asOfDate = null, source = 'manual', notes = null }) {
  return withDatabase((db) =>
    runAsync(
      db,
      `INSERT INTO cost_basis_overrides (portfolio, symbol, avg_cost, qty_at_override, as_of_date, source, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(portfolio, symbol) DO UPDATE SET
         avg_cost = excluded.avg_cost,
         qty_at_override = excluded.qty_at_override,
         as_of_date = excluded.as_of_date,
         source = excluded.source,
         notes = excluded.notes,
         updated_at = datetime('now')`,
      [portfolio, symbol, avgCost, qtyAtOverride, asOfDate, source, notes]
    )
  );
}

/** Bulk upsert from an array of override objects. */
async function bulkUpsertOverrides(overrides) {
  return withDatabase(async (db) => {
    await runAsync(db, 'BEGIN TRANSACTION');
    try {
      let count = 0;
      for (const o of overrides) {
        await runAsync(
          db,
          `INSERT INTO cost_basis_overrides (portfolio, symbol, avg_cost, qty_at_override, as_of_date, source, notes, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(portfolio, symbol) DO UPDATE SET
             avg_cost = excluded.avg_cost,
             qty_at_override = excluded.qty_at_override,
             as_of_date = excluded.as_of_date,
             source = excluded.source,
             notes = excluded.notes,
             updated_at = datetime('now')`,
          [o.portfolio, o.symbol, o.avgCost, o.qtyAtOverride || null, o.asOfDate || null, o.source || 'csv-import', o.notes || null]
        );
        count += 1;
      }
      await runAsync(db, 'COMMIT');
      return { upserted: count };
    } catch (err) {
      await runAsync(db, 'ROLLBACK');
      throw err;
    }
  });
}

async function deleteOverride(portfolio, symbol) {
  return withDatabase((db) =>
    runAsync(db, 'DELETE FROM cost_basis_overrides WHERE portfolio = ? AND symbol = ?', [portfolio, symbol])
  );
}

module.exports = {
  listOverrides,
  getOverridesMap,
  upsertOverride,
  bulkUpsertOverrides,
  deleteOverride,
};
