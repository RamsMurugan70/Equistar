// Day-by-day proof that each portfolio's orders and holdings were actually captured.
//
// ── THE FALSE-ALARM PROBLEM ──────────────────────────────────────────────────
// "No orders on this day" has two completely different meanings that look identical in the
// database: you did not trade, or nobody asked the broker. A report that flags both is useless
// — most days have no trades, so the real gaps drown in noise and stop being read. That is how
// 706 GMRAIRPORT shares stayed missing for months.
//
// ── THE WITNESS ──────────────────────────────────────────────────────────────
// Holdings settle the question. If the holdings are byte-for-byte unchanged since the previous
// snapshot, nothing was traded and there was nothing to capture — a quiet day, not a gap. If
// the holdings MOVED and no orders explain it, that is a real gap, and the movement itself says
// what to go looking for ("GMRAIRPORT -906"). This is exactly the reasoning that found the
// missing sells by hand; here it runs every day, automatically.
//
// Three things keep the witness honest:
//
//   * It only judges a day when the previous snapshot is the IMMEDIATELY preceding trading day.
//     Across a longer gap a movement cannot be pinned to one date, so the day is reported as
//     unverified rather than blamed.
//   * Holdings can lag fills by a day (a buy on Tuesday appearing Wednesday). So a movement is
//     counted as explained when orders exist anywhere in the window between the two snapshots,
//     not only on the closing date.
//   * Trading days come from the Nifty candle series, so weekends AND market holidays are
//     excluded by construction rather than by a weekday calculation that would flag every
//     Diwali as a missed capture.
const { openDatabase, allAsync, closeAsync } = require('../../db/connection');
const PF = require('../../config/portfolios');

const ist = () => new Date(Date.now() + 330 * 60000);
const ymd = (d) => d.toISOString().slice(0, 10);

// Orders: what the day's capture found.
const ORDER_STATUS = {
  PRESENT: 'PRESENT',        // orders recorded for the day
  QUIET: 'QUIET',            // no orders, and holdings confirm nothing was traded
  GAP: 'GAP',                // holdings moved with no orders to explain it — actionable
  UNVERIFIED: 'UNVERIFIED',  // no orders and no way to check
};

// Holdings: whether the day's value snapshot exists at all.
const HOLDING_STATUS = { PRESENT: 'PRESENT', ABSENT: 'ABSENT' };

function holdingsMap(payloadJson) {
  try {
    const list = JSON.parse(payloadJson)?.portfolio || [];
    const map = new Map();
    for (const h of list) {
      const sym = String(h.instrument || '').toUpperCase();
      if (!sym) continue;
      map.set(sym, Number(h.qty) || 0);
    }
    return map;
  } catch { return null; }
}

