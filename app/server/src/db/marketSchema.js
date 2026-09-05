// Who is allowed to create the shared market tables.
//
// THE BUG THIS EXISTS TO PREVENT, which is subtle and silent. Market tables live in market.db,
// which every participant's instance ATTACHes; SQLite then resolves unqualified names into the
// attached file because those tables do not exist in the participant's own database. That is the
// whole trick, and it is what let the app's existing queries work unchanged.
//
// But several repositories call `ensureSchema()` before every read — CREATE TABLE IF NOT EXISTS
// on the market tables. Run inside a participant's instance, that creates an EMPTY copy in their
// own file, which from then on SHADOWS the shared one. Nothing errors. The Top 25 simply comes
// back empty, forever, while fifty thousand rows sit in a file two directories away.
//
// So: the process that OWNS the market file creates its schema; every process that merely reads
// it never does. `marketDbPath` is exactly that distinction — the hub's scanner runs with it
// unset because market.db IS its main database, and instances run with it set.
const config = require('../config/env');

/** True when this process owns the market file rather than attaching somebody else's. */
const ownsMarketData = () => !config.marketDbPath;

/**
 * Wraps a market-table ensureSchema so it is a no-op in a reader.
 *
 *   const ensureSchema = onlyWhenOwned(async (db) => { ...CREATE TABLE... });
 */
function onlyWhenOwned(fn) {
  return async (...args) => (ownsMarketData() ? fn(...args) : undefined);
}

module.exports = { ownsMarketData, onlyWhenOwned };
