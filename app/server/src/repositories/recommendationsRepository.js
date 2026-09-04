const { openDatabase, allAsync, runAsync, getAsync, closeAsync } = require('../db/connection');

async function withDatabase(work) {
  const db = openDatabase();
  try {
    return await work(db);
  } finally {
    await closeAsync(db);
  }
}

async function listRecommendations() {
  return withDatabase(async (db) => {
    return allAsync(
      db,
      `SELECT recommendation_date, advisor, symbol, action_type, cmp, target_price, stop_loss, timeframe, status, notes, created_at
       FROM recommendations
       ORDER BY recommendation_date DESC, id DESC`
    );
  });
}

// Insert a new recommendation. Returns {id, duplicate:false}; if an ACTIVE
// recommendation with the same symbol+action already exists, skips and
// returns {duplicate:true} so the UI can tell the user.
async function insertRecommendation(rec) {
  return withDatabase(async (db) => {
    const dup = await getAsync(
      db,
      `SELECT id FROM recommendations
       WHERE symbol = ? AND action_type = ? AND LOWER(status) = 'active'`,
      [rec.symbol, rec.actionType]
    );
    if (dup) return { duplicate: true, id: dup.id };

    const result = await runAsync(
      db,
      `INSERT INTO recommendations
        (recommendation_date, advisor, symbol, action_type, cmp, target_price,
         stop_loss, timeframe, status, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rec.recommendationDate, rec.advisor, rec.symbol, rec.actionType,
        rec.cmp ?? null, rec.targetPrice ?? null, rec.stopLoss ?? null,
        rec.timeframe ?? null, rec.status || 'Active', rec.notes ?? null,
        new Date().toISOString(),
      ]
    );
    return { duplicate: false, id: result?.lastID ?? null };
  });
}

module.exports = {
  listRecommendations,
  insertRecommendation,
};
