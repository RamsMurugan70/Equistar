#!/usr/bin/env node
//
// Remove provable re-imported order rows, then lock the door behind them.
//
//   node src/scripts/dedupeBrokerOrders.js --db <path to app.db> [--apply]
//
// Dry run by default. Nothing is written without --apply.
//
// WHAT COUNTS AS PROVABLE. Only rows sharing a broker_order_id. That id comes from the broker
// and identifies one fill, so seeing it twice means the same fill was imported twice — there is
// no other reading. The lowest id is kept (the original import) and the later copies dropped.
//
// WHAT IS DELIBERATELY NOT TOUCHED, and this is the important half: rows sharing a NATURAL key
// (date, symbol, side, quantity, price). Those are overwhelmingly genuine repeat fills — one
// order filled in pieces at one price, which is what a large order looks like in a tradebook.
// A single large sell can appear as a dozen or more same-price fills in one day, several of
// which will collide on that key — and deduping there deletes real shares, silently, with no
// error and nothing on screen to show what went missing.
// A natural-key match is evidence of nothing. Only the broker's id is proof.
// The dry run prints the natural-key group count next to the deletions so the gap between the
// two is visible before anything is written.
const path = require('path');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

const dbPath = arg('db');
const apply = process.argv.includes('--apply');
if (!dbPath) {
  console.error('Usage: node src/scripts/dedupeBrokerOrders.js --db <path to app.db> [--apply]');
  process.exit(1);
}

// Pinned before the connection module reads config, and MARKET_DB_PATH is cleared so this
// touches exactly one file: the participant database named on the command line.
process.env.DB_PATH = path.resolve(dbPath);
process.env.MARKET_DB_PATH = '';

const { openDatabase, allAsync, runAsync, closeAsync } = require('../db/connection');

const INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_broker_order_id
    ON orders (broker_order_id)
    WHERE broker_order_id IS NOT NULL`;

(async () => {
  const db = openDatabase();
  try {
    const cols = (await allAsync(db, 'PRAGMA table_info(orders)')).map((c) => c.name);
    if (!cols.includes('broker_order_id')) {
      console.log('This database has no broker_order_id column yet — nothing to dedupe.');
      return;
    }

    const groups = await allAsync(db, `
      SELECT broker_order_id, COUNT(*) n
        FROM orders
       WHERE broker_order_id IS NOT NULL AND broker_order_id <> ''
       GROUP BY broker_order_id
      HAVING n > 1
       ORDER BY n DESC`);

    console.log(`${path.resolve(dbPath)}`);
    console.log(`  total orders                 : ${(await allAsync(db, 'SELECT COUNT(*) c FROM orders'))[0].c}`);
    console.log(`  repeated broker_order_id     : ${groups.length} group(s)`);

    const doomed = [];
    for (const g of groups) {
      const rows = await allAsync(db,
        `SELECT id, trade_date, symbol, side, quantity, price, imported_at
           FROM orders WHERE broker_order_id = ? ORDER BY id`, [g.broker_order_id]);
      const [keep, ...drop] = rows;
      console.log(`\n  ${g.broker_order_id}`);
      console.log(`    keep id=${keep.id} ${keep.symbol} ${keep.side} ${keep.quantity} @ ${keep.price} (imported ${keep.imported_at})`);
      for (const d of drop) {
        console.log(`    drop id=${d.id} ${d.symbol} ${d.side} ${d.quantity} @ ${d.price} (imported ${d.imported_at})`);
        doomed.push(d.id);
      }
    }

    // Reported for contrast, never acted on — see the header. Seeing this count next to the
    // deletions is what stops a future reader "improving" this script into a data-loss bug.
    const natural = await allAsync(db, `
      SELECT COUNT(*) c FROM (
        SELECT 1 FROM orders
         GROUP BY trade_date, portfolio, symbol, side, quantity, price
        HAVING COUNT(*) > 1)`);
    console.log(`\n  natural-key groups (NOT touched): ${natural[0].c} — genuine repeat fills`);

    if (!doomed.length) {
      console.log('\n  Nothing to delete.');
    } else if (!apply) {
      console.log(`\n  DRY RUN — ${doomed.length} row(s) would be deleted. Re-run with --apply.`);
      return;
    } else {
      await runAsync(db, 'BEGIN TRANSACTION');
      try {
        const res = await runAsync(db,
          `DELETE FROM orders WHERE id IN (${doomed.map(() => '?').join(',')})`, doomed);
        await runAsync(db, 'COMMIT');
        console.log(`\n  Deleted ${res.changes} row(s).`);
      } catch (e) {
        await runAsync(db, 'ROLLBACK').catch(() => {});
        throw e;
      }
    }

    if (!apply) {
      console.log('  (index not created in a dry run)');
      return;
    }

    // The schema-level guarantee, added only once the data can satisfy it. A partial index is
    // required rather than a plain UNIQUE: only rows that actually carry a broker id are
    // constrained, so CSV and historical rows — which have none — stay unconstrained instead of
    // competing for a single NULL key.
    try {
      await runAsync(db, INDEX_SQL);
      console.log('  Unique index ux_orders_broker_order_id is in place.');
    } catch (e) {
      console.error(`  Could not create the unique index: ${e.message}`);
      console.error('  Duplicates must still be present — the deletions above did not cover them.');
      process.exitCode = 1;
    }
  } finally {
    await closeAsync(db);
  }
})().catch((e) => { console.error(e); process.exit(1); });
