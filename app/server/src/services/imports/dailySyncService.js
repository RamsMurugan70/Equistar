// Day-end capture of orders and holdings for every portfolio, and an honest record of whether
// it worked.
//
// ── THE CONSTRAINT THAT SHAPES THIS ──────────────────────────────────────────
// Neither broker login can be automated. Breeze sessions die at 23:59 IST the same day; Kite
// tokens die at 06:00 IST the next morning, and Zerodha issues no refresh token — a daily
// interactive 2FA login is mandatory. So this job cannot guarantee a capture; it can only take
// one when a session happens to be alive.
//
// That is why the ledger matters more than the schedule. An automated job that silently fails
// on the days you did not log in reproduces exactly the bug it was meant to prevent: 706
// GMRAIRPORT shares went missing because an import did not run and nothing said so. Every
// attempt here is written down, successful or not, so a miss becomes a row you can see.
//
// ── RETRIES ──────────────────────────────────────────────────────────────────
// The first attempt is at 16:00 IST, after the 15:30 close. If a session is not connected then,
// the run records the failure and later attempts retry through the evening — so logging in at
// 20:00 still captures the day by itself, with no button to remember to press.
//
// ── WHY BREEZE AND KITE ARE NOT SYMMETRIC ────────────────────────────────────
// Breeze order history is queryable over a date range, so its capture re-pulls a trailing
// window and repairs earlier misses on its own. Kite's /orders endpoint returns TODAY only —
// a missed Geetha day can never be recovered through the API, and needs a Console tradebook
// export instead. The ledger says which days those are.
const breezeService = require('../breeze/breezeService');
const kiteService = require('../kite/kiteService');
const importsService = require('./importsService');
const orderSync = require('./orderSyncService');
const ledger = require('../../repositories/captureLedgerRepository');
const { openDatabase, allAsync, closeAsync } = require('../../db/connection');
const PF = require('../../config/portfolios');

// Never throws: a broker whose key will not build a login URL simply has none, and the card says
// so rather than taking the page down.
function loginUrlFor(service) {
  try { return service.getLoginUrl(); } catch { return null; }
}

// Capture is deliberately all-segment (cash AND F&O). The equity app only displays the equity
// side, but the same broker call returns both, and filtering at capture time would leave the
// F&O book in Optix quietly missing the very days this job exists to protect.
const BROKERS = [
  { key: 'breeze', portfolio: PF.ICICI, label: 'ICICI Breeze', service: breezeService },
  { key: 'kite', portfolio: PF.ZERODHA, label: 'Zerodha Kite', service: kiteService },
];

// How far back the order fetch reaches. Kept as a window so a missed evening repairs itself on
// the next run; five days spans a long weekend plus a holiday.
const ORDER_LOOKBACK_DAYS = 5;

const ist = () => new Date(Date.now() + 330 * 60000);
const ymd = (d) => d.toISOString().slice(0, 10);

function connectionStatus() {
  return BROKERS.map(({ key, portfolio, label, service }) => {
    const s = service.getSessionStatus();
    return {
      broker: key,
      label,
      portfolio,
      connected: !!s.connected,
      expiresAt: s.expiresAt || null,
      loginAt: s.loginAt || null,
      hasApiKey: !!s.hasApiKey,
      // Supplied so the page can offer a REAL LINK. It previously fetched this URL on click and
      // then called window.open — but a popup opened after an await is blocked by the browser,
      // the user-activation window having closed, so the button silently did nothing at all.
      loginUrl: s.hasApiKey ? loginUrlFor(service) : null,
      // Told apart deliberately: a missing API key is a setup problem needing .env, while an
      // expired session just needs today's login. The fix is different, so the message is too.
      reason: s.connected ? null
        // Not ".env" any more: keys are per-participant and entered on the Brokers page. The
        // old wording told a participant to edit a file on a server they cannot reach.
        : (!s.hasApiKey
          ? 'No API key saved yet — add it on the Brokers page'
          : 'Not connected today — use Connect on the Brokers page'),
    };
  });
}


