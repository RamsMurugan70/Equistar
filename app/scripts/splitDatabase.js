// Builds EquiStar's two databases from a copy of the desktop app's single one.
//
//   market.db      the shared half: scans, prices, fundamentals, corporate actions. Seeded with
//                  the desktop app's real history so participants open a working Top 25 on day
//                  one instead of an empty screen waiting for a scan.
//   template.db    an EMPTY participant database — the schema of the per-user half and nothing
//                  else. The hub copies this file to create each new participant.
//
// NOTHING PERSONAL CROSSES OVER. The source database is one person's trading history: orders,
// holdings, broker credentials, realised gains. Only the market tables are copied, and the
// participant half is created as schema-only. That is the one property of this script that
// actually matters, so it is asserted at the end rather than assumed — the script refuses to
// finish if a single row of anyone's orders made it into the template.
//
//   node scripts/splitDatabase.js --from "D:\\AI Projects\\ZTA-Codex\\data\\app.db"
//   node scripts/splitDatabase.js --from "..." --out "D:\\AI Projects\\EquiStar\\data"
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

// Shared: identical for every participant, expensive to fetch, safe for all to read.
const MARKET_TABLES = [
  'universe_scores', 'universe_top_daily', 'universe_bottom_daily',
  'nse_symbol_master', 'stock_fundamentals', 'stock_shareholding',
  'corporate_actions', 'market_cache', 'nifty_candles',
];

// Private to one participant. Created empty; never copied.
const USER_TABLES = [
  'orders', 'orders_quarantine', 'portfolio_snapshots', 'portfolio_snapshots_quarantine',
  'portfolio_summary', 'snapshot_quality', 'capture_ledger', 'cost_basis_overrides',
  'holding_scores', 'import_runs', 'recommendations', 'equity_advice',
  'external_recommendations', 'broker_tips', 'migration_audit',
];

// Deliberately in neither list: the tg_* advisor tables, fno_lot_sizes and daily_brokerage are
// options and F&O, which EquiStar does not ship.

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? null : process.argv[i + 1];
};

const open = (p, mode) => new Promise((res, rej) => {
  const db = new sqlite3.Database(p, mode, (e) => (e ? rej(e) : res(db)));
});
const all = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const run = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, function cb(e) { return e ? rej(e) : res(this); }));
const close = (db) => new Promise((res) => db.close(() => res()));

async function schemaOf(src, tables) {
  const rows = await all(src,
    `SELECT name, type, sql FROM sqlite_master
      WHERE sql IS NOT NULL AND (
        (type = 'table' AND name IN (${tables.map(() => '?').join(',')}))
        OR (type = 'index' AND tbl_name IN (${tables.map(() => '?').join(',')})))`,
    [...tables, ...tables]);
  // Tables before indexes, or an index lands on a table that does not exist yet.
  return [...rows.filter((r) => r.type === 'table'), ...rows.filter((r) => r.type !== 'table')];
}

async function build(srcPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const marketPath = path.join(outDir, 'market.db');
  const templatePath = path.join(outDir, 'template.db');
  for (const p of [marketPath, templatePath]) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(p + suffix)) fs.unlinkSync(p + suffix);
    }
  }

  const src = await open(srcPath, sqlite3.OPEN_READONLY);
  const present = new Set((await all(src, "SELECT name FROM sqlite_master WHERE type='table'")).map((r) => r.name));

  // ── market.db: schema and data ────────────────────────────────────────────
  const market = await open(marketPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
  const marketTables = MARKET_TABLES.filter((t) => present.has(t));
  for (const s of await schemaOf(src, marketTables)) await run(market, s.sql);

  const counts = {};
  for (const t of marketTables) {
    const rows = await all(src, `SELECT * FROM ${t}`);
    if (rows.length) {
      const cols = Object.keys(rows[0]);
      const stmt = `INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
      await run(market, 'BEGIN');
      for (const r of rows) await run(market, stmt, cols.map((c) => r[c]));
      await run(market, 'COMMIT');
    }
    counts[t] = rows.length;
  }

  // ── template.db: schema only ──────────────────────────────────────────────
  const template = await open(templatePath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
  const userTables = USER_TABLES.filter((t) => present.has(t));
  for (const s of await schemaOf(src, userTables)) await run(template, s.sql);

  // ── The check this script exists to pass ──────────────────────────────────
  // Asserted, not assumed: shipping one person's trades to 25 strangers is the worst thing this
  // script could do, and it would look exactly like success.
  const leaked = [];
  for (const t of userTables) {
    const [{ n }] = await all(template, `SELECT COUNT(*) AS n FROM ${t}`);
    if (n > 0) leaked.push(`${t} (${n} rows)`);
  }
  await close(src); await close(market); await close(template);

  if (leaked.length) {
    throw new Error(`The participant template is not empty: ${leaked.join(', ')}. `
      + 'Refusing to leave it in place.');
  }

  return { marketPath, templatePath, counts, marketTables, userTables };
}

async function main() {
  const from = arg('from');
  const outDir = arg('out') || path.resolve(__dirname, '..', '..', 'data');
  if (!from || !fs.existsSync(from)) {
    console.error('\n  Usage: node scripts/splitDatabase.js --from "<path to app.db>" [--out <dir>]\n');
    process.exit(1);
  }

  console.log(`\n  from: ${from}`);
  console.log(`  into: ${outDir}\n`);
  const r = await build(from, outDir);

  console.log('  market.db  (shared by every participant)');
  for (const t of r.marketTables) console.log(`    ${t.padEnd(32)} ${String(r.counts[t]).padStart(7)} rows`);
  console.log(`\n  template.db  (copied per participant, ${r.userTables.length} tables, all empty)`);
  console.log(`    ${r.userTables.join(', ')}`);
  console.log('\n  Verified: no personal data in the template.\n');
}

if (require.main === module) {
  main().catch((e) => { console.error(`\n  Split failed: ${e.message}\n`); process.exit(1); });
}

module.exports = { build, MARKET_TABLES, USER_TABLES };
