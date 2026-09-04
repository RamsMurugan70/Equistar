// Backfill broker_order_id onto orders that were imported before it was captured.
//
// A plain re-import CANNOT do this. importMissingOrders dedupes on
// (portfolio, date, symbol, side, qty, price, exchange) and skips anything already present, so
// re-running it over an old window inserts nothing and the ids stay null. The rows have to be
// UPDATED in place, matched to the broker's trade list on that same tuple.
//
// WHY IT MATTERS: the order_id's trailing digits are a monotonic intraday sequence, and without
// it FIFO orders same-day fills by import id — which is import order, not trade order. That
// reports every intraday round trip with its side and entry/exit reversed. The P&L is right
// either way; the direction is not.
//
// AMBIGUITY IS LEFT ALONE. Two identical fills on one day (same symbol, side, qty, price) cannot
// be told apart by the tuple, so their ids could be assigned either way round. Since both rows
// belong to the same contract on the same day, either assignment yields the same FIFO result —
// but the pairing is still a guess, so those rows are counted and reported rather than
// presented as verified.
const breezeService = require('../breeze/breezeService');
const { openDatabase, allAsync, runAsync, closeAsync } = require('../../db/connection');
const PF = require('../../config/portfolios');

const tupleKey = (o) => [
  o.trade_date, o.symbol, String(o.side).toUpperCase(),
  Number(o.quantity), Number(o.price), String(o.exchange || '').toUpperCase(),
].join('::');

// Breeze serves roughly three months of trade history and rejects nothing for wider windows —
// it just returns the same truncated set — so the caller passes the real range and this walks
// it in chunks to stay well inside any per-request limits.
async function backfillOrderIds({ from, to, portfolio = PF.ICICI, chunkDays = 30, dryRun = false } = {}) {
  if (!breezeService.getSessionStatus().connected) {
    throw new Error('Breeze session required — order ids come from the broker trade list.');
  }

  // 1. Pull the broker's trades across the window, in chunks.
  const trades = [];
  const errors = [];
  let cursor = from;
  while (cursor <= to) {
    const end = new Date(Date.parse(`${cursor}T00:00:00Z`) + (chunkDays - 1) * 86400000)
      .toISOString().slice(0, 10);
    const chunkEnd = end > to ? to : end;
    try {
      const part = await breezeService.fetchAllOrders(cursor, chunkEnd);
      trades.push(...part);
    } catch (e) {
      errors.push(`${cursor}..${chunkEnd}: ${e.message}`);
    }
    cursor = new Date(Date.parse(`${chunkEnd}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  }

  // Group broker trades by tuple; a tuple can legitimately hold several ids.
  const byTuple = new Map();
  for (const t of trades) {
    if (!t.order_id) continue;
    const k = tupleKey(t);
    if (!byTuple.has(k)) byTuple.set(k, []);
    byTuple.get(k).push(String(t.order_id));
  }

  // 2. Match against rows that still lack an id.
  const db = openDatabase();
  const applied = [];
  const ambiguous = [];
  let unmatched = 0;
  try {
    const rows = await allAsync(db,
      `SELECT id, trade_date, symbol, side, quantity, price, exchange
         FROM orders
        WHERE portfolio = ? AND broker_order_id IS NULL
          AND exchange IN ('NFO','BFO')
          AND trade_date BETWEEN ? AND ?
        ORDER BY trade_date, id`, [portfolio, from, to]);

    // How many DB rows share each tuple — more than one means the pairing is a guess.
    const dbCounts = new Map();
    for (const r of rows) dbCounts.set(tupleKey(r), (dbCounts.get(tupleKey(r)) || 0) + 1);

    for (const r of rows) {
      const k = tupleKey(r);
      const ids = byTuple.get(k);
      if (!ids || !ids.length) { unmatched += 1; continue; }
      const orderId = ids.shift();              // consume, so two rows never take the same id
      if ((dbCounts.get(k) || 0) > 1) ambiguous.push({ id: r.id, symbol: r.symbol, date: r.trade_date });
      if (!dryRun) {
        await runAsync(db, 'UPDATE orders SET broker_order_id = ? WHERE id = ?', [orderId, r.id]);
      }
      applied.push({ id: r.id, date: r.trade_date, symbol: r.symbol, orderId });
    }
  } finally { await closeAsync(db); }

  return {
    ok: true,
    from, to, portfolio, dryRun,
    brokerTrades: trades.length,
    candidates: applied.length + unmatched,
    updated: applied.length,
    unmatched,
    ambiguous: ambiguous.length,
    ambiguousRows: ambiguous.slice(0, 20),
    errors,
  };
}

module.exports = { backfillOrderIds };