// ── WHAT "0 NEW" ACTUALLY MEANS ──────────────────────────────────────────────
// Three different outcomes were all being reported as "0 new", and only one of them is a
// problem:
//
//   * the broker returned nothing         -> you did not trade
//   * everything returned was already in  -> the capture worked, earlier
//   * the insert silently dropped rows    -> a real fault
//
// Collapsing them made a healthy sync look empty. On 2026-08-24 the run reported "OK - 0 new"
// having fetched 57 orders, every one of them already recorded from an 11:24 run — the day's
// F&O and equity fills were all safely captured, and the report said nothing that conveyed it.
//
// So the count that gets reported is what is ON RECORD FOR THE DAY, which is the question
// being asked ("did my orders make it in?"), with new-vs-already-had as the supporting detail.
async function ordersOnRecord(portfolio, tradeDate) {
  const db = openDatabase();
  try {
    const row = (await allAsync(db,
      'SELECT COUNT(*) AS n FROM orders WHERE portfolio = ? AND trade_date = ?',
      [portfolio, tradeDate]))[0];
    return row?.n ?? 0;
  } catch { return null; } finally { await closeAsync(db); }
}

// Per-date counts across the fetch window, so a run can say WHICH days it added to rather than
// reporting one lump sum. Taken before and after the fetch and diffed — that works whatever
// syncCharges does internally, and does not require it to report per-date itself.
async function ordersByDate(portfolio, from, to) {
  const db = openDatabase();
  try {
    const rows = await allAsync(db,
      `SELECT trade_date, COUNT(*) AS n FROM orders
        WHERE portfolio = ? AND trade_date >= ? AND trade_date <= ?
        GROUP BY trade_date`,
      [portfolio, from, to]);
    return new Map(rows.map((r) => [r.trade_date, r.n]));
  } catch { return new Map(); } finally { await closeAsync(db); }
}

// Phrases the outcome so the headline is true at a glance rather than only after reading the
// detail line.
function describeOrders({ addedToday, onRecord, tradeDate, backfilled = [], windowFrom }) {
  // Today leads, always. The window is mentioned only when it actually did something, because
  // a date range that repaired nothing is noise, and one that repaired something is the whole
  // point of having it.
  const repaired = backfilled.reduce((t, b) => t + b.added, 0);
  const extra = repaired
    ? ` · also backfilled ${repaired} fill(s) into ${backfilled.map((b) => `${b.date} (+${b.added})`).join(', ')}`
    : '';

  if (onRecord === 0) {
    return {
      summary: 'no trades today',
      detail: `no executed fills for ${tradeDate}${extra || ` · checked back to ${windowFrom}`}`,
    };
  }
  if (addedToday > 0) {
    return {
      summary: `${addedToday} new`,
      detail: `${addedToday} added for ${tradeDate}, ${onRecord} now on record${extra}`,
    };
  }
  return {
    summary: `up to date - ${onRecord} on record`,
    detail: `all ${onRecord} fill(s) for ${tradeDate} already recorded${extra}`,
  };
}

