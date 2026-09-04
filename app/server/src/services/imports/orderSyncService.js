// Pulls a trailing window of orders from ICICI Breeze and imports whatever is new.
//
// RENAMED FROM chargesSyncService, which was a misleading name for what it does. The brokerage
// figures it also collected were a side effect; the order fetch is the substance, and it is what
// the Daily Sync page depends on. EquiStar drops the brokerage half — Breeze reports charges only
// for derivatives, which this deployment does not carry — and keeps the fetch.
//
// A TRAILING WINDOW, not just today. Breeze can be queried by date range, so re-pulling several
// days is what lets a missed evening repair itself the next time someone presses Sync now.
// Pulls executed orders from Breeze and refreshes daily_brokerage on a schedule.
//
// WHY THIS EXISTS: charges were only ever written by POST /api/breeze/save-orders, which the
// UI calls during a MANUAL import. Nothing refreshed them automatically, so the "Total
// Charges" tile silently froze at whatever date was last imported by hand.
//
// WHY IT RE-IMPORTS A WINDOW, NOT JUST TODAY: Breeze frequently returns total_taxes = 0 on
// trade day and only fills it in after settlement (documented in breezeService._mapTrade).
// A same-day-only sync would therefore permanently under-report charges for every day it
// ran. Re-importing the trailing window lets settled figures overwrite the provisional ones.
//
// Order inserts are dedup-append (importsService.importMissingOrders matches on the
// date/symbol/side/qty/price/exchange tuple), and daily_brokerage upserts on
// (trade_date, portfolio, exchange) — so re-running over an overlapping window is safe.
const breezeService = require('../breeze/breezeService');
const importsService = require('./importsService');

const PORTFOLIO = process.env.CHARGES_SYNC_PORTFOLIO || 'Rams';
const LOOKBACK_DAYS = Number(process.env.CHARGES_SYNC_LOOKBACK_DAYS || 5);

const SYNC_H = 19;   // 19:15 IST — after settlement figures have appeared, before the
const SYNC_M = 15;   // 20:00 corporate-actions job.

function _ist() { return new Date(Date.now() + 330 * 60000); }
function _ymd(d) { return d.toISOString().slice(0, 10); }

async function syncCharges({ days = LOOKBACK_DAYS, portfolio = PORTFOLIO } = {}) {
  if (!breezeService.getSessionStatus().connected) {
    return { ok: false, reason: 'Breeze session not connected' };
  }
  const to = _ist();
  const from = new Date(to.getTime() - days * 24 * 3600 * 1000);

  const orders = await breezeService.fetchAllOrders(_ymd(from), _ymd(to));
  if (!orders?.length) return { ok: true, fetched: 0, inserted: 0, chargeDays: 0 };

  const mapped = orders.map((o) => ({
    tradeDate: o.trade_date || _ymd(to),
    tradeId: null,               // Breeze order_id exceeds JS safe-int; the tuple match is used
    // Kept as TEXT for that same reason — 202608181400030309 is past Number.MAX_SAFE_INTEGER
    // and loses its trailing digits as a number. Those digits are a monotonic intraday
    // sequence, and since Breeze sends no trade_time they are the ONLY way to order fills
    // within a day.
    //
    // This was missing here while the manual save path (breezeController.saveOrders) has
    // always stored it, so which capture route an order arrived by decided whether it kept
    // its ordering key. Now that the daily sync runs automatically every evening, that made
    // the automatic path the lossy one: all 11 F&O rows for 2026-08-25 landed with a NULL
    // broker id, and FIFO fell back to insert order — which cannot tell a sold-then-bought-back
    // short from a bought-then-sold long. For an option-SELLING book that is the distinction
    // that matters, and it is what puts a "SIDE?" marker on a closed row.
    brokerOrderId: o.order_id ? String(o.order_id) : null,
    symbol: o.symbol,
    side: o.side,
    quantity: o.quantity,
    price: o.price,
    exchange: o.exchange,
    charges: o.charges || 0,
  }));

  const fileName = `breeze-orders-${portfolio.toLowerCase()}-auto-${_ymd(to)}.json`;
  const result = await importsService.importMissingOrders({ portfolio, fileName, orders: mapped });

  // The brokerage aggregation that used to sit here is gone with the F&O side: Breeze
  // reports charges only for derivatives, so on an equity book it summed zeroes.

  return {
    ok: true,
    window: { from: _ymd(from), to: _ymd(to) },
    fetched: orders.length,
    inserted: result?.rowsInserted ?? 0,
    skipped: result?.rowsSkipped ?? 0,
  };
}

module.exports = { syncOrderWindow: syncCharges };
