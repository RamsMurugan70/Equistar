// A record of whether each trading day was actually captured, per portfolio.
//
// WHY THIS EXISTS: 706 GMRAIRPORT shares were sold across two days whose Kite import never ran.
// Nothing anywhere said so. The position looked like a Rs 80k loss for months because the buys
// were recorded and the sells were not, and the only reason it surfaced at all was that a
// report happened to reconcile holdings against orders.
//
// The fix is not "run the import automatically" — an automated job that cannot log in fails
// just as silently. The fix is to write down, every day, whether the capture succeeded, so a
// miss is a visible row rather than an absence nobody notices.
//
// ── WHY ATTEMPTS ARE RECORDED, NOT INFERRED ──────────────────────────────────
// It is tempting to derive capture from the data: "orders exist for that day, so it worked".
// That is wrong for orders, because a day with no trades legitimately has no rows — absence of
// orders is indistinguishable from absence of capture. Only an explicit record of the attempt
// can tell "you traded nothing" from "we never asked".
//
// Holdings are different: a snapshot either exists or it does not, so history can be backfilled
// from portfolio_snapshots. Order history is backfilled from import_runs, which records the
// trade dates each past import covered.
const { openDatabase, allAsync, getAsync, runAsync, closeAsync } = require('../db/connection');

const KINDS = ['orders', 'holdings'];

async function ensureTable(db) {
  await runAsync(db, `CREATE TABLE IF NOT EXISTS capture_ledger (
    trade_date   TEXT NOT NULL,
    portfolio    TEXT NOT NULL,
    kind         TEXT NOT NULL,          -- 'orders' | 'holdings'
    status       TEXT NOT NULL,          -- 'OK' | 'FAILED'
    rows_written INTEGER DEFAULT 0,
    detail       TEXT,
    attempted_at TEXT,
    PRIMARY KEY (trade_date, portfolio, kind)
  )`);
}

async function withDatabase(work) {
  const db = openDatabase();
  try {
    await ensureTable(db);
    return await work(db);
  } finally {
    await closeAsync(db);
  }
}

// Last write wins: a later successful retry must be able to clear an earlier failure, which is
// the whole point of retrying through the evening.
async function record({ tradeDate, portfolio, kind, status, rows = 0, detail = null }) {
  return withDatabase((db) => runAsync(db,
    `INSERT INTO capture_ledger
       (trade_date, portfolio, kind, status, rows_written, detail, attempted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(trade_date, portfolio, kind) DO UPDATE SET
       status = excluded.status,
       rows_written = excluded.rows_written,
       detail = excluded.detail,
       attempted_at = excluded.attempted_at`,
    [tradeDate, portfolio, kind, status, rows, detail,
     new Date(Date.now() + 330 * 60000).toISOString()]));
}

// NSE trading days, taken from the Nifty candle series rather than a weekday calculation.
// Weekday arithmetic would count every market holiday as a missed capture and bury the real
// gaps in noise; a candle exists only on a day the market actually traded.
async function tradingDays(db, from, to) {
  const rows = await allAsync(db,
    'SELECT date FROM nifty_candles WHERE date >= ? AND date <= ? ORDER BY date', [from, to]);
  return rows.map((r) => r.date);
}

