// Storage for equity tips from a named advisor source (e.g. "TechCheckByNiti").
//
// Simpler than the options store next door: an equity tip is one stock with an entry, a stop
// and a target range, so there is no leg set to replay and no event stream needed. What DOES
// need history is the outcome — whether the stop or target was ever hit — because a live
// price only says where the stock is now. Hence the separate hit-tracking columns, stamped
// the first time each level is crossed and never overwritten.
const { openDatabase, allAsync, getAsync, runAsync, closeAsync } = require('../db/connection');

async function ensureSchema(db) {
  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS equity_advice (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      source         TEXT NOT NULL,
      advised_on     TEXT,
      symbol         TEXT,
      stock_text     TEXT,
      matched_name   TEXT,
      action         TEXT,
      entry_low      REAL,
      entry_high     REAL,
      stop_level     REAL,
      stop_closing   INTEGER DEFAULT 0,
      target_low     REAL,
      target_high    REAL,
      target_open    INTEGER DEFAULT 0,
      status         TEXT NOT NULL DEFAULT 'OPEN',
      outcome        TEXT,
      closed_at      TEXT,
      raw_text       TEXT NOT NULL,
      parsed_json    TEXT,
      confidence     REAL,
      -- Outcome history: stamped once, on first crossing. A later pullback must not erase
      -- the fact that the target was reached, and a bounce must not un-hit a stop.
      target_hit_at  TEXT,
      target_hit_px  REAL,
      stop_hit_at    TEXT,
      stop_hit_px    REAL,
      last_px        REAL,
      last_px_at     TEXT,
      notes          TEXT,
      created_at     TEXT,
      UNIQUE(source, symbol, advised_on, raw_text)
    )`);
  await runAsync(db, `CREATE INDEX IF NOT EXISTS idx_eqadv_source ON equity_advice (source, status)`);
}

async function withDb(fn) {
  const db = openDatabase();
  try {
    await ensureSchema(db);
    return await fn(db);
  } finally { await closeAsync(db); }
}

// Returns inserted:false when the same tip text was already saved for that stock and date,
// so re-pasting an overlapping chunk of chat is harmless.
async function saveAdvice(a) {
  return withDb(async (db) => {
    const existing = await getAsync(db,
      'SELECT id FROM equity_advice WHERE source = ? AND IFNULL(symbol,\'\') = ? AND IFNULL(advised_on,\'\') = ? AND raw_text = ?',
      [a.source, a.symbol || '', a.advisedOn || '', a.rawText]);
    if (existing) return { inserted: false, id: existing.id };

    await runAsync(db,
      `INSERT INTO equity_advice
        (source, advised_on, symbol, stock_text, matched_name, action,
         entry_low, entry_high, stop_level, stop_closing, target_low, target_high, target_open,
         status, raw_text, parsed_json, confidence, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [a.source, a.advisedOn || null, a.symbol || null, a.stockText || null, a.matchedName || null,
       a.action || null, a.entryLow ?? null, a.entryHigh ?? null, a.stopLevel ?? null,
       a.stopClosingBasis ? 1 : 0, a.targetLow ?? null, a.targetHigh ?? null, a.targetOpenEnded ? 1 : 0,
       'OPEN', a.rawText, a.parsed ? JSON.stringify(a.parsed) : null, a.confidence ?? null,
       new Date().toISOString()]);
    const row = await getAsync(db, 'SELECT last_insert_rowid() AS id');
    return { inserted: true, id: row.id };
  });
}

async function listAdvice({ source = '', status = '' } = {}) {
  return withDb(async (db) => {
    const where = [];
    const params = [];
    if (source) { where.push('source = ?'); params.push(source); }
    if (status) { where.push('status = ?'); params.push(status); }
    return allAsync(db,
      `SELECT * FROM equity_advice ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY CASE status WHEN 'OPEN' THEN 0 ELSE 1 END,
                 COALESCE(advised_on, created_at) DESC, id DESC`, params);
  });
}

// Record the current price and stamp any level crossed for the FIRST time.
async function applyPriceUpdate(id, { price, asOf, targetHit, stopHit }) {
  return withDb(async (db) => {
    const row = await getAsync(db, 'SELECT * FROM equity_advice WHERE id = ?', [id]);
    if (!row) return null;
    const sets = ['last_px = ?', 'last_px_at = ?'];
    const params = [price, asOf];

    if (targetHit && !row.target_hit_at) { sets.push('target_hit_at = ?', 'target_hit_px = ?'); params.push(asOf, price); }
    if (stopHit && !row.stop_hit_at) { sets.push('stop_hit_at = ?', 'stop_hit_px = ?'); params.push(asOf, price); }

    // A stop that has been hit closes the call; a target reached does too. Stop wins when
    // both somehow fire, because that is the risk-first reading.
    const nowStopped = stopHit || row.stop_hit_at;
    const nowTargeted = targetHit || row.target_hit_at;
    if (row.status === 'OPEN' && (nowStopped || nowTargeted)) {
      sets.push('status = ?', 'outcome = ?', 'closed_at = ?');
      params.push('CLOSED', nowStopped ? 'STOP_HIT' : 'TARGET_HIT', asOf);
    }

    params.push(id);
    await runAsync(db, `UPDATE equity_advice SET ${sets.join(', ')} WHERE id = ?`, params);
    return true;
  });
}

async function setStatus(id, status, outcome) {
  return withDb((db) => runAsync(db,
    'UPDATE equity_advice SET status = ?, outcome = ?, closed_at = ? WHERE id = ?',
    [status, outcome || null, status === 'CLOSED' ? new Date().toISOString() : null, id]));
}

async function setSymbol(id, symbol, matchedName) {
  return withDb((db) => runAsync(db,
    'UPDATE equity_advice SET symbol = ?, matched_name = ? WHERE id = ?', [symbol, matchedName || null, id]));
}

async function remove(id) {
  return withDb((db) => runAsync(db, 'DELETE FROM equity_advice WHERE id = ?', [id]));
}

module.exports = { saveAdvice, listAdvice, applyPriceUpdate, setStatus, setSymbol, remove };