async function captureRams(tradeDate) {
  const out = [];
  // Orders: reuses the charges sync, which already pulls a trailing multi-day window across all
  // segments and refreshes brokerage. Duplicating that here would mean two implementations of
  // the same broker call drifting apart.
  try {
    // A TRAILING WINDOW, REPORTED PER DAY.
    //
    // The window is worth keeping: Breeze can be queried by date range, so re-pulling several
    // days is what lets a missed evening repair itself on the next run. Narrowing it to today
    // removed that safety net — the ledger would still SHOW a gap, but nothing would close it
    // without a manual tradebook import.
    //
    // What actually caused confusion was never the window, it was the reporting. A run that
    // fetched 40 fills back to 21 Aug announced "40 fetched, all 40 already recorded" while the
    // eight placed that day appeared only as a trailing "8 on record" — the week's number led,
    // so a correct capture read as a failure.
    //
    // So the fetch spans the window and the REPORT speaks per day: today is the headline, and
    // anything backfilled into an earlier day is named as that day rather than folded into one
    // total.
    const winFrom = ymd(new Date(ist().getTime() - ORDER_LOOKBACK_DAYS * 864e5));
    const before = await ordersByDate(PF.ICICI, winFrom, tradeDate);
    const r = await orderSync.syncOrderWindow({ days: ORDER_LOOKBACK_DAYS });
    if (r.ok) {
      const after = await ordersByDate(PF.ICICI, winFrom, tradeDate);
      const addedToday = (after.get(tradeDate) || 0) - (before.get(tradeDate) || 0);
      // Earlier days the window repaired — the reason for keeping it.
      const backfilled = [...after.entries()]
        .filter(([d, n]) => d !== tradeDate && n > (before.get(d) || 0))
        .map(([d, n]) => ({ date: d, added: n - (before.get(d) || 0) }))
        .sort((a, b) => a.date.localeCompare(b.date));

      const onRecord = await ordersOnRecord(PF.ICICI, tradeDate);
      const d = describeOrders({
        addedToday, onRecord, tradeDate, backfilled,
        windowFrom: winFrom,
      });
      out.push({ kind: 'orders', status: 'OK', rows: addedToday,
        fetched: r.fetched ?? 0, onRecord, backfilled,
        summary: d.summary, detail: d.detail });
    } else {
      out.push({ kind: 'orders', status: 'FAILED', rows: 0, detail: r.reason });
    }
  } catch (e) {
    out.push({ kind: 'orders', status: 'FAILED', rows: 0, detail: e.message });
  }

  try {
    const holdings = await breezeService.fetchHoldings();
    if (!holdings?.length) throw new Error('Breeze returned no holdings');
    const res = await importsService.importPortfolioSnapshot({
      portfolio: PF.ICICI,
      snapshotDate: tradeDate,
      fileName: `breeze-rams-${tradeDate}.json`,
      holdings,
    });
    out.push({ kind: 'holdings', status: 'OK', rows: res.rowsInserted ?? 0,
      summary: `${res.rowsInserted ?? 0} holdings`,
      detail: `${res.rowsInserted ?? 0} holdings stored for ${tradeDate}` });
  } catch (e) {
    out.push({ kind: 'holdings', status: 'FAILED', rows: 0, detail: e.message });
  }
  return out;
}

async function captureGeetha(tradeDate) {
  const out = [];
  try {
    const orders = await kiteService.fetchOrders();
    const mapped = (orders || []).map((o) => ({
      tradeDate: o.trade_date || tradeDate,
      // Zerodha ids exceed Number.MAX_SAFE_INTEGER, so they are kept as text. Storing the id at
      // all is what lets a re-import recognise a fill instead of inserting it twice.
      tradeId: o.trade_id ? String(o.trade_id) : null,
      symbol: o.symbol,
      side: o.side,
      quantity: o.quantity,
      price: o.price,
      exchange: o.exchange,
    }));
    const onRecord = await ordersOnRecord(PF.ZERODHA, tradeDate);
    if (!mapped.length) {
      // A quiet day is a successful capture, not a failure — but it must still be recorded,
      // because "no orders" and "never asked" look identical in the orders table afterwards.
      out.push({ kind: 'orders', status: 'OK', rows: 0, fetched: 0, alreadyHad: 0, onRecord,
        summary: 'no trades today', detail: `Kite returned no fills for ${tradeDate}` });
    } else {
      const res = await importsService.importMissingOrders({
        portfolio: PF.ZERODHA,
        fileName: `kite-orders-geetha-${tradeDate}.json`,
        orders: mapped,
      });
      const after = await ordersOnRecord(PF.ZERODHA, tradeDate);
      const d = describeOrders({
        fetched: mapped.length, inserted: res.rowsInserted ?? 0, alreadyHad: res.rowsSkipped ?? 0,
        onRecord: after, tradeDate,
      });
      out.push({ kind: 'orders', status: 'OK', rows: res.rowsInserted ?? 0,
        fetched: mapped.length, alreadyHad: res.rowsSkipped ?? 0, onRecord: after,
        summary: d.summary, detail: d.detail });
    }
  } catch (e) {
    out.push({ kind: 'orders', status: 'FAILED', rows: 0, detail: e.message });
  }

  try {
    const holdings = await kiteService.fetchHoldings();
    if (!holdings?.length) throw new Error('Kite returned no holdings');
    const res = await importsService.importPortfolioSnapshot({
      portfolio: PF.ZERODHA,
      snapshotDate: tradeDate,
      fileName: `kite-geetha-${tradeDate}.json`,
      holdings,
    });
    out.push({ kind: 'holdings', status: 'OK', rows: res.rowsInserted ?? 0,
      summary: `${res.rowsInserted ?? 0} holdings`,
      detail: `${res.rowsInserted ?? 0} holdings stored for ${tradeDate}` });
  } catch (e) {
    out.push({ kind: 'holdings', status: 'FAILED', rows: 0, detail: e.message });
  }
  return out;
}

