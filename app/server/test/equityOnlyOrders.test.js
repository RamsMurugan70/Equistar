// Equity outputs must ignore F&O rows in the orders table.
//
// The fixture is the exact failure: an option BOUGHT and left to expire, with no closing fill,
// because the broker never reports its expiry-day auto square-off. Left unfiltered it is net-long
// forever and every equity path reads it as a holding. Beside it sits ordinary equity — one stock
// still held, one bought and sold — which must come through untouched.
//
// Runs against a throwaway database in the OS temp directory. Nothing here touches real data.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const sqlite3 = require('sqlite3');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'equistar-eq-'));
const DB = path.join(dir, 'app.db');

// Configure the app for this database BEFORE any source module reads its environment.
process.env.DB_PATH = DB;
process.env.MARKET_DB_PATH = '';          // nothing attached; this file stands alone
process.env.INSTANCE_DATA_DIR = dir;
process.env.PORTFOLIO_ICICI = 'ICICI';
process.env.PORTFOLIO_ZERODHA = 'Zerodha';

// _heldBySymbol is module-private; expose it to this test process without editing the source.
const origCompile = Module.prototype._compile;
Module.prototype._compile = function patched(content, filename) {
  if (filename.replace(/\\/g, '/').endsWith('universe/universeScannerService.js')) {
    content += '\nmodule.exports.__heldBySymbol = _heldBySymbol;\n';
  }
  return origCompile.call(this, content, filename);
};

// ── fixture ────────────────────────────────────────────────────────────────
const EXPIRED_OPTION = 'NIFTY 01Sep26 24050 CE';   // bought, never closed, expired
const NOSPACE_OPTION = 'NIFTY25SEP2624000PE';      // contract code with no spaces, no exchange
const SHORT_OPTION = 'SRF 29Sep26 2600 CE';        // written: its only fill is a SELL
// Written, AND coded with no spaces. To the old space-based test this was an equity whose sells
// exceed its buys — exactly what the cost-basis coverage report exists to flag as missing history.
const NOSPACE_SHORT = 'SRF29SEP262600CE';
const OPTIONS = [EXPIRED_OPTION, NOSPACE_OPTION, SHORT_OPTION, NOSPACE_SHORT];

function build() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB);
    db.serialize(() => {
      db.run(`CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, legacy_order_id INTEGER, trade_date TEXT NOT NULL,
        portfolio TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, quantity REAL NOT NULL,
        price REAL NOT NULL, exchange TEXT, created_at TEXT, imported_at TEXT DEFAULT CURRENT_TIMESTAMP,
        charges REAL DEFAULT 0, trade_time TEXT, broker_order_id TEXT, broker_symbol TEXT)`);
      db.run(`CREATE TABLE import_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, source_type TEXT NOT NULL,
        source_name TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT,
        rows_seen INTEGER DEFAULT 0, rows_inserted INTEGER DEFAULT 0, rows_skipped INTEGER DEFAULT 0, notes TEXT)`);
      db.run(`CREATE TABLE portfolio_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, legacy_snapshot_id INTEGER,
        portfolio TEXT NOT NULL, snapshot_date TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT,
        imported_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
      db.run(`CREATE TABLE portfolio_summary (id INTEGER PRIMARY KEY AUTOINCREMENT, legacy_summary_id INTEGER,
        summary_date TEXT NOT NULL, portfolio TEXT NOT NULL, total_invested REAL DEFAULT 0,
        total_value REAL DEFAULT 0, day_change_value REAL DEFAULT 0, day_change_pct REAL DEFAULT 0,
        net_inflow REAL DEFAULT 0, stock_count INTEGER DEFAULT 0, created_at TEXT,
        imported_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
      db.run(`CREATE TABLE recommendations (id INTEGER PRIMARY KEY AUTOINCREMENT, legacy_recommendation_id INTEGER,
        recommendation_date TEXT NOT NULL, advisor TEXT NOT NULL, symbol TEXT NOT NULL,
        action_type TEXT NOT NULL, cmp REAL, target_price REAL, stop_loss REAL, timeframe TEXT,
        status TEXT, notes TEXT, created_at TEXT, imported_at TEXT DEFAULT CURRENT_TIMESTAMP)`);

      const o = db.prepare('INSERT INTO orders (trade_date, portfolio, symbol, side, quantity, price, exchange) VALUES (?,?,?,?,?,?,?)');
      o.run('2026-08-01', 'ICICI', 'RELIANCE', 'BUY', 10, 100, 'NSE');          // equity, still held
      o.run('2026-07-01', 'ICICI', 'TCS', 'BUY', 5, 3000, 'NSE');               // equity, bought...
      o.run('2026-09-03', 'ICICI', 'TCS', 'SELL', 5, 3200, 'NSE');              // ...and sold: a real exit
      o.run('2026-08-28', 'ICICI', EXPIRED_OPTION, 'BUY', 65, 11.7, 'NFO');     // expired, never closed
      o.run('2026-09-01', 'ICICI', NOSPACE_OPTION, 'BUY', 50, 10, '');          // no-space code, no exchange
      o.run('2026-09-02', 'ICICI', SHORT_OPTION, 'SELL', 200, 5, 'NFO');        // a short-option ENTRY
      o.run('2026-09-04', 'ICICI', NOSPACE_SHORT, 'SELL', 200, 5, '');          // written, no-space, no exchange
      o.finalize();

      // Breeze demat imports carry no cost basis, so total_invested is 0 and the dashboard falls
      // back to computing it from orders — the path the option would inflate.
      db.run(`INSERT INTO portfolio_summary (summary_date, portfolio, total_invested, total_value, stock_count)
              VALUES ('2026-09-05', 'ICICI', 0, 1500, 1)`);
    });
    db.close((e) => (e ? reject(e) : resolve()));
  });
}

