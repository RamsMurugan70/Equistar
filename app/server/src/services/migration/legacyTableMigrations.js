const { openDatabase } = require('../../db/connection');
const { openLegacyDatabase, allAsync, runAsync, closeAsync } = require('./ztaDatabaseReader');

async function migrateOrders(runLabel) {
  const legacyDb = openLegacyDatabase();
  const targetDb = openDatabase();
  try {
    const rows = await allAsync(legacyDb, `
      SELECT id, date, portfolio, symbol, side, quantity, price, exchange, created_at
      FROM orders
      ORDER BY id
    `);

    for (const row of rows) {
      await runAsync(
        targetDb,
        `INSERT INTO orders
          (legacy_order_id, trade_date, portfolio, symbol, side, quantity, price, exchange, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.date, row.portfolio, row.symbol, row.side, row.quantity, row.price, row.exchange, row.created_at]
      );
    }

    await runAsync(
      targetDb,
      `INSERT INTO migration_audit (run_label, table_name, source_count, target_count, details_json)
       VALUES (?, 'orders', ?, ?, ?)`,
      [runLabel, rows.length, rows.length, JSON.stringify({ source: 'legacy.orders' })]
    );

    return { table: 'orders', sourceCount: rows.length, inserted: rows.length };
  } finally {
    await closeAsync(legacyDb);
    await closeAsync(targetDb);
  }
}

async function migratePortfolioSnapshots(runLabel) {
  const legacyDb = openLegacyDatabase();
  const targetDb = openDatabase();
  try {
    const rows = await allAsync(legacyDb, `
      SELECT id, portfolio, date, data, created_at
      FROM portfolio_snapshots
      ORDER BY id
    `);

    // SELF-CONTAINED SANITY CHECK BEFORE IMPORTING A HISTORICAL SNAPSHOT.
    //
    // This path used to INSERT whatever the legacy table held, with no validation of any kind -
    // importsRepository.saveSnapshot guards the live path, and this one simply bypassed it.
    // That is how 16 bad captures reached portfolio_snapshots in a single run on 2026-04-05:
    // fourteen carrying a seven-stock book that was not the portfolio they were filed under,
    // one with every price null, one with every quantity zero. They then corrupted every
    // holdings-derived figure until they were quarantined months later.
    //
    // Only self-contained checks are possible here - a bulk historical import has no "last good
    // capture" to compare against - but they are exactly the ones that would have caught the
    // unpriced and zero-quantity rows. A row that fails is SKIPPED and reported, never written:
    // a missing day is visible and recoverable, a wrong day is neither.
    const skipped = [];
    for (const row of rows) {
      let holdings = [];
      try { holdings = JSON.parse(row.data).portfolio || []; } catch { /* unparseable */ }
      const priced = holdings.filter((h) => h.curVal != null || h.avgCost != null).length;
      const totalQty = holdings.reduce((t, h) => t + (Number(h.qty) || 0), 0);

      let problem = null;
      if (!holdings.length) problem = 'no holdings in the payload';
      else if (priced / holdings.length < 0.7) problem = `only ${priced}/${holdings.length} holdings priced`;
      else if (totalQty <= 0) problem = 'every quantity is zero';

      if (problem) {
        skipped.push({ legacyId: row.id, portfolio: row.portfolio, date: row.date, problem });
        continue;
      }

      await runAsync(
        targetDb,
        `INSERT INTO portfolio_snapshots
          (legacy_snapshot_id, portfolio, snapshot_date, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [row.id, row.portfolio, row.date, row.data, row.created_at]
      );
    }
    if (skipped.length) {
      console.warn(`  !! skipped ${skipped.length} legacy snapshot(s) that failed the integrity check:`);
      for (const k of skipped) console.warn(`     ${k.portfolio} ${k.date} (legacy id ${k.legacyId}) - ${k.problem}`);
    }

    await runAsync(
      targetDb,
      `INSERT INTO migration_audit (run_label, table_name, source_count, target_count, details_json)
       VALUES (?, 'portfolio_snapshots', ?, ?, ?)`,
      [runLabel, rows.length, rows.length - skipped.length,
       JSON.stringify({ source: 'legacy.portfolio_snapshots', skipped })]
    );

    return { table: 'portfolio_snapshots', sourceCount: rows.length, inserted: rows.length };
  } finally {
    await closeAsync(legacyDb);
    await closeAsync(targetDb);
  }
}

async function migratePortfolioSummary(runLabel) {
  const legacyDb = openLegacyDatabase();
  const targetDb = openDatabase();
  try {
    const rows = await allAsync(legacyDb, `
      SELECT id, date, portfolio, total_invested, total_value, day_change_value, day_change_pct, net_inflow, stock_count, created_at
      FROM portfolio_summary
      ORDER BY id
    `);

    for (const row of rows) {
      await runAsync(
        targetDb,
        `INSERT INTO portfolio_summary
          (legacy_summary_id, summary_date, portfolio, total_invested, total_value, day_change_value, day_change_pct, net_inflow, stock_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.date, row.portfolio, row.total_invested, row.total_value, row.day_change_value, row.day_change_pct, row.net_inflow, row.stock_count, row.created_at]
      );
    }

    await runAsync(
      targetDb,
      `INSERT INTO migration_audit (run_label, table_name, source_count, target_count, details_json)
       VALUES (?, 'portfolio_summary', ?, ?, ?)`,
      [runLabel, rows.length, rows.length, JSON.stringify({ source: 'legacy.portfolio_summary' })]
    );

    return { table: 'portfolio_summary', sourceCount: rows.length, inserted: rows.length };
  } finally {
    await closeAsync(legacyDb);
    await closeAsync(targetDb);
  }
}

async function migrateRecommendations(runLabel) {
  const legacyDb = openLegacyDatabase();
  const targetDb = openDatabase();
  try {
    const rows = await allAsync(legacyDb, `
      SELECT id, date, advisor, symbol, type, cmp, target_price, stop_loss, timeframe, status, notes, created_at
      FROM recommendations
      ORDER BY id
    `);

    for (const row of rows) {
      await runAsync(
        targetDb,
        `INSERT INTO recommendations
          (legacy_recommendation_id, recommendation_date, advisor, symbol, action_type, cmp, target_price, stop_loss, timeframe, status, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.date, row.advisor, row.symbol, row.type, row.cmp, row.target_price, row.stop_loss, row.timeframe, row.status, row.notes, row.created_at]
      );
    }

    await runAsync(
      targetDb,
      `INSERT INTO migration_audit (run_label, table_name, source_count, target_count, details_json)
       VALUES (?, 'recommendations', ?, ?, ?)`,
      [runLabel, rows.length, rows.length, JSON.stringify({ source: 'legacy.recommendations' })]
    );

    return { table: 'recommendations', sourceCount: rows.length, inserted: rows.length };
  } finally {
    await closeAsync(legacyDb);
    await closeAsync(targetDb);
  }
}

module.exports = {
  migrateOrders,
  migratePortfolioSnapshots,
  migratePortfolioSummary,
  migrateRecommendations,
};