async function runDailySync({ trigger = 'manual', tradeDate } = {}) {
  const date = tradeDate || ymd(ist());
  const results = [];

  for (const broker of BROKERS) {
    const status = broker.service.getSessionStatus();
    if (!status.connected) {
      // Recorded as a failure against BOTH kinds. Skipping quietly here is precisely how a day
      // goes missing: no rows, no error, nothing to notice later.
      const detail = status.hasApiKey
        ? `${broker.label} not connected — log in to capture this day`
        // Not ".env": keys are per-participant now and entered on the Brokers page. The old
        // wording told a participant to edit a file on a server they cannot reach.
        : `${broker.label} has no API key yet — add it on the Brokers page`;
      for (const kind of ledger.KINDS) {
        await ledger.record({ tradeDate: date, portfolio: broker.portfolio, kind,
          status: 'FAILED', rows: 0, detail });
        results.push({ portfolio: broker.portfolio, broker: broker.key, kind,
          status: 'FAILED', rows: 0, detail });
      }
      continue;
    }

    const steps = broker.key === 'breeze' ? await captureRams(date) : await captureGeetha(date);
    for (const step of steps) {
      await ledger.record({ tradeDate: date, portfolio: broker.portfolio, ...step });
      results.push({ portfolio: broker.portfolio, broker: broker.key, ...step });
    }
  }

  const failed = results.filter((r) => r.status === 'FAILED').length;
  return {
    ok: failed === 0,
    tradeDate: date,
    trigger,
    ranAt: ist().toISOString(),
    results,
    failed,
  };
}

async function getStatus({ sinceDays = 45 } = {}) {
  const portfolios = BROKERS.map((b) => b.portfolio);
  const [gaps, recent] = await Promise.all([
    ledger.listGaps({ portfolios, sinceDays }),
    ledger.listRecent({ portfolios, days: 10 }),
  ]);
  const today = ymd(ist());
  return {
    today,
    connections: connectionStatus(),
    todayCaptured: recent.filter((r) => r.trade_date === today),
    gaps,
    // Kite cannot backfill through the API, so these specifically need a tradebook export.
    gapsNeedingTradebook: gaps.filter((g) => g.portfolio === PF.ZERODHA && g.kind === 'orders'),
    recent,
  };
}

// ── Scheduler ────────────────────────────────────────────────────────────────
// 16:00 IST after the close, then hourly through 21:00 so a late login still captures the day
// on its own. Each attempt overwrites the ledger row, so a success clears an earlier failure.
const SLOTS = [16, 17, 18, 19, 20, 21];

// The day-end scheduler that used to live here is deliberately gone. Capture happens when the
// participant presses Sync now, and at no other time — neither broker session can be renewed
// without a human, so an unattended attempt fails for anyone who has not logged in that day.
module.exports = { runDailySync, getStatus, connectionStatus };
