// Stores external (third-party) stock picks — e.g. investing.com ProPicks.
// We keep only factual data points (symbol, action, price-when-added, return,
// date) plus a link back to the source; no proprietary write-ups are stored.
const { openDatabase, allAsync, runAsync, closeAsync } = require('../db/connection');

async function ensureSchema(db) {
  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS external_recommendations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      source        TEXT NOT NULL,
      strategy      TEXT NOT NULL,
      symbol        TEXT,
      exchange      TEXT,
      code          TEXT,
      company       TEXT,
      action        TEXT,
      price_added   REAL,
      return_pct    REAL,
      is_live       INTEGER,
      stock_url     TEXT,
      as_of_date    TEXT,
      captured_at   TEXT,
      first_seen_at TEXT,
      removed_at    TEXT
    )`);
  // Migrate older DBs that predate first_seen_at/removed_at.
  const cols = await allAsync(db, 'PRAGMA table_info(external_recommendations)');
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('first_seen_at')) {
    await runAsync(db, 'ALTER TABLE external_recommendations ADD COLUMN first_seen_at TEXT');
  }
  if (!names.has('removed_at')) {
    await runAsync(db, 'ALTER TABLE external_recommendations ADD COLUMN removed_at TEXT');
  }
}

const pickKey = (p) => (p.symbol || p.code || p.company || '').toUpperCase();

// Fraction of the stored rows an incoming sync must still contain before we trust it enough to
// delete the rest. The scraper polls a client-rendered table and gives up after ~15s, so a slow
// page can hand us a genuine-looking payload that is really the first two rows. Replacing on
// that would throw away the strategy's history and look like investing.com had dropped it.
const PRUNE_FLOOR = 0.6;

// A sync sends the full current Added+Removed list for a strategy.
//
// UPSERT, THEN PRUNE. Each pick is upserted per-symbol so a symbol already on the list keeps its
// original first_seen_at (the true "added on" date) rather than being stamped "now" on every
// sync; only genuinely new symbols get a fresh first_seen_at, and a symbol whose action flips to
// Removed gets removed_at stamped at that point. A plain DELETE-then-INSERT would be simpler and
// would destroy exactly that history, which is why it is not done that way.
//
// The prune is the second half, and it is what makes this function match its name. Without it a
// pick that scrolled off investing.com's visible Picks History stayed in the table for good,
// still rendering in Equix with whatever price and return it had on the day it fell out of view
// — indistinguishable from a live row, and quietly ageing.
async function replaceStrategy(source, strategy, picks, meta = {}) {
  const db = openDatabase();
  try {
    await ensureSchema(db);
    await runAsync(db, 'BEGIN TRANSACTION');
    const existingRows = await allAsync(db,
      'SELECT * FROM external_recommendations WHERE source = ? AND strategy = ?', [source, strategy]);
    const existingByKey = new Map(existingRows.map((r) => [pickKey(r), r]));

    const now = new Date().toISOString();
    let inserted = 0;
    let updated = 0;
    for (const p of picks) {
      const key = pickKey(p);
      const existing = key ? existingByKey.get(key) : null;
      if (!existing) {
        await runAsync(db,
          `INSERT INTO external_recommendations
             (source, strategy, symbol, exchange, code, company, action, price_added, return_pct, is_live, stock_url, as_of_date, captured_at, first_seen_at, removed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [source, strategy,
           p.symbol || null, p.exchange || null, p.code || null, p.company || null,
           p.action || null, p.priceAdded ?? null, p.returnPct ?? null, p.isLive ? 1 : 0,
           p.stockUrl || null, meta.asOfDate || null, now,
           now, p.action === 'Removed' ? now : null]);
        inserted += 1;
      } else {
        const actionChangedToRemoved = existing.action !== 'Removed' && p.action === 'Removed';
        const actionChangedToAdded = existing.action === 'Removed' && p.action === 'Added';
        const removedAt = actionChangedToRemoved ? now : (actionChangedToAdded ? null : existing.removed_at);
        const firstSeenAt = actionChangedToAdded ? now : (existing.first_seen_at || now);
        await runAsync(db,
          `UPDATE external_recommendations SET
             symbol = ?, exchange = ?, code = ?, company = ?, action = ?,
             price_added = ?, return_pct = ?, is_live = ?, stock_url = ?,
             as_of_date = ?, captured_at = ?, first_seen_at = ?, removed_at = ?
           WHERE id = ?`,
          [p.symbol || existing.symbol, p.exchange || existing.exchange, p.code || existing.code, p.company || existing.company,
           p.action || null, p.priceAdded ?? null, p.returnPct ?? null, p.isLive ? 1 : 0,
           p.stockUrl || existing.stock_url, meta.asOfDate || null, now, firstSeenAt, removedAt,
           existing.id]);
        updated += 1;
      }
    }
    // ── Prune rows the source no longer lists ────────────────────────────────
    const seen = new Set(picks.map(pickKey).filter(Boolean));
    const stale = existingRows.filter((r) => !seen.has(pickKey(r)));

    // Only prune when the payload plausibly IS the full list. `matched` counts how many of the
    // stored rows this sync still knows about — a complete scrape keeps nearly all of them, a
    // truncated one keeps a handful. An empty table is exempt because there is nothing to lose.
    const matched = existingRows.length - stale.length;
    const coverage = existingRows.length ? matched / existingRows.length : 1;
    const trustworthy = coverage >= PRUNE_FLOOR;

    let removed = 0;
    if (trustworthy && stale.length) {
      // Deleted by id, inside the same transaction as the upserts, so a sync is all-or-nothing.
      for (const r of stale) {
        await runAsync(db, 'DELETE FROM external_recommendations WHERE id = ?', [r.id]);
        removed += 1;
      }
    }

    await runAsync(db, 'COMMIT');

    // Said out loud rather than silently skipped: a sync that declines to prune is a sync whose
    // scrape was probably incomplete, and that is worth seeing in the log before it becomes
    // "why is this strategy showing a stock investing.com dropped months ago".
    if (!trustworthy && stale.length) {
      console.warn(`⚠ ${strategy}: kept ${stale.length} row(s) the sync did not list — it covered `
        + `only ${Math.round(coverage * 100)}% of what is stored, which reads as a partial scrape. `
        + 'Re-sync from a fully loaded Picks History to prune them.');
    }

    return {
      inserted, updated, removed, capturedAt: now,
      pruneSkipped: !trustworthy && stale.length ? stale.length : 0,
    };
  } catch (e) {
    await runAsync(db, 'ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await closeAsync(db);
  }
}

async function listAll(source) {
  const db = openDatabase();
  try {
    await ensureSchema(db);
    const params = [];
    let where = '';
    if (source) { where = 'WHERE source = ?'; params.push(source); }
    // NEWEST FIRST, BY THE DATE THE ROW ACTUALLY SHOWS.
    //
    // `id ASC` sorted by insertion order, so a strategy listed August's picks above September's
    // — the opposite of what anyone scanning the table wants. The sort key below is deliberately
    // the same expression the UI uses to pick which date to print (removed_at for a removed
    // pick, first_seen_at for a live one), so the column you read is the column it is ordered by.
    return await allAsync(db,
      `SELECT * FROM external_recommendations ${where}
        ORDER BY strategy ASC,
                 CASE action WHEN 'Added' THEN 0 ELSE 1 END,
                 CASE WHEN action = 'Removed' THEN COALESCE(removed_at, captured_at)
                      ELSE COALESCE(first_seen_at, captured_at) END DESC,
                 id DESC`,
      params);
  } finally {
    await closeAsync(db);
  }
}

module.exports = { replaceStrategy, listAll };