const hasOption = (value) => {
  const s = JSON.stringify(value);
  return OPTIONS.some((o) => s.includes(o));
};

test.before(build);
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('getAvgCostBySymbol returns the held stock and no option', async () => {
  const { getAvgCostBySymbol } = require('../src/repositories/ordersRepository');
  const rows = await getAvgCostBySymbol('ICICI');
  assert.deepStrictEqual(rows.map((r) => r.symbol), ['RELIANCE']);    // TCS nets to 0; options gone
  assert.strictEqual(rows[0].avg_cost, 100);
});

test('sell evaluator lists offer the stock sale and no option', async () => {
  const repo = require('../src/repositories/ordersRepository');
  const sold = await repo.listSoldSymbols();
  assert.deepStrictEqual(sold.map((r) => r.symbol), ['TCS']);

  const dates = await repo.listSellDates();
  assert.deepStrictEqual(dates.map((d) => [d.sale_date, d.sell_count]), [['2026-09-03', 1]]);

  assert.deepStrictEqual(await repo.listSoldSymbolsForDate('2026-09-02'), []);   // only the short option sold that day
  assert.deepStrictEqual(await repo.listSoldSymbolsForDate('2026-09-04'), []);   // only the no-space short
  assert.deepStrictEqual((await repo.listSoldSymbolsForDate('2026-09-03')).map((r) => r.symbol), ['TCS']);
});

test('dashboard computes invested from equity orders only', async () => {
  const { getDashboardSummary } = require('../src/repositories/dashboardRepository');
  const d = await getDashboardSummary();
  const icici = d.portfolioBreakdown.find((b) => b.portfolio === 'ICICI');
  // RELIANCE 10 x 100. With the options counted it would read 1000 + 760.50 + 500.
  assert.strictEqual(Number(icici.total_invested), 1000);
  assert.strictEqual(Number(d.totals.totalInvested ?? d.totals.total_invested), 1000);
});

test('universe-scanner held set contains the stock and no option', async () => {
  const svc = require('../src/services/universe/universeScannerService');
  const held = await svc.__heldBySymbol();
  assert.ok(held.has('RELIANCE'), 'the held stock must be present');
  assert.ok(!hasOption([...held.keys()]), `option found in held set: ${[...held.keys()]}`);
});

test('held-from-orders lists the stock and no option', async () => {
  const portfolioService = require('../src/services/portfolio/portfolioService');
  const held = await portfolioService.getHeldSymbolsFromOrders();
  assert.ok(held.ICICI.includes('RELIANCE'));
  assert.ok(!hasOption(held), `option found: ${JSON.stringify(held)}`);
});

test('cost-basis coverage assesses equity only — including a contract code with no spaces', async () => {
  const { assessCoverage } = require('../src/services/portfolio/costBasisCoverageService');
  const report = await assessCoverage({});
  assert.ok(!hasOption(report), `option assessed as equity: ${JSON.stringify(report).slice(0, 300)}`);
});

test('the fixture really does exercise the leak', async () => {
  // Guards against a fixture that passes for the wrong reason: read the same rows with no filter
  // and confirm the options ARE there to be excluded.
  const { openDatabase, allAsync, closeAsync } = require('../src/db/connection');
  const db = openDatabase();
  try {
    const netLong = await allAsync(db, `SELECT symbol FROM orders GROUP BY symbol
      HAVING SUM(CASE WHEN side='BUY' THEN quantity ELSE -quantity END) > 0 ORDER BY symbol`);
    assert.deepStrictEqual(netLong.map((r) => r.symbol).sort(), [EXPIRED_OPTION, NOSPACE_OPTION, 'RELIANCE'].sort());
    const soldShort = await allAsync(db, `SELECT DISTINCT symbol FROM orders WHERE side='SELL' ORDER BY symbol`);
    assert.deepStrictEqual(soldShort.map((r) => r.symbol).sort(), [NOSPACE_SHORT, SHORT_OPTION, 'TCS'].sort());
  } finally { await closeAsync(db); }
});