// What changed between two holdings maps, largest move first — this is the "go look for this"
// list, so it is ordered by how much moved, not alphabetically.
function diffHoldings(prev, cur) {
  const moves = [];
  for (const sym of new Set([...prev.keys(), ...cur.keys()])) {
    const delta = (cur.get(sym) || 0) - (prev.get(sym) || 0);
    if (Math.abs(delta) > 0.0001) moves.push({ symbol: sym, delta });
  }
  return moves.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

async function getCoverage({ portfolios = PF.ALL, days = 45 } = {}) {
  const db = openDatabase();
  try {
    const today = ist();
    const to = ymd(today);
    const from = ymd(new Date(today.getTime() - days * 864e5));

    const tradingDays = (await allAsync(db,
      'SELECT date FROM nifty_candles WHERE date >= ? AND date <= ? ORDER BY date',
      [from, to])).map((r) => r.date);

    // Orders per (date, portfolio).
    const orderCount = new Map();
    for (const r of await allAsync(db,
      `SELECT trade_date, portfolio, COUNT(*) AS n FROM orders
        WHERE trade_date >= ? AND trade_date <= ? GROUP BY trade_date, portfolio`,
      [from, to])) {
      orderCount.set(`${r.trade_date}|${r.portfolio}`, r.n);
    }

    // Snapshots per (date, portfolio), parsed once.
    const snaps = new Map();
    for (const r of await allAsync(db,
      `SELECT snapshot_date, portfolio, payload_json FROM portfolio_snapshots
        WHERE snapshot_date >= ? AND snapshot_date <= ?`,
      [from, to])) {
      const map = holdingsMap(r.payload_json);
      if (map) snaps.set(`${r.snapshot_date}|${r.portfolio}`, map);
    }

    // Recorded capture attempts. An attempt is the only thing that can vouch for a genuinely
    // empty day going forward; the holdings witness covers days that predate the ledger.
    const attempts = new Map();
    try {
      for (const r of await allAsync(db,
        `SELECT trade_date, portfolio, kind, status, detail FROM capture_ledger
          WHERE trade_date >= ?`, [from])) {
        attempts.set(`${r.trade_date}|${r.portfolio}|${r.kind}`, r);
      }
    } catch { /* ledger not created yet */ }

    const rows = [];
    for (let i = 0; i < tradingDays.length; i += 1) {
      const date = tradingDays[i];
      const prevDay = i > 0 ? tradingDays[i - 1] : null;
      const entry = { date, portfolios: {} };

      for (const pf of portfolios) {
        const nOrders = orderCount.get(`${date}|${pf}`) || 0;
        const snap = snaps.get(`${date}|${pf}`);
        const prevSnap = prevDay ? snaps.get(`${prevDay}|${pf}`) : null;
        const attempt = attempts.get(`${date}|${pf}|orders`);

        const holdings = {
          status: snap ? HOLDING_STATUS.PRESENT : HOLDING_STATUS.ABSENT,
          count: snap ? snap.size : 0,
        };

        let orders;
        if (nOrders > 0) {
          orders = { status: ORDER_STATUS.PRESENT, count: nOrders };
        } else if (snap && prevSnap) {
          const moves = diffHoldings(prevSnap, snap);
          if (moves.length === 0) {
            orders = {
              status: ORDER_STATUS.QUIET,
              count: 0,
              detail: 'holdings unchanged — nothing was traded',
            };
          } else {
            // Holdings moved. Before calling it a gap, allow for settlement lag by checking
            // whether the neighbouring day carries orders that account for the movement.
            const nearby = (orderCount.get(`${prevDay}|${pf}`) || 0);
            if (nearby > 0) {
              orders = {
                status: ORDER_STATUS.QUIET,
                count: 0,
                detail: `holdings moved, explained by ${nearby} order(s) on ${prevDay} settling`,
              };
            } else {
              orders = {
                status: ORDER_STATUS.GAP,
                count: 0,
                detail: `${moves.length} holding(s) moved with no orders recorded`,
                evidence: moves.slice(0, 5),
              };
            }
          }
        } else if (attempt?.status === 'OK') {
          // No orders and no witness, but the capture itself is on record.
          orders = {
            status: ORDER_STATUS.QUIET,
            count: 0,
            detail: 'capture ran and returned no trades',
          };
        } else {
          orders = {
            status: ORDER_STATUS.UNVERIFIED,
            count: 0,
            detail: snap
              ? 'no orders; previous day has no snapshot to compare against'
              : 'no orders and no snapshot — nothing to verify against',
          };
        }

        entry.portfolios[pf] = { orders, holdings };
      }
      rows.push(entry);
    }

    rows.reverse();   // newest first

    // ── Corrective actions ───────────────────────────────────────────────────
    // Grouped by what actually fixes them, because the fix differs per source and one of them
    // has no fix at all. Saying so plainly beats listing rows that can never be cleared.
    const orderGaps = [];
    const holdingGaps = [];
    for (const row of rows) {
      for (const pf of portfolios) {
        const c = row.portfolios[pf];
        if (c.orders.status === ORDER_STATUS.GAP) {
          orderGaps.push({ date: row.date, portfolio: pf, evidence: c.orders.evidence || [] });
        }
        if (c.holdings.status === HOLDING_STATUS.ABSENT) {
          holdingGaps.push({ date: row.date, portfolio: pf });
        }
      }
    }

    const actions = [];
    const geethaGaps = orderGaps.filter((g) => g.portfolio === PF.ZERODHA);
    if (geethaGaps.length) {
      const dates = geethaGaps.map((g) => g.date).sort();
      actions.push({
        kind: 'TRADEBOOK',
        portfolio: PF.ZERODHA,
        severity: 'high',
        title: `${geethaGaps.length} day(s) of Geetha orders are missing`,
        why: 'Zerodha only serves the current day through its API, so these cannot be re-fetched '
          + 'and must come from a Console tradebook export.',
        how: `Console → Reports → Tradebook, ${dates[0]} to ${dates[dates.length - 1]}, equity segment.`,
        dates,
      });
    }
    const ramsGaps = orderGaps.filter((g) => g.portfolio === PF.ICICI);
    if (ramsGaps.length) {
      const dates = ramsGaps.map((g) => g.date).sort();
      actions.push({
        kind: 'RESYNC',
        portfolio: PF.ICICI,
        severity: 'high',
        title: `${ramsGaps.length} day(s) of Rams orders are missing`,
        why: 'Breeze can be queried over a date range, so these are recoverable directly.',
        how: 'Connect Breeze and run a sync — it re-pulls a trailing window and fills these in.',
        dates,
      });
    }
    if (holdingGaps.length) {
      actions.push({
        kind: 'UNRECOVERABLE',
        severity: 'info',
        title: `${holdingGaps.length} missing holdings snapshot(s)`,
        // Deliberately framed as closed rather than outstanding. A holdings snapshot is a
        // photograph of one moment; no broker will sell you last month's. Leaving these in a
        // to-do list forever trains you to ignore the list.
        why: 'A holdings snapshot can only be taken on the day itself — no broker serves a past '
          + 'one, so these cannot be recovered. They leave holes in the value history, which is '
          + 'why some Portfolio Evolution windows report themselves unavailable.',
        how: 'Nothing to do retroactively. Keeping the daily sync connected prevents new ones.',
        dates: holdingGaps.map((g) => `${g.date} ${g.portfolio}`),
      });
    }

    const flat = rows.flatMap((r) => portfolios.map((pf) => r.portfolios[pf]));
    return {
      from: tradingDays[0] || from,
      to,
      tradingDays: tradingDays.length,
      portfolios,
      rows,
      actions,
      summary: {
        ordersPresent: flat.filter((c) => c.orders.status === ORDER_STATUS.PRESENT).length,
        ordersQuiet: flat.filter((c) => c.orders.status === ORDER_STATUS.QUIET).length,
        ordersGap: flat.filter((c) => c.orders.status === ORDER_STATUS.GAP).length,
        ordersUnverified: flat.filter((c) => c.orders.status === ORDER_STATUS.UNVERIFIED).length,
        holdingsPresent: flat.filter((c) => c.holdings.status === HOLDING_STATUS.PRESENT).length,
        holdingsAbsent: flat.filter((c) => c.holdings.status === HOLDING_STATUS.ABSENT).length,
        cells: flat.length,
      },
    };
  } finally {
    await closeAsync(db);
  }
}

module.exports = { getCoverage, ORDER_STATUS, HOLDING_STATUS };
