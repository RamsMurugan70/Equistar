#!/usr/bin/env node
//
// Backfill the shared corporate-actions history from NSE.
//
//   node src/scripts/backfillCorporateActions.js [--from 2019] [--to 2026]
//
// The table is written by the process that OWNS market.db, never by a participant instance —
// see db/marketSchema.js. A reader has MARKET_DB_PATH set and attaches the shared file; if this
// script ran that way, ensureSchema would no-op and the writes would land in whichever database
// happened to be main. So the environment is pinned here rather than left to the caller to
// remember: main database = market.db, nothing attached.
//
// Safe to re-run. Every write is INSERT OR IGNORE against UNIQUE(symbol, subject, ex_date), so
// a repeat run adds only what is missing and an interrupted run is resumed by running it again.

const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const marketDb = process.env.MARKET_DB_PATH
  ? path.resolve(repoRoot, process.env.MARKET_DB_PATH)
  : path.join(repoRoot, 'data', 'market.db');

process.env.DB_PATH = marketDb;
process.env.MARKET_DB_PATH = '';        // own it, do not attach it

const { backfillCorporateActions } = require('../services/corporateActions/corporateActionsService');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

(async () => {
  const fromYear = arg('from', 2019);
  const toYear = arg('to', new Date().getFullYear());

  console.log(`Corporate actions backfill — ${fromYear} to ${toYear}`);
  console.log(`  market database: ${marketDb}\n`);

  const started = Date.now();
  const result = await backfillCorporateActions({
    fromYear,
    toYear,
    onProgress: ({ year, fetched, saved }) => {
      const note = fetched === 0 ? '  (nothing returned)' : '';
      console.log(`  ${year}   fetched ${String(fetched).padStart(5)}   added ${String(saved).padStart(5)}${note}`);
    },
  });

  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`\n  ${result.fetched} action(s) fetched, ${result.saved} new row(s) added in ${secs}s.`);
  if (result.fetched && !result.saved) {
    console.log('  Everything returned was already on record — nothing to do.');
  }
})().catch((e) => {
  console.error(`\nBackfill failed: ${e.message}`);
  console.error('Nothing was left half-written — each year commits as one transaction.');
  process.exit(1);
});
