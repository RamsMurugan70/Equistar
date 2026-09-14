// Open tax lots per holding — what the LTCG / STCG page classifies.
//
// THE PAGE USED TO GET THIS WRONG IN THREE WAYS, all silently:
//   1. It replayed only the latest 2,000 orders per portfolio, in the browser. A book with 6,943
//      orders lost every buy older than about a year, so the oldest surviving lot always looked
//      recent and not one holding ever qualified as long-term.
//   2. It matched a holding's broker code (VATWAB) against orders stored under the NSE symbol
//      (WABAG). No match meant "no order data" for most of an ICICI book.
//   3. It named the two portfolios in the code, so any account called anything else saw nothing.
// Replayed here instead: every equity order, keyed by resolved NSE symbol, for whatever the
// accounts are called.
//
// SPLITS AND BONUSES, because the tax answer depends on them and FIFO gets them wrong unaided.
// After a split or bonus the broker reports sells in the new share count while the buys are
// still in the old one, so a 1:5 split makes one sell eat five lots' worth of history.
//   • SPLIT: every open lot's quantity is restated on the ex-date. The acquisition date does NOT
//     change — a split is the same holding in smaller pieces.
//   • BONUS: the new shares become a separate lot dated on the ex-date. Under Indian tax law bonus
//     shares are acquired on allotment, at nil cost, so their holding clock starts then and not
//     when the original shares were bought. The ex-date stands in for allotment, which follows it
//     by a day or two; that is stated on the page.
// Actions dated on a trading day apply before that day's trades, which are already in the new units.
//
// WHEN THE ORDERS DO NOT ADD UP. Shares that arrived as an IPO allotment, an off-market transfer,
// or before the order history begins have no purchase on record, and sells can exceed recorded buys.
// FIFO then cannot say which lot is oldest. Rather than print a confident tax status from a partial
// book, each result carries the recorded open quantity, so the page can compare it with the quantity
// actually held and say "history incomplete" instead.
const { openDatabase, allAsync, closeAsync } = require('../../db/connection');
const { isFno } = require('../../utils/tradeClassification');
const { quantityFactor } = require('./costBasisCoverageService');

const round = (v) => Math.round(v * 10000) / 10000;

/**
 * Replays one holding's history. Pure, so it can be tested without a database.
 *   trades   [{ date, side, qty }]
 *   actions  [{ exDate, actionType: 'SPLIT'|'BONUS', factor }]  factor: shares after per share before
 */
