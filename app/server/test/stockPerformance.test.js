// The per-stock performance report, against a throwaway database with prices already cached.
//
// Every price the service needs is pre-loaded with a fresh fetch time, so nothing is stale and no
// request ever leaves the process. The fixture carries the three mistakes this report must not
// make: a bonus issue that raw closes turn into a crash, a Nifty figure that drifts with the
// portfolio selection, and "held for the whole period" guessed where no record says so.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'equistar-sp-'));
const DB = path.join(dir, 'app.db');
process.env.DB_PATH = DB;
process.env.MARKET_DB_PATH = '';
process.env.INSTANCE_DATA_DIR = dir;
process.env.PORTFOLIO_ICICI = 'ICICI';
process.env.PORTFOLIO_ZERODHA = 'Zerodha';

const DAY = 86400000;
const todayIst = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const T0 = Date.parse(`${todayIst}T00:00:00Z`);

// Weekdays over two years, oldest first.
const DATES = [];
for (let t = T0 - 730 * DAY; t <= T0; t += DAY) {
  const wd = new Date(t).getUTCDay();
  if (wd !== 0 && wd !== 6) DATES.push(iso(t));
}
const BONUS_DATE = DATES[DATES.length - 30];     // six weeks ago: inside the 3M window
const NEWCO_LISTED = DATES[DATES.length - 12];   // listed during every window

function series(fn) { return DATES.map((d, i) => ({ date: d, ...fn(d, i) })); }
const PRICES = {
  // Nifty: a gentle wave so the window figure differs by period.
  '^NSEI': series((d, i) => { const c = 20000 + i * 4 + 300 * Math.sin(i / 17); return { close: c, adjclose: c }; }),
  AAA: series((d, i) => { const c = 100 + i * 0.2; return { close: c, adjclose: c }; }),
  // A 4:1 bonus: the traded price falls to a fifth; the adjusted series does not move.
  BON: series((d, i) => {
    const adj = 500 + i * 0.5;
    return { adjclose: adj / 5, close: d < BONUS_DATE ? adj : adj / 5 };
  }),
  // Trades one day in five, so its last bar before the window start is usually days earlier than
  // Nifty's. Anchoring Nifty on each stock's own first bar would give this row a different Nifty.
  // It does trade on the last day, so its window ends where Nifty's does.
  THIN: series((d, i) => ({ close: 80 + i * 0.1, adjclose: 80 + i * 0.1 }))
    .filter((b, i) => (DATES.length - 1 - i) % 5 === 0),
  NEWCO: series(() => ({})).filter((b) => b.date >= NEWCO_LISTED)
    .map((b, i) => ({ ...b, close: 50 + i, adjclose: 50 + i })),
};

const snapshot = (pf, date, holdings) => [pf, date, JSON.stringify({ portfolio: holdings })];
const h = (instrument, qty, curVal) => ({ instrument, qty, curVal, ltp: curVal / qty });

