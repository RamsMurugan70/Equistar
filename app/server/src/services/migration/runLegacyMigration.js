const { openDatabase } = require('../../db/connection');
const { runAsync, closeAsync } = require('./ztaDatabaseReader');
const {
  migrateOrders,
  migratePortfolioSnapshots,
  migratePortfolioSummary,
  migrateRecommendations,
} = require('./legacyTableMigrations');
const { validateMigration } = require('./migrationValidationService');

async function createImportRun(sourceType, sourceName) {
  const db = openDatabase();
  try {
    const startedAt = new Date().toISOString();
    const result = await runAsync(
      db,
      `INSERT INTO import_runs (source_type, source_name, status, started_at) VALUES (?, ?, 'RUNNING', ?)`,
      [sourceType, sourceName, startedAt]
    );
    return { id: result.lastID, startedAt };
  } finally {
    await closeAsync(db);
  }
}

async function finalizeImportRun(id, status, notes, counts) {
  const db = openDatabase();
  try {
    await runAsync(
      db,
      `UPDATE import_runs
       SET status = ?, completed_at = ?, rows_seen = ?, rows_inserted = ?, rows_skipped = ?, notes = ?
       WHERE id = ?`,
      [status, new Date().toISOString(), counts.rowsSeen, counts.rowsInserted, counts.rowsSkipped, notes, id]
    );
  } finally {
    await closeAsync(db);
  }
}

async function run() {
  const runLabel = `legacy-migration-${new Date().toISOString()}`;
  const importRun = await createImportRun('legacy-db', 'ZTA database.sqlite');
  let counts = { rowsSeen: 0, rowsInserted: 0, rowsSkipped: 0 };

  try {
    const results = [];
    for (const migrate of [migrateOrders, migratePortfolioSnapshots, migratePortfolioSummary, migrateRecommendations]) {
      const result = await migrate(runLabel);
      results.push(result);
      counts.rowsSeen += result.sourceCount;
      counts.rowsInserted += result.inserted;
    }

    const validation = await validateMigration();
    await finalizeImportRun(importRun.id, 'COMPLETED', JSON.stringify({ results, validation }), counts);
    console.log(JSON.stringify({ runLabel, results, validation }, null, 2));
  } catch (error) {
    await finalizeImportRun(importRun.id, 'FAILED', error.message, counts);
    console.error('Legacy migration failed:', error);
    process.exitCode = 1;
  }
}

run();
