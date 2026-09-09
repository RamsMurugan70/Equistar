// Which of NSE's renames actually apply to THIS book — decided on two independent confirmations,
// never on one.
//
// THE FAILURE THIS PREVENTS. A ticker rename splits one position in two: buys recorded under the
// old name, sells under the new. One side then shows a phantom long it never closed, the other
// an impossible negative with no cost basis reachable, and both numbers look entirely ordinary
// on screen. Nothing errors. ZOMATO became ETERNAL on 2025-04-09 and IBULHSGFIN became
// SAMMAANCAP on 2024-07-26; a book holding history either side of those dates will show exactly
// that split the moment the newer rows arrive.
//
// WHY TWO CONFIRMATIONS, and why neither alone is enough:
//
//   NSE's master alone proves the rename is REAL but says nothing about whether it touches this
//   account. Rewriting on that basis alone rewrites symbols in books that never held the stock.
//
//   A quantity offset alone proves nothing at all. Two unrelated stocks whose positions happen
//   to cancel will offset just as neatly as a genuine rename, and pairing them silently merges
//   two real positions into one wrong one. "It looks like it lines up" is how a bad mapping gets
//   in and then stays, because after the merge the evidence for it is the merge.
//
// So a pair is applied only when NSE lists it AND both names were actually traded in this book
// AND combining them repairs an impossibility that neither side explains alone. A pair that NSE
// lists and the book trades, but whose quantities do NOT offset, is reported for review rather
// than applied or discarded — that usually means the order history is incomplete, which is a
// different problem with a different answer, and silently merging would bury it.
//
// ORDER MATTERS: the broker code resolves FIRST. Renames are stated in NSE symbols, so a rename
// cannot match a broker's private code — resolve in the wrong order and a stock that has both a
// broker alias and a rename is missed entirely. See resolveSymbol below.
const { openDatabase, allAsync, closeAsync } = require('../../db/connection');
const { loadChanges } = require('../market/symbolChangeService');

// Same one-share floor used by the cost-basis coverage check: fractional entitlements and
// partial-fill dust are not evidence of anything.
const TOLERANCE = 1;

// Follow a rename chain to the name in use today. A ticker can be renamed more than once, and
// stopping at the first hop leaves the position under a name that is itself retired.
// `seen` breaks the cycle if NSE ever publishes A→B and B→A, which would otherwise spin forever.
function chaseCurrentName(symbol, changesByOld) {
  let current = symbol;
  const seen = new Set([symbol]);
  const path = [];
  for (;;) {
    const hops = changesByOld.get(current);
    if (!hops || !hops.length) break;
    // Newest hop wins when NSE lists several for one old name.
    const next = [...hops].sort((a, b) => String(b.changedOn || '').localeCompare(String(a.changedOn || '')))[0];
    if (!next?.newSymbol || seen.has(next.newSymbol)) break;
    path.push({ from: current, to: next.newSymbol, on: next.changedOn, company: next.company });
    seen.add(next.newSymbol);
    current = next.newSymbol;
  }
  return { current, path };
}

/**
 * Build the rename map for one book.
 *
 * Returns { map, applied, needsReview, checked } where `map` is oldSymbol → newSymbol containing
 * ONLY doubly-confirmed pairs, and is safe to apply to that book's symbols.
 */