function build() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB);
    db.serialize(() => {
      db.run(`CREATE TABLE portfolio_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, legacy_snapshot_id INTEGER,
        portfolio TEXT NOT NULL, snapshot_date TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT,
        imported_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
      db.run(`CREATE TABLE stock_daily_prices (symbol TEXT NOT NULL, date TEXT NOT NULL, close REAL, adjclose REAL,
        PRIMARY KEY (symbol, date))`);
      db.run(`CREATE TABLE stock_price_meta (symbol TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, last_date TEXT,
        status TEXT, source TEXT, detail TEXT)`);
      // Freshly stamped, so the service never downloads the real one.
      db.run(`CREATE TABLE icici_scrip_master (short_name TEXT PRIMARY KEY, exchange_code TEXT NOT NULL,
        series TEXT, isin TEXT, company_name TEXT, updated_at TEXT NOT NULL)`);
      db.run(`INSERT INTO icici_scrip_master VALUES ('THNCOD', 'THIN', 'EQ', NULL, 'THIN TRADING LIMITED', CURRENT_TIMESTAMP),
        ('AAACOD', 'AAA', 'EQ', NULL, 'AAA LIMITED', CURRENT_TIMESTAMP),
        ('AAA', 'ZZZ', 'EQ', NULL, 'A CLASHING CODE', CURRENT_TIMESTAMP)`);

      const s = db.prepare('INSERT INTO portfolio_snapshots (portfolio, snapshot_date, payload_json) VALUES (?,?,?)');
      // ICICI: a record from 100 days ago (before the 3M start) holding AAA only — so BON was
      // bought inside 3M. 6M and 1Y start before this record, so for them it is unknown.
      s.run(...snapshot('ICICI', iso(T0 - 100 * DAY), [h('AAA', 10, 1000)]));
      // THIN is held under an ICICI broker code the hand map does not know; only the security
      // master below turns it into the symbol its prices are stored under.
      s.run(...snapshot('ICICI', todayIst, [h('AAA', 10, 3000), h('BON', 5, 1000), h('THNCOD', 4, 400)]));
      // Zerodha: only today's record, so "held at start" is unknown for every period.
      s.run(...snapshot('Zerodha', todayIst, [h('AAA', 5, 1500), h('NEWCO', 10, 600), h('DEADCO', 3, 0)]));
      s.finalize();

      db.run('BEGIN');   // one transaction, or two thousand separate commits
      const p = db.prepare('INSERT INTO stock_daily_prices VALUES (?,?,?,?)');
      for (const [sym, bars] of Object.entries(PRICES)) for (const b of bars) p.run(sym, b.date, b.close, b.adjclose);
      p.finalize();
      db.run('COMMIT');
      const now = new Date().toISOString();
      const m = db.prepare('INSERT INTO stock_price_meta VALUES (?,?,?,?,?,?)');
      for (const sym of Object.keys(PRICES)) m.run(sym, now, todayIst, 'OK', sym, null);
      m.run('DEADCO', now, null, 'NO_DATA', 'DEADCO.NS', 'Not found');
      m.finalize();
    });
    db.close((e) => (e ? reject(e) : resolve()));
  });
}

test.before(build);
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const svc = () => require('../src/services/performance/stockPerformanceService');
const bySym = (d) => Object.fromEntries(d.rows.map((r) => [r.symbol, r]));

test('Nifty is identical for every portfolio selection, in every period', async () => {
  for (const period of ['1M', '3M', '6M', '1Y']) {
    const results = await Promise.all(['both', 'ICICI', 'Zerodha']
      .map((portfolio) => svc().getStockPerformance({ period, portfolio })));
    const figures = results.map((d) => d.summary.niftyPct);
    assert.ok(figures[0] != null, `${period}: Nifty figure missing`);
    assert.deepStrictEqual(figures, [figures[0], figures[0], figures[0]], `${period}: Nifty differs by selection`);
    // Every row that spans the whole window is compared against that same figure.
    for (const d of results) {
      for (const r of d.rows.filter((x) => !x.noData && !x.partialHistory)) {
        assert.strictEqual(r.niftyPct, figures[0], `${period} ${d.portfolio} ${r.symbol}: row Nifty ${r.niftyPct}`);
      }
    }
    // And it is anchored on the window start, not on any stock's first bar.
    const nifty = PRICES['^NSEI'];
    const base = nifty.filter((b) => b.date <= results[0].windowStart).pop();
    const expected = Math.round((nifty[nifty.length - 1].close / base.close - 1) * 1000) / 10;
    assert.strictEqual(figures[0], expected, `${period}: Nifty not anchored on window start`);
  }
});

test('returns use adjusted closes, so a bonus issue is not a crash', async () => {
  const d = await svc().getStockPerformance({ period: '3M', portfolio: 'ICICI' });
  const bon = bySym(d).BON;
  const bars = PRICES.BON;
  const base = bars.filter((b) => b.date <= d.windowStart).pop();
  const expected = Math.round((bars[bars.length - 1].adjclose / base.adjclose - 1) * 1000) / 10;
  assert.strictEqual(bon.returnPct, expected);
  assert.ok(bon.returnPct > 0, `bonus read as a fall: ${bon.returnPct}%`);
  assert.ok(bon.maxDrawdownPct > -5, `bonus read as a drawdown: ${bon.maxDrawdownPct}%`);
});

test('held-for-the-period comes from the snapshot on the start date, and unknown stays unknown', async () => {
  const q = await svc().getStockPerformance({ period: '3M', portfolio: 'ICICI' });
  assert.strictEqual(bySym(q).AAA.heldFullPeriod, true);
  assert.strictEqual(bySym(q).BON.heldFullPeriod, false);
  assert.strictEqual(bySym(q).THIN.heldFullPeriod, false);
  assert.strictEqual(q.summary.boughtInWindow, 2);

  // No ICICI record reaches back six months.
  const y = await svc().getStockPerformance({ period: '6M', portfolio: 'ICICI' });
  assert.ok(y.rows.every((r) => r.heldFullPeriod === null));
  assert.strictEqual(y.summary.holdingStartKnown, false);
  assert.strictEqual(y.summary.boughtInWindow, null, 'unknown must not be reported as zero');

  // Zerodha has no early record at all.
  const z = await svc().getStockPerformance({ period: '1M', portfolio: 'Zerodha' });
  assert.ok(z.rows.every((r) => r.heldFullPeriod === null));
  assert.strictEqual(z.summary.boughtInWindow, null);
});

test('a holding with no price is listed with a reason, sorted last, and left out of the basket', async () => {
  const d = await svc().getStockPerformance({ period: '3M', portfolio: 'both' });
  const last = d.rows[d.rows.length - 1];
  assert.strictEqual(last.symbol, 'DEADCO');
  assert.strictEqual(last.noData, true);
  assert.strictEqual(last.kind, 'NOT_LISTED');
  assert.deepStrictEqual(d.noData.map((x) => x.symbol), ['DEADCO']);
  assert.strictEqual(d.summary.priced, d.summary.holdings - 1);
  assert.strictEqual(d.priceSource.ok, true);
});

test('an ICICI code resolves through the security master, and only in the ICICI account', async () => {
  const d = await svc().getStockPerformance({ period: '3M', portfolio: 'both' });
  const thin = bySym(d).THIN;
  assert.ok(thin && !thin.noData, 'THNCOD should be priced as THIN');
  assert.strictEqual(thin.brokerCode, 'THNCOD');
  assert.strictEqual(thin.name, 'Thin Trading Limited');
  // The master also lists "AAA" as an ICICI short name for ZZZ — but AAA is itself a listed NSE
  // symbol, so it must never be rewritten; both accounts' AAA stay one row.
  assert.ok(!bySym(d).ZZZ, 'a live symbol was rewritten');
});

test('AAA held in both portfolios merges into one row; a mid-window listing is flagged', async () => {
  const d = await svc().getStockPerformance({ period: '3M', portfolio: 'both' });
  const aaa = bySym(d).AAA;
  assert.deepStrictEqual(aaa.portfolios, ['ICICI', 'Zerodha']);
  assert.strictEqual(aaa.value, 4500);
  assert.strictEqual(bySym(d).NEWCO.partialHistory, true);
  for (const r of d.rows.filter((x) => x.score != null)) assert.ok(r.score >= 0 && r.score <= 100);
});

test('RSI and EMA helpers match their definitions', () => {
  const { rsi14, ema } = svc()._internals;
  assert.strictEqual(rsi14(Array.from({ length: 30 }, (_, i) => 100 + i)), 100);   // no down days
  assert.strictEqual(rsi14(Array.from({ length: 30 }, (_, i) => 100 - i)), 0);     // no up days
  assert.strictEqual(ema([1, 2, 3], 3), 2);
  assert.strictEqual(ema([1, 2], 3), null);
});
