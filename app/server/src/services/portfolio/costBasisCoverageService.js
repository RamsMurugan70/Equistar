// Where the order history cannot support a cost basis — measured, not guessed, and never
// invented.
//
// THE SHAPE OF THE PROBLEM. A symbol whose recorded sells exceed its recorded buys is not a
// rounding artefact; it means shares left the account that this database never saw arrive.
// FIFO cannot price them, so realised gain, cost basis and LTCG/STCG for that symbol are all
// understated by an unknown amount. The number still renders, and renders confidently, which is
// what makes it dangerous.
//
// WHY NOT JUST CREATE THE MISSING BUYS. Because a fabricated opening row misstates the two
// things the figure is actually used for. Bonus shares carry ZERO cost and inherit the ORIGINAL
// acquisition date, so inventing a "buy" at the sale price both erases a gain that was real and
// restarts the holding clock — turning long-term capital gains into short-term ones. An
// IPO allotment or an off-market transfer has a real cost and a real date, neither of which is
// recoverable from a broker feed that never reported the trade. A flag that says "incomplete"
// is worth more than a number that is quietly wrong.
//
// TODAY'S SHARE TERMS, ALWAYS. Quantities are restated through every split and bonus dated after
// the trade before they are compared. Skip that and a 1:1 bonus makes a perfectly complete book
// look like it sold twice what it bought — the adjustment is what separates a real gap from a
// corporate action. Note that it cuts both ways: a genuine 1-share shortfall sitting under a 1:1
// bonus is a 2-share shortfall today, so restating can make a gap larger as well as smaller.
const { openDatabase, allAsync, closeAsync } = require('../../db/connection');

// Rounding noise, partial-fill dust and the odd fractional bonus entitlement all produce
// sub-share discrepancies that are not worth a warning. One share is the floor for a real case.
const TOLERANCE = 1;

// Shares AFTER the action for every 1 share held before it — the inverse of the price factor in
// market/corpActionsService, which restates prices rather than quantities.
function quantityFactor(actionType, subject) {
  const s = subject || '';
  if (actionType === 'SPLIT') {
    // "Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share" → 5x shares
    const from = s.match(/From\s+R[se]\.?\s*([\d.]+)/i);
    const to = s.match(/To\s+R[se]\.?\s*([\d.]+)/i);
    if (!from || !to) return null;
    const f = parseFloat(from[1]);
    const t = parseFloat(to[1]);
    if (!(f > 0) || !(t > 0)) return null;
    return f / t;
  }
  if (actionType === 'BONUS') {
    // "Bonus 4:1" = 4 new shares for every 1 held → 1 share becomes 5.
    const m = s.match(/(\d+)\s*:\s*(\d+)/);
    if (!m) return null;
    const issued = parseInt(m[1], 10);
    const held = parseInt(m[2], 10);
    if (!(held > 0) || !(issued >= 0)) return null;
    return (issued + held) / held;
  }
  return null;
}

async function quantityActionsBySymbol(db) {
  const map = new Map();
  try {
    const rows = await allAsync(db,
      `SELECT symbol, action_type, subject, ex_date FROM corporate_actions
        WHERE action_type IN ('SPLIT','BONUS') AND ex_date IS NOT NULL`);
    for (const r of rows) {
      const key = String(r.symbol || '').toUpperCase();
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({
        exDate: r.ex_date,
        actionType: r.action_type,
        subject: r.subject,
        factor: quantityFactor(r.action_type, r.subject),
      });
    }
  } catch {
    // The shared market file may not be attached. Better to report coverage without the
    // adjustment — and say so — than to fail the whole surface.
  }
  return map;
}

// Restate a quantity traded on `tradeDate` into today's shares, reporting whether any action
// in the way could not be quantified. An unparseable action makes the comparison unsafe, so it
// is surfaced rather than silently treated as 1.0.
function restate(qty, tradeDate, actions) {
  let factor = 1;
  let blocked = false;
  const applied = [];
  for (const a of actions || []) {
    if (!a.exDate || a.exDate <= tradeDate) continue;
    if (a.factor == null) { blocked = true; continue; }
    factor *= a.factor;
    const tag = `${a.actionType} ${a.exDate}`;
    if (!applied.includes(tag)) applied.push(tag);
  }
  return { qty: qty * factor, blocked, applied };
}

/**
 * Per-symbol cost-basis coverage for the whole book.
 *
 * Returns { ok, checkedSymbols, shortfalls: [...], bySymbol: Map, actionsAvailable }.
 * A shortfall entry carries the gap in today's shares, the cause, and the actions applied —
 * enough for a tooltip to say what is missing and why, without any caller re-deriving it.
 */
