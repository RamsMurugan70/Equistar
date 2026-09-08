// The Indian indices Stock Sleuth can report on, and what Yahoo calls each one.
//
// A CURATED TABLE, NOT A RULE. Yahoo's ticker for an Indian index cannot be derived from its NSE
// name, and the exceptions are not edge cases — they are most of the list. NIFTY IT is ^CNXIT,
// carrying an index name ("CNX") that NSE retired in 2015. Bank Nifty is ^NSEBANK, not ^CNXBANK.
// Nifty Fin Service is not a caret ticker at all: it is NIFTY_FIN_SERVICE.NS, spelled like an
// equity. Sensex is a BSE index and so is ^BSESN.
//
// Every row here is therefore a fact that was checked against Yahoo, not a pattern that was
// inferred. Adding an index means looking its ticker up and confirming it returns candles —
// guessing produces a symbol that 404s, and the failure surfaces as "index not found" long after
// anyone remembers why.
//
// `benchmark` is what relative strength is measured against. Nifty 50 is the market, so it has
// none — comparing it with itself would print a row of zeroes that reads like a bug.

const INDEX_LIST = [
  // ── Broad market ──────────────────────────────────────────────────────────
  { key: 'NIFTY50',     label: 'Nifty 50',        yahoo: '^NSEI',                group: 'Broad',  benchmark: null },
  { key: 'BANKNIFTY',   label: 'Bank Nifty',      yahoo: '^NSEBANK',             group: 'Broad',  benchmark: 'NIFTY50' },
  { key: 'FINNIFTY',    label: 'Nifty Fin Service', yahoo: 'NIFTY_FIN_SERVICE.NS', group: 'Broad', benchmark: 'NIFTY50' },
  { key: 'SENSEX',      label: 'Sensex',          yahoo: '^BSESN',               group: 'Broad',  benchmark: 'NIFTY50' },

  // ── Sector ────────────────────────────────────────────────────────────────
  { key: 'NIFTYIT',     label: 'Nifty IT',        yahoo: '^CNXIT',       group: 'Sector', benchmark: 'NIFTY50' },
  { key: 'NIFTYAUTO',   label: 'Nifty Auto',      yahoo: '^CNXAUTO',     group: 'Sector', benchmark: 'NIFTY50' },
  { key: 'NIFTYPHARMA', label: 'Nifty Pharma',    yahoo: '^CNXPHARMA',   group: 'Sector', benchmark: 'NIFTY50' },
  { key: 'NIFTYFMCG',   label: 'Nifty FMCG',      yahoo: '^CNXFMCG',     group: 'Sector', benchmark: 'NIFTY50' },
  { key: 'NIFTYMETAL',  label: 'Nifty Metal',     yahoo: '^CNXMETAL',    group: 'Sector', benchmark: 'NIFTY50' },
  { key: 'NIFTYENERGY', label: 'Nifty Energy',    yahoo: '^CNXENERGY',   group: 'Sector', benchmark: 'NIFTY50' },
  { key: 'NIFTYREALTY', label: 'Nifty Realty',    yahoo: '^CNXREALTY',   group: 'Sector', benchmark: 'NIFTY50' },
  { key: 'NIFTYPSUBANK', label: 'Nifty PSU Bank', yahoo: '^CNXPSUBANK',  group: 'Sector', benchmark: 'NIFTY50' },
  { key: 'NIFTYINFRA',  label: 'Nifty Infra',     yahoo: '^CNXINFRA',    group: 'Sector', benchmark: 'NIFTY50' },
  { key: 'NIFTYMEDIA',  label: 'Nifty Media',     yahoo: '^CNXMEDIA',    group: 'Sector', benchmark: 'NIFTY50' },
];

// Lookup is by exact key only, uppercased and trimmed.
//
// EXACT MATCH IS A SAFETY PROPERTY, not a performance one. fetchPriceHistory consults this table
// before falling back to the `.NS`/`.BO` suffixes every stock uses, so a loose match here would
// silently route a stock to an index: a fuzzy rule matching "NIFTY" would send anything starting
// with those letters to ^NSEI and report the index's numbers under the stock's name. Nothing
// downstream could detect that, because the data returned is perfectly valid — just not the
// company that was asked for.
const BY_KEY = new Map(INDEX_LIST.map((i) => [i.key, i]));

/** The index with this exact key, or null. Never partial, never fuzzy. */
function getIndex(key) {
  if (!key) return null;
  return BY_KEY.get(String(key).trim().toUpperCase()) || null;
}

const isIndex = (key) => getIndex(key) !== null;

/** Yahoo's ticker for an index key, or null when the key is not an index. */
function yahooTickerFor(key) {
  return getIndex(key)?.yahoo || null;
}

/** What the picker shows. Indices carry no scan history, so there is nothing else to send. */
function list() {
  return INDEX_LIST.map(({ key, label, group, benchmark }) => ({
    key, label, group, benchmark, isIndex: true,
  }));
}

module.exports = { INDEX_LIST, getIndex, isIndex, yahooTickerFor, list };