async function buildRenameMap({ portfolio = null } = {}) {
  const changesByOld = await loadChanges();
  if (!changesByOld.size) {
    return { map: new Map(), applied: [], needsReview: [], checked: 0, masterAvailable: false };
  }

  const db = openDatabase();
  let rows;
  try {
    const params = [];
    let where = '';
    if (portfolio) { where = 'WHERE portfolio = ?'; params.push(portfolio); }
    rows = await allAsync(db,
      `SELECT symbol, side, quantity, trade_date FROM orders ${where}`, params);
  } finally {
    await closeAsync(db);
  }

  // Broker codes collapse FIRST — see the header. A rename is stated in NSE symbols and will
  // never match FIRSOU or EDEFIN.
  const { resolveNseSymbol } = require('./portfolioService');
  const book = new Map();   // nse symbol -> { bought, sold, first, last }
  for (const o of rows) {
    const raw = String(o.symbol || '');
    if (!raw || raw.includes(' ')) continue;     // F&O descriptors are not equities
    const sym = String(resolveNseSymbol(raw) || raw).toUpperCase();
    if (!book.has(sym)) book.set(sym, { bought: 0, sold: 0, first: o.trade_date, last: o.trade_date });
    const d = book.get(sym);
    if (String(o.side || '').toUpperCase().startsWith('B')) d.bought += Number(o.quantity || 0);
    else d.sold += Number(o.quantity || 0);
    if (o.trade_date < d.first) d.first = o.trade_date;
    if (o.trade_date > d.last) d.last = o.trade_date;
  }

  const map = new Map();
  const applied = [];
  const needsReview = [];

  for (const oldSym of book.keys()) {
    const { current, path } = chaseCurrentName(oldSym, changesByOld);
    if (current === oldSym) continue;             // NSE knows no rename for this ticker

    // CONFIRMATION 2, first half: is the new name actually traded here? If not, this rename is
    // real but irrelevant to this book, and rewriting on it would invent a position.
    if (!book.has(current)) continue;

    const a = book.get(oldSym);
    const b = book.get(current);
    const netOld = a.bought - a.sold;
    const netNew = b.bought - b.sold;
    const combined = netOld + netNew;

    // CONFIRMATION 2, second half: do the quantities offset? A rename splits ONE position, so
    // at least one side must be impossible on its own (sold more than it ever bought) and
    // combining the two must resolve that. If both sides already stand up alone, there is no
    // split to repair and no evidence these two records are one position.
    const eitherImpossible = netOld < -TOLERANCE || netNew < -TOLERANCE;
    const combinedSound = combined >= -TOLERANCE;

    const pair = {
      from: oldSym,
      to: current,
      via: path.map((h) => `${h.from}→${h.to}${h.on ? ` on ${h.on}` : ''}`).join(', '),
      company: path[path.length - 1]?.company || null,
      changedOn: path[path.length - 1]?.on || null,
      netBefore: { [oldSym]: Math.round(netOld * 100) / 100, [current]: Math.round(netNew * 100) / 100 },
      netCombined: Math.round(combined * 100) / 100,
    };

    if (eitherImpossible && combinedSound) {
      map.set(oldSym, current);
      applied.push({ ...pair, confirmations: ['NSE symbolchange master', 'quantities offset in this book'] });
    } else {
      // Listed, traded on both names, but the numbers do not tell the story a rename tells.
      // Surfaced rather than applied: the usual cause is a gappy order history, and merging
      // would hide the gap instead of showing it.
      needsReview.push({
        ...pair,
        reason: eitherImpossible
          ? 'Combining these two still leaves more sold than bought, so the rename alone does '
            + 'not explain the gap — the order history is probably incomplete.'
          : 'Both names stand up on their own quantities, so there is no split for a rename to '
            + 'repair. Merging them on the master alone could join two genuinely separate holdings.',
      });
    }
  }

  return { map, applied, needsReview, checked: book.size, masterAvailable: true };
}

/**
 * Resolve a raw symbol to the name it trades under today.
 *
 * Broker code first, rename second — always in that order, for the reason in the header.
 * `renameMap` comes from buildRenameMap and is already confirmed against this book, so applying
 * it here needs no further checks.
 */
function resolveSymbol(raw, renameMap) {
  const { resolveNseSymbol } = require('./portfolioService');
  const nse = String(resolveNseSymbol(raw) || raw || '').toUpperCase();
  return renameMap?.get(nse) || nse;
}

module.exports = { buildRenameMap, resolveSymbol, chaseCurrentName, TOLERANCE };