async function assessCoverage({ portfolio = null } = {}) {
  const db = openDatabase();
  try {
    const actions = await quantityActionsBySymbol(db);
    const { resolveNseSymbol } = require('./portfolioService');

    // Renames are folded in before anything is counted, or a stock that changed ticker mid-book
    // reports twice: a phantom long under the old name and an impossible negative under the new
    // one, neither of which is a real cost-basis gap. Only doubly-confirmed pairs come back from
    // this — NSE's master plus quantities that actually offset in this book — so applying it
    // here needs no further judgement. Best-effort: a missing rename master must not take down
    // the coverage report, it just means renames are not folded in.
    let renameMap = new Map();
    let renamesApplied = [];
    let renamesNeedingReview = [];
    try {
      const { buildRenameMap } = require('./symbolRenameService');
      const r = await buildRenameMap({ portfolio });
      renameMap = r.map;
      renamesApplied = r.applied;
      renamesNeedingReview = r.needsReview;
    } catch { /* rename master unavailable */ }

    const params = [];
    let where = '';
    if (portfolio) { where = 'WHERE portfolio = ?'; params.push(portfolio); }
    const orders = await allAsync(db,
      `SELECT trade_date, portfolio, symbol, side, quantity FROM orders ${where}`, params);

    const bySymbol = new Map();
    for (const o of orders) {
      const raw = String(o.symbol || '');
      // F&O descriptors carry spaces ("NIFTY 08Sep26 23850 PE") and are not equity positions.
      if (!raw || raw.includes(' ')) continue;
      // Broker code first, THEN the rename — the order is not interchangeable. A broker code is
      // the stock's alias today; a rename is the stock's identity changing over time, and it is
      // stated in NSE symbols, so it can never match a broker's private code. Resolve the other
      // way round and a stock with both an alias and a rename is missed entirely.
      const nse = String(resolveNseSymbol(raw) || raw).toUpperCase();
      const sym = renameMap.get(nse) || nse;

      if (!bySymbol.has(sym)) {
        bySymbol.set(sym, {
          symbol: sym, bought: 0, sold: 0, blocked: false, applied: [],
          firstTrade: o.trade_date, lastTrade: o.trade_date,
        });
      }
      const d = bySymbol.get(sym);
      const r = restate(Number(o.quantity || 0), o.trade_date, actions.get(sym));
      if (r.blocked) d.blocked = true;
      for (const a of r.applied) if (!d.applied.includes(a)) d.applied.push(a);
      if (String(o.side || '').toUpperCase().startsWith('B')) d.bought += r.qty;
      else d.sold += r.qty;
      if (o.trade_date < d.firstTrade) d.firstTrade = o.trade_date;
      if (o.trade_date > d.lastTrade) d.lastTrade = o.trade_date;
    }

    const shortfalls = [];
    for (const d of bySymbol.values()) {
      const net = d.bought - d.sold;
      d.net = Math.round(net * 100) / 100;
      d.incomplete = net < -TOLERANCE;
      if (!d.incomplete) continue;
      shortfalls.push({
        symbol: d.symbol,
        shortfall: Math.round(-net * 100) / 100,
        bought: Math.round(d.bought * 100) / 100,
        sold: Math.round(d.sold * 100) / 100,
        firstTrade: d.firstTrade,
        lastTrade: d.lastTrade,
        actionsApplied: d.applied,
        // Two genuinely different causes, and the distinction matters to the reader: one has no
        // acquisition on file at all, the other has some history but not enough of it.
        cause: d.bought === 0 ? 'NO_PURCHASE_RECORDED' : 'PARTIAL_HISTORY',
        reason: d.bought === 0
          ? 'No purchase is recorded for this symbol at all. Shares that arrived as an IPO '
            + 'allotment, a bonus issue or an off-market transfer are never reported by the '
            + 'broker as trades, so nothing funded these sells in the order history.'
          : 'The order history starts after some of these shares were bought, so the earliest '
            + 'purchases are missing and only part of the sold quantity has a cost basis.',
        // Stated per row rather than once at the top: a blocked adjustment makes THIS symbol's
        // comparison unreliable, and the reader needs that beside the number.
        adjustmentBlocked: d.blocked,
      });
    }
    shortfalls.sort((a, b) => b.shortfall - a.shortfall);

    return {
      ok: true,
      actionsAvailable: actions.size > 0,
      checkedSymbols: bySymbol.size,
      incompleteCount: shortfalls.length,
      shortfalls,
      bySymbol,
      tolerance: TOLERANCE,
      // Reported, not just used. A rename silently merging two rows into one changes what the
      // reader sees, so what was merged — and on what evidence — has to be inspectable.
      renamesApplied,
      // Pairs NSE lists and this book trades, whose quantities do not tell a rename's story.
      // Neither merged nor dropped: they usually mean the order history has a gap, which is a
      // different problem, and merging would bury it.
      renamesNeedingReview,
      note: shortfalls.length
        ? `${shortfalls.length} symbol(s) have sold more shares than the order history records `
          + 'buying, compared in today\'s share terms. Realised gain, cost basis and capital-gains '
          + 'figures for those symbols are understated and cannot be completed from this data.'
        : null,
    };
  } finally {
    await closeAsync(db);
  }
}

module.exports = { assessCoverage, quantityFactor, restate, TOLERANCE };
