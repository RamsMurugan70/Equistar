const { openLegacyDatabase, allAsync, closeAsync } = require('./ztaDatabaseReader');
const { openDatabase } = require('../../db/connection');

async function validateMigration() {
  const legacyDb = openLegacyDatabase();
  const targetDb = openDatabase();
  try {
    const pairs = [
      ['orders', 'orders'],
      ['portfolio_snapshots', 'portfolio_snapshots'],
      ['portfolio_summary', 'portfolio_summary'],
      ['recommendations', 'recommendations'],
    ];

    const results = [];
    for (const [legacyTable, targetTable] of pairs) {
      const legacyCount = (await allAsync(legacyDb, `SELECT COUNT(*) AS count FROM ${legacyTable}`))[0].count;
      const targetCount = (await allAsync(targetDb, `SELECT COUNT(*) AS count FROM ${targetTable}`))[0].count;
      results.push({ legacyTable, targetTable, legacyCount, targetCount, matches: legacyCount === targetCount });
    }
    return results;
  } finally {
    await closeAsync(legacyDb);
    await closeAsync(targetDb);
  }
}

module.exports = {
  validateMigration,
};
