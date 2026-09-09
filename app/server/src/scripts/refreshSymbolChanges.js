#!/usr/bin/env node
//
// Load NSE's ticker-rename master into the shared market database.
//
//   node src/scripts/refreshSymbolChanges.js
//
// Run this BEFORE importing a tradebook that crosses a rename date. The map is what stops one
// position being recorded as two — buys under the old ticker, sells under the new — and the
// split is silent when it happens: both halves render as ordinary rows.
//
// Written by the process that OWNS market.db, never by a participant instance (see
// db/marketSchema.js), so the environment is pinned here rather than left to the caller.
// Idempotent: INSERT OR IGNORE against a natural primary key, so re-running adds only what NSE
// has published since.
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const marketDb = process.env.MARKET_DB_PATH
  ? path.resolve(repoRoot, process.env.MARKET_DB_PATH)
  : path.join(repoRoot, 'data', 'market.db');

process.env.DB_PATH = marketDb;
process.env.MARKET_DB_PATH = '';

const { refreshSymbolChanges, status } = require('../services/market/symbolChangeService');

(async () => {
  console.log('NSE symbol-change master');
  console.log(`  market database: ${marketDb}\n`);

  const before = await status();
  const result = await refreshSymbolChanges();
  const after = await status();

  console.log(`  fetched ${result.fetched} row(s) from NSE`);
  console.log(`  added   ${result.saved} new row(s)  (${before.rows} → ${after.rows} on record)`);
  console.log(`  renames span ${after.earliestChange || '?'} → ${after.latestChange || '?'}`);
  if (result.fetched && !result.saved) {
    console.log('  Everything NSE returned was already on record — nothing to do.');
  }
})().catch((e) => {
  console.error(`\nRefresh failed: ${e.message}`);
  console.error('Nothing was written — the load runs as a single transaction.');
  process.exit(1);
});
