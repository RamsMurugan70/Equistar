const { openDatabase, allAsync, getAsync, runAsync, closeAsync } = require('../db/connection');
const PF = require('../config/portfolios');

async function ensureSchema() {
  const db = openDatabase();
  try {
    await runAsync(db, `
      CREATE TABLE IF NOT EXISTS broker_tips (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol        TEXT NOT NULL,
        exchange      TEXT NOT NULL DEFAULT 'NSE',
        broker        TEXT NOT NULL,
        rec_date      TEXT NOT NULL,
        action        TEXT NOT NULL DEFAULT 'BUY',
        rec_price     REAL NOT NULL DEFAULT 0,
        target_price  REAL NOT NULL DEFAULT 0,
        stop_loss     REAL NOT NULL DEFAULT 0,
        horizon       TEXT NOT NULL DEFAULT 'medium',
        portfolio     TEXT NOT NULL,
        notes         TEXT DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'active',
        created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at    TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await runAsync(db, `CREATE INDEX IF NOT EXISTS idx_broker_tips_symbol  ON broker_tips (symbol)`);
    await runAsync(db, `CREATE INDEX IF NOT EXISTS idx_broker_tips_status  ON broker_tips (status)`);
    await runAsync(db, `CREATE INDEX IF NOT EXISTS idx_broker_tips_rec_date ON broker_tips (rec_date)`);
  } finally {
    await closeAsync(db);
  }
}

ensureSchema().catch((e) => console.error('brokerTipsRepository ensureSchema:', e.message));

// ── CRUD ──────────────────────────────────────────────────────────────────────

async function listTips({ status, portfolio } = {}) {
  const db = openDatabase();
  try {
    const params = [];
    let where = 'WHERE 1=1';
    if (status)    { where += ' AND t.status = ?';    params.push(status); }
    if (portfolio) { where += ' AND t.portfolio = ?'; params.push(portfolio); }

    const tips = await allAsync(db, `
      SELECT t.*,
             COUNT(o.id)                          AS order_count,
             SUM(CASE WHEN o.side='BUY'  THEN o.quantity ELSE 0 END) AS total_qty_bought,
             SUM(CASE WHEN o.side='SELL' THEN o.quantity ELSE 0 END) AS total_qty_sold,
             SUM(CASE WHEN o.side='BUY'  THEN o.quantity * o.price ELSE 0 END) AS total_invested,
             MIN(CASE WHEN o.side='BUY'  THEN o.price END)           AS first_buy_price,
             MAX(CASE WHEN o.side='BUY'  THEN o.trade_date END)      AS last_buy_date
        FROM broker_tips t
        LEFT JOIN orders o
          ON UPPER(o.symbol) = UPPER(t.symbol)
         AND o.portfolio     = t.portfolio
         AND o.trade_date   >= t.rec_date
       ${where}
       GROUP BY t.id
       ORDER BY t.rec_date DESC
    `, params);

    return tips.map((r) => ({
      ...r,
      order_count:      r.order_count      || 0,
      total_qty_bought: r.total_qty_bought || 0,
      total_qty_sold:   r.total_qty_sold   || 0,
      total_invested:   r.total_invested   || 0,
      first_buy_price:  r.first_buy_price  || null,
      last_buy_date:    r.last_buy_date    || null,
      avg_buy_price:    r.total_qty_bought > 0
        ? Math.round((r.total_invested / r.total_qty_bought) * 100) / 100
        : null,
      net_qty:          (r.total_qty_bought || 0) - (r.total_qty_sold || 0),
    }));
  } finally {
    await closeAsync(db);
  }
}

async function getTip(id) {
  const db = openDatabase();
  try {
    return await getAsync(db, `SELECT * FROM broker_tips WHERE id = ?`, [id]);
  } finally {
    await closeAsync(db);
  }
}

async function addTip({ symbol, exchange, broker, rec_date, action, rec_price, target_price, stop_loss, horizon, portfolio, notes }) {
  const db = openDatabase();
  try {
    const result = await runAsync(db, `
      INSERT INTO broker_tips
        (symbol, exchange, broker, rec_date, action, rec_price, target_price, stop_loss, horizon, portfolio, notes, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      symbol.toUpperCase(), exchange || 'NSE', broker, rec_date,
      action || 'BUY', rec_price || 0, target_price || 0, stop_loss || 0,
      horizon || 'medium', portfolio || PF.ICICI, notes || '',
    ]);
    return result.lastID;
  } finally {
    await closeAsync(db);
  }
}

async function updateTip(id, fields) {
  const allowed = ['symbol','exchange','broker','rec_date','action','rec_price','target_price','stop_loss','horizon','portfolio','notes','status'];
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k} = ?`); params.push(v); }
  }
  if (!sets.length) return;
  sets.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  const db = openDatabase();
  try {
    await runAsync(db, `UPDATE broker_tips SET ${sets.join(', ')} WHERE id = ?`, params);
  } finally {
    await closeAsync(db);
  }
}

async function deleteTip(id) {
  const db = openDatabase();
  try {
    await runAsync(db, `DELETE FROM broker_tips WHERE id = ?`, [id]);
  } finally {
    await closeAsync(db);
  }
}

module.exports = { listTips, getTip, addTip, updateTip, deleteTip };