// Fill in what can be known about days that predate the ledger, so existing gaps are visible
// immediately instead of only accruing from today onward.
async function backfill({ from, portfolios }) {
  return withDatabase(async (db) => {
    const to = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const days = await tradingDays(db, from, to);
    let added = 0;

    for (const pf of portfolios) {
      // Holdings: the snapshot is its own proof of capture.
      const snaps = new Set((await allAsync(db,
        'SELECT snapshot_date FROM portfolio_snapshots WHERE portfolio = ? AND snapshot_date >= ?',
        [pf, from])).map((r) => r.snapshot_date));

      // Orders: two kinds of evidence, because neither alone is sufficient.
      //
      //   * import_runs records which trade dates each past import covered. This is the only
      //     thing that can vouch for a day with NO trades — an empty result and an import that
      //     never ran leave the orders table looking identical.
      //   * orders actually present for that day. The implication only runs one way — rows
      //     prove a capture happened, while no rows prove nothing — but it is the only evidence
      //     for data that arrived outside the normal importer, such as the Console tradebook
      //     rows loaded by scripts/repair_geetha_orders.py, which wrote no audit entry. Without
      //     this the ledger reports days as uncaptured that were in fact repaired by hand.
      const covered = new Set();
      for (const row of await allAsync(db,
        `SELECT notes FROM import_runs
          WHERE source_type LIKE '%orders%' AND notes LIKE ? AND notes LIKE '%tradeDates%'`,
        [`%"${pf}"%`])) {
        try {
          for (const d of JSON.parse(row.notes).tradeDates || []) covered.add(d);
        } catch { /* unparseable note */ }
      }
      for (const row of await allAsync(db,
        'SELECT DISTINCT trade_date FROM orders WHERE portfolio = ? AND trade_date >= ?',
        [pf, from])) {
        covered.add(row.trade_date);
      }

      for (const day of days) {
        for (const kind of KINDS) {
          const seen = kind === 'holdings' ? snaps.has(day) : covered.has(day);
          if (!seen) continue;
          const existing = await getAsync(db,
            'SELECT 1 AS x FROM capture_ledger WHERE trade_date = ? AND portfolio = ? AND kind = ?',
            [day, pf, kind]);
          if (existing) continue;
          await runAsync(db,
            `INSERT INTO capture_ledger
               (trade_date, portfolio, kind, status, rows_written, detail, attempted_at)
             VALUES (?, ?, ?, 'OK', 0, 'backfilled from existing records', NULL)`,
            [day, pf, kind]);
          added += 1;
        }
      }
    }
    return { added, days: days.length };
  });
}

// Trading days with no successful capture. `sinceDays` is a lookback, not the whole history:
// the point is to surface what can still be acted on.
async function listGaps({ portfolios, sinceDays = 45 }) {
  return withDatabase(async (db) => {
    const today = new Date(Date.now() + 330 * 60000);
    const to = today.toISOString().slice(0, 10);
    const from = new Date(today.getTime() - sinceDays * 864e5).toISOString().slice(0, 10);
    const days = await tradingDays(db, from, to);

    const ok = new Set((await allAsync(db,
      `SELECT trade_date, portfolio, kind FROM capture_ledger
        WHERE status = 'OK' AND trade_date >= ?`, [from]))
      .map((r) => `${r.trade_date}|${r.portfolio}|${r.kind}`));
    const failed = new Map((await allAsync(db,
      `SELECT trade_date, portfolio, kind, detail FROM capture_ledger
        WHERE status = 'FAILED' AND trade_date >= ?`, [from]))
      .map((r) => [`${r.trade_date}|${r.portfolio}|${r.kind}`, r.detail]));

    const gaps = [];
    for (const day of days) {
      for (const pf of portfolios) {
        for (const kind of KINDS) {
          const k = `${day}|${pf}|${kind}`;
          if (ok.has(k)) continue;
          gaps.push({
            tradeDate: day,
            portfolio: pf,
            kind,
            status: failed.has(k) ? 'FAILED' : 'NEVER_ATTEMPTED',
            detail: failed.get(k) || null,
          });
        }
      }
    }
    return gaps.sort((a, b) => b.tradeDate.localeCompare(a.tradeDate));
  });
}

async function listRecent({ portfolios, days = 10 }) {
  return withDatabase(async (db) => {
    const today = new Date(Date.now() + 330 * 60000);
    const from = new Date(today.getTime() - days * 864e5).toISOString().slice(0, 10);
    const ph = portfolios.map(() => '?').join(',');
    return allAsync(db,
      `SELECT trade_date, portfolio, kind, status, rows_written, detail, attempted_at
         FROM capture_ledger
        WHERE trade_date >= ? AND portfolio IN (${ph})
        ORDER BY trade_date DESC, portfolio, kind`,
      [from, ...portfolios]);
  });
}

module.exports = { record, backfill, listGaps, listRecent, KINDS };
