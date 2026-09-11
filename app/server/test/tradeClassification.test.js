// EQUITY_ONLY_SQL must select exactly the rows isFno calls equity — no more, no fewer.
//
// The two are separate implementations of one rule (JavaScript for rows in memory, SQL for
// queries that aggregate in the database), and the whole point of sharing them is that they stay
// equal. This runs both over the same symbols and fails on the first disagreement.
const test = require('node:test');
const assert = require('node:assert');
const sqlite3 = require('sqlite3');
const { isFno, EQUITY_ONLY_SQL, equityOnlySql } = require('../src/utils/tradeClassification');

// [symbol, exchange] — chosen for the cases each rule could plausibly get wrong.
const CASES = [
  ['NIFTY 25Aug26 23900 PE', 'NFO'],     // plain contract on its exchange
  ['NIFTY 25Aug26 23900 PE', ''],        // contract with the exchange missing
  ['NIFTY25AUG2623900PE', ''],           // Breeze-style code, no spaces
  ['NIFTY25AUG2623900PE', null],
  ['NIFTY 25Aug26 23900 PE ', ''],       // trailing space
  ['NIFTY\t25AUG26\t23900\tPE', ''],     // tabs
  ['NIFTY 25AUG26 23900 PE', ''],   // no-break spaces
  ['x1 ce', ''],                         // lower case
  ['CRUDE24FUT', 'MCX'],
  ['CRUDE24FUT', ''],
  ['BSESEN 03Sep26 75700 PE', 'BFO'],
  ['SBIN', 'nfo'],                       // an equity symbol on an F&O exchange is still F&O
  ['RELIANCE', 'NSE'],
  ['FINPIPE', 'NSE'],                    // ends in PE, no digit — equity
  ['BAJFINANCE', 'NSE'],                 // ends in CE, no digit — equity
  ['NIFTYBEES', 'NSE'],                  // ETF
  ['GOLDBEES', 'NSE'],
  ['ABC FUT', ''],                       // ends in FUT but no digit — equity, per isFno
  ['3MINDIA', 'NSE'],                    // digit, but does not end in CE/PE/FUT
  ['360ONE', 'NSE'],
  ['5PAISA', 'BSE'],
  ['M&M', 'NSE'],
  ['TCS', 'BSE'],
  ['', 'NSE'],
  [null, null],
  ['ABCD1CE', 'NSE'],                    // digit + CE: isFno calls it F&O, so must the SQL
];

function sqlEquityIds(sql) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:');
    db.serialize(() => {
      db.run('CREATE TABLE orders (id INTEGER, symbol TEXT, exchange TEXT)');
      const st = db.prepare('INSERT INTO orders VALUES (?, ?, ?)');
      CASES.forEach(([s, e], i) => st.run(i, s, e));
      st.finalize();
      db.all(`SELECT id FROM orders WHERE ${sql}`, (err, rows) => {
        db.close();
        if (err) reject(err); else resolve(new Set(rows.map((r) => r.id)));
      });
    });
  });
}

test('EQUITY_ONLY_SQL agrees with isFno on every case', async () => {
  const sqlEquity = await sqlEquityIds(EQUITY_ONLY_SQL);
  CASES.forEach(([symbol, exchange], i) => {
    const jsEquity = !isFno({ symbol, exchange });
    assert.strictEqual(sqlEquity.has(i), jsEquity,
      `disagree on ${JSON.stringify([symbol, exchange])}: isFno-equity=${jsEquity}, sql-equity=${sqlEquity.has(i)}`);
  });
});

test('equityOnlySql(alias) selects the same rows when the table is aliased', async () => {
  // Routed through a self-join, where an unqualified `symbol` would be ambiguous and fail.
  const aliased = `EXISTS (SELECT 1 FROM orders o WHERE o.id = orders.id AND ${equityOnlySql('o')})`;
  const [plain, viaAlias] = await Promise.all([sqlEquityIds(EQUITY_ONLY_SQL), sqlEquityIds(aliased)]);
  assert.deepStrictEqual([...viaAlias].sort(), [...plain].sort());
});