function replay(trades, actions = []) {
  const events = [
    ...actions.filter((a) => a.exDate).map((a) => ({ date: a.exDate, order: 0, action: a })),
    ...trades.map((t, i) => ({ date: t.date, order: 1 + i, trade: t })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);

  const lots = [];
  let unmatchedSellQty = 0;
  let adjustmentBlocked = false;
  const applied = [];
  const openQty = () => lots.reduce((s, l) => s + l.qty, 0);

  for (const e of events) {
    if (e.action) {
      const held = openQty();
      if (!(held > 0)) continue;                     // nothing held when it happened
      const f = e.action.factor;
      if (!(f > 0)) { adjustmentBlocked = true; continue; }
      if (e.action.actionType === 'SPLIT') {
        for (const l of lots) l.qty = round(l.qty * f);
      } else if (e.action.actionType === 'BONUS') {
        const extra = round(held * (f - 1));
        if (extra > 0) lots.push({ date: e.action.exDate, qty: extra, kind: 'BONUS' });
      }
      applied.push(`${e.action.actionType} ${e.action.exDate}`);
      continue;
    }
    const qty = Number(e.trade.qty) || 0;
    const side = String(e.trade.side || '').toUpperCase();
    if (side.startsWith('B')) {
      lots.push({ date: e.trade.date, qty, kind: 'BUY' });
    } else if (side.startsWith('S')) {
      let remaining = qty;
      // Oldest first: FIFO is how Indian tax treats a partial sale of one scrip.
      lots.sort((a, b) => a.date.localeCompare(b.date));
      while (remaining > 1e-9 && lots.length) {
        if (lots[0].qty <= remaining + 1e-9) { remaining -= lots[0].qty; lots.shift(); } else { lots[0].qty = round(lots[0].qty - remaining); remaining = 0; }
      }
      if (remaining > 1e-9) unmatchedSellQty += remaining;
    }
  }
  lots.sort((a, b) => a.date.localeCompare(b.date));
  return {
    lots,
    openQty: round(openQty()),
    earliestDate: lots[0]?.date || null,
    unmatchedSellQty: round(unmatchedSellQty),
    actionsApplied: applied,
    adjustmentBlocked,
  };
}

/** { `${portfolio}::${NSE symbol}`: replay result } for every equity position in the order book. */
async function getTaxLots() {
  const { resolveNseSymbol } = require('./portfolioService');
  const db = openDatabase();
  try {
    const orders = await allAsync(db,
      'SELECT id, trade_date, portfolio, symbol, side, quantity, exchange FROM orders ORDER BY trade_date, id');
    let actions = [];
    try {
      actions = await allAsync(db,
        `SELECT symbol, action_type, subject, ex_date FROM corporate_actions
          WHERE action_type IN ('SPLIT', 'BONUS') AND ex_date IS NOT NULL`);
    } catch { /* market file not attached: no adjustment, and results say nothing was applied */ }

    const actionsBySymbol = new Map();
    for (const a of actions) {
      const k = String(a.symbol || '').toUpperCase();
      if (!actionsBySymbol.has(k)) actionsBySymbol.set(k, []);
      const list = actionsBySymbol.get(k);
      const factor = quantityFactor(a.action_type, a.subject);
      // The same action can arrive from more than one feed. Applying it twice would double a bonus.
      if (list.some((x) => x.exDate === a.ex_date && x.actionType === a.action_type && x.factor === factor)) continue;
      list.push({ exDate: a.ex_date, actionType: a.action_type, factor });
    }

    const tradesByKey = new Map();
    for (const o of orders) {
      if (!o.symbol || isFno(o)) continue;
      const nse = String(resolveNseSymbol(o.symbol) || o.symbol).toUpperCase();
      const key = `${o.portfolio}::${nse}`;
      if (!tradesByKey.has(key)) tradesByKey.set(key, { nse, trades: [] });
      tradesByKey.get(key).trades.push({ date: o.trade_date, side: o.side, qty: o.quantity });
    }

    const out = {};
    for (const [key, { nse, trades }] of tradesByKey) {
      out[key] = replay(trades, actionsBySymbol.get(nse) || []);
    }
    return out;
  } finally {
    await closeAsync(db);
  }
}

/**
 * Squares a replay with the quantity actually held. Pure.
 *
 *   COMPLETE      recorded lots match the holding: the dates stand.
 *   TRIMMED       more shares on record than held, so some sells never reached the order book.
 *                 Whenever those sells happened, FIFO took the oldest lots that existed then, so
 *                 the excess is removed from the oldest end. That can only make the earliest date
 *                 LATER than the truth, never earlier: the error runs toward "short-term", which
 *                 is the safe side for a tax decision.
 *   MISSING_BUYS  fewer shares on record than held: some arrived with no purchase record (IPO
 *                 allotment, transfer, before the history begins). Their date could be anything,
 *                 so no tax status is given.
 *   NO_ORDERS     nothing on record at all.
 *   UNADJUSTED    a split or bonus in the way could not be read, so the quantities are not comparable.
 */
function reconcile(result, heldQty) {
  const held = Number(heldQty) || 0;
  if (!result || !(result.openQty > 0)) return { basis: 'NO_ORDERS', earliestDate: null, lots: [] };
  if (result.adjustmentBlocked) return { basis: 'UNADJUSTED', earliestDate: result.earliestDate, lots: result.lots };
  const tol = Math.max(1, held * 0.005);
  const diff = result.openQty - held;
  if (Math.abs(diff) <= tol) return { basis: 'COMPLETE', earliestDate: result.earliestDate, lots: result.lots };
  if (diff < 0) {
    return { basis: 'MISSING_BUYS', missingQty: round(-diff), earliestDate: result.earliestDate, lots: result.lots };
  }
  let excess = diff;
  const lots = result.lots.map((l) => ({ ...l }));
  while (excess > 1e-9 && lots.length) {
    if (lots[0].qty <= excess + 1e-9) { excess -= lots[0].qty; lots.shift(); } else { lots[0].qty = round(lots[0].qty - excess); excess = 0; }
  }
  return { basis: 'TRIMMED', excessQty: round(diff), earliestDate: lots[0]?.date || null, lots };
}

/**
 * One row per current holding, for the LTCG / STCG page:
 *   { `${portfolio}::${NSE symbol}`: { heldQty, basis, earliestDate, lots, excessQty?, missingQty?, actionsApplied } }
 * Holdings come from the latest broker snapshot, the same source as the Portfolio page.
 */
async function getHoldingTaxStatus() {
  const ps = require('./portfolioService');
  const [held, lotsByKey] = await Promise.all([ps.getCurrentHoldingSymbols(), getTaxLots()]);
  const out = {};
  for (const [portfolio, data] of Object.entries(held)) {
    for (const [sym, h] of Object.entries(data.holdingsBySymbol || {})) {
      const key = `${portfolio}::${sym}`;
      const r = lotsByKey[key];
      out[key] = {
        heldQty: h.quantity,
        ...reconcile(r, h.quantity),
        actionsApplied: r?.actionsApplied || [],
        holdingsAsOf: data.asOf || null,
      };
    }
  }
  return out;
}

module.exports = { getTaxLots, getHoldingTaxStatus, replay, reconcile };
