// A row is F&O if it's on an F&O exchange, or its symbol is a real option/future
// contract. Real contracts carry a strike/expiry DIGIT and end in CE/PE/FUT —
// requiring the digit excludes equities like RELIANCE, BAJFINANCE, FINPIPE
// (which merely end in "CE"/"PE") and ETFs like NIFTYBEES.
function isFno(row) {
  const ex = String(row.exchange || '').toUpperCase();
  if (ex === 'NFO' || ex === 'BFO' || ex === 'MCX') return true;
  const s = String(row.symbol || '').toUpperCase().replace(/\s+/g, '');
  return /\d/.test(s) && /(CE|PE|FUT)$/.test(s);
}

// The SQL form of `NOT isFno(row)`, for queries that aggregate orders in the database and so
// never see a row in JavaScript.
//
// WHY ONE SHARED PREDICATE. F&O fills live in the same `orders` table as equity, and the broker
// never reports its expiry-day auto square-off — so an option bought and left to expire stays
// net-long in `orders` forever. Every equity path that reads orders unfiltered therefore sees a
// phantom holding, and each one that wrote its own filter wrote a slightly different one: an
// exchange-only check, a check for a SPACE before CE/PE, and this function's digit rule. They
// agree on every row stored today, but not in general — a Breeze contract code with no spaces
// passes the space check. One definition, tested against isFno, is the only way they stay equal.
//
// It MIRRORS isFno RULE FOR RULE:
//   * exchange, uppercased, is not NFO / BFO / MCX — a blank exchange counts as equity, as in isFno
//   * and the symbol, uppercased with whitespace removed, is not (contains a digit AND ends in
//     CE, PE or FUT). The digit is what keeps RELIANCE, BAJFINANCE and FINPIPE — equities that
//     merely end in CE/PE — on the equity side, and ETFs like NIFTYBEES with them.
//
// isFno strips any /\s/ character. SQLite has no regex, so this strips the whitespace that can
// realistically occur in a stored symbol: space, tab, LF, VT, FF, CR and the no-break space.
// The shared test in test/tradeClassification.test.js runs both over the same symbols and fails
// if they ever disagree.
//
// `alias` qualifies the columns for queries that join orders to another table: equityOnlySql('o').
function equityOnlySql(alias = '') {
  const a = alias ? `${alias}.` : '';
  const sym = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(UPPER(COALESCE(${a}symbol,'')),`
    + `' ',''),char(9),''),char(10),''),char(11),''),char(12),''),char(13),''),char(160),'')`;
  return `(UPPER(COALESCE(${a}exchange,'')) NOT IN ('NFO','BFO','MCX')`
    + ` AND NOT (${sym} GLOB '*[0-9]*'`
    + ` AND (${sym} LIKE '%CE' OR ${sym} LIKE '%PE' OR ${sym} LIKE '%FUT')))`;
}

const EQUITY_ONLY_SQL = equityOnlySql();

module.exports = { isFno, equityOnlySql, EQUITY_ONLY_SQL };
