// How the equity portfolios evolved over a chosen period.
//
// EQUITY ONLY. The F&O book is tracked in Optix and is deliberately excluded: option premium
// never appears in holdings value, so an option trade would show up here as an unexplained
// cash flow and corrupt both the return and the benchmark comparison.
//
// ── WHY NOT JUST SUBTRACT TWO PORTFOLIO VALUES ───────────────────────────────
// Snapshots record HOLDINGS, not cash. Sell Rs 5L and move it to the bank and portfolio value
// drops Rs 5L — a naive value difference calls that a Rs 5L loss. Any report that subtracts
// two values is wrong for exactly the periods where capital was rotated, which are the periods
// worth looking at.
//
// So flows come from the order book (every fill, at traded value) and the return is MODIFIED
// DIETZ, weighting each flow by the fraction of the period it was actually invested:
//
//     R = (V1 - V0 - F) / (V0 + SUM(w_i * F_i)),   w_i = (D - d_i) / D
//
// That neutralises both the size and the timing of money in and out. It answers "how did my
// invested capital perform", not "did the number get bigger".
//
// ── THE INDEX COUNTERFACTUAL ─────────────────────────────────────────────────
// Comparing your % against the index's % is still unfair when flows are lumpy: money added
// just before a rally flatters you and money added before a fall punishes you, neither of
// which is stock picking. So the same rupees, on the same dates, are simulated into Nifty.
// The gap is a RUPEE answer to "was my picking worth it", immune to flow timing.
const { openDatabase, allAsync, closeAsync } = require('../../db/connection');
const { getNiftyCandles, fetchAndStoreNiftyCandles } = require('../market/niftyService');
const PF = require('../../config/portfolios');

const r2 = (v) => Math.round(v * 100) / 100;
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// Real daily summary history begins here. A single orphan row sits at 2025-01-01 with a
// ten-month void after it, so a "1 year" lookback silently resolves its start value to a
// figure 20 months old and every number downstream inherits that lie. Windows that cannot be
// honoured are reported as unavailable instead.
const VALUE_HISTORY_STARTS = '2025-11-19';

// Per-holding payloads start later than the summaries, so symbol-level attribution has a
// shorter reach than the headline return. Reported separately rather than silently truncated.
const SNAPSHOT_STARTS = '2026-01-09';

// ── THE TWO HISTORIES, AND WHY THE EARLIER ONE IS STILL USABLE ───────────────
// There are 71 portfolio_summary rows between 2025-11-19 and 2026-01-08 with no matching
// snapshot. They carry a total value and a holding count but no per-holding detail.
//
// The headline return only needs the total, so those weeks are perfectly usable for it — the
// report was throwing away seven weeks of real history because valueAsOf reads snapshots while
// the availability gate tested the summary date, two different floors that disagreed by seven
// weeks. Attribution genuinely cannot reach back there and is reported as unavailable instead.
//
// The fallback is deliberately capped at SNAPSHOT_STARTS: summary rows cannot be health-checked
// (the priced-ratio and holding-count tests need per-holding data), and inside the damaged
// stretch the summaries are wrong in exactly the same way the snapshots are, because they are
// derived from them. Everything before 2026-01-09 predates all known damage, so the fallback
// only ever runs where there is nothing to screen for.
async function summaryValueAsOf(db, portfolios, date) {
  let value = 0;
  let invested = 0;
  let asOf = null;
  for (const pf of portfolios) {
    const row = (await allAsync(db,
      `SELECT summary_date, total_value, total_invested FROM portfolio_summary
        WHERE portfolio = ? AND summary_date <= ? AND summary_date >= ? AND total_value > 0
        ORDER BY summary_date DESC LIMIT 1`,
      [pf, date, VALUE_HISTORY_STARTS]))[0];
    if (!row) return null;          // every portfolio must be present, or the total is a fiction
    value += Number(row.total_value) || 0;
    invested += Number(row.total_invested) || 0;
    if (!asOf || row.summary_date > asOf) asOf = row.summary_date;
  }
  return { value: r2(value), invested: r2(invested), asOf };
}

const PERIODS = { '1M': 1, '2M': 2, '3M': 3, '6M': 6, '1Y': 12 };

function monthsBack(iso, m) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - m);
  return d.toISOString().slice(0, 10);
}

// ── SNAPSHOT HEALTH ──────────────────────────────────────────────────────────
// Many stored snapshots captured the holdings but not their prices. On 2026-06-19 all 33 of
// Rams' holdings carry qty with ltp 0, giving a "portfolio value" of Rs 2.84L against a real
// Rs 1.2cr; on 2026-05-07 a Zerodha help-text line was parsed as a holding and the columns
// shifted so qty landed in ltp. Both are stored in portfolio_summary as ordinary values with
// nothing marking them bad, and picking one as a period's starting value silently destroys
// every number in the report.
//
// A snapshot is trusted only if most of its holdings are actually priced. A handful of unpriced
// names is normal and expected — dead or unidentified scrips like IMAMAR sit at ltp 0
// permanently — so the bar is a majority, not perfection.
const MIN_PRICED_RATIO = 0.7;

function readSnapshot(payloadJson) {
  let holdings = [];
  try { holdings = JSON.parse(payloadJson)?.portfolio || []; } catch { return null; }
  if (!holdings.length) return null;

  let value = 0;
  let invested = 0;
  let priced = 0;
  const bySymbol = new Map();
  for (const h of holdings) {
    const sym = String(h.instrument || '').toUpperCase();
    const qty = Number(h.qty) || 0;
    const ltp = Number(h.ltp) || 0;
    const val = h.curVal != null ? Number(h.curVal) || 0 : qty * ltp;
    if (qty > 0 && ltp > 0) priced += 1;
    value += val;
    invested += Number(h.invested) || 0;
    // The mangled export produces a symbol that is a sentence; a real instrument code has no
    // spaces. This keeps that row out of the per-stock attribution.
    if (!sym || sym.includes(' ')) continue;
    const key = canonical(sym);
    const cur = bySymbol.get(key) || { qty: 0, value: 0 };
    cur.qty += qty;
    cur.value += val;
    bySymbol.set(key, cur);
  }
  const pricedRatio = priced / holdings.length;
  return {
    value, invested, bySymbol, pricedRatio, count: holdings.length,
    healthy: value > 0 && pricedRatio >= MIN_PRICED_RATIO,
  };
}

// Total value at or before a date, taken from the newest HEALTHY snapshot. The series is not
// daily and unhealthy days are skipped, so the drift is reported — a start value quietly taken
// from weeks away moves every figure that depends on it.
// ── THE DAMAGED HISTORY WINDOW ───────────────────────────────────────────────
// Between these dates the stored snapshots cannot be trusted, in three independent ways:
//
//   * 2026-05-27 onward, holdings appear under two naming schemes at exactly double the
//     quantity (GOLDCASE 92,150 becomes ZEROGE 184,300), so a Rs 1.32cr book reads Rs 1.98cr.
//   * Through June, most captures carry holdings with no prices at all — 28 of Rams' 33 names
//     sit at ltp 0, valuing a Rs 1.2cr book at Rs 2.84L.
//   * Into mid-July, the largest holdings are MISSING outright: on 2026-07-17 the four gold
//     and silver ETFs worth Rs 66L are simply not in the payload.
//
// The third kind is undetectable from the data alone. A snapshot of 34 real holdings, each
// correctly priced, is internally consistent and passes every sanity check that can be written
// — it is only wrong against outside knowledge of what should have been there. An earlier
// attempt to screen these out by comparing each capture against the median of its neighbours
// made things worse: the median is itself dragged down by the bad values, so the guard rejected
// good snapshots and accepted damaged ones, turning a correct +8.7% month into a fictional +96%.
//
// So the window is declared, not inferred. A period whose starting value would have to come
// from inside it is reported as unavailable. Refusing to answer is the only honest option when
// the underlying record is wrong in ways the code cannot see.
// ── UPDATE 2026-08-29: THE WINDOW IS NO LONGER DECLARED, IT IS READ ──────────
// Everything the note above describes has since been repaired, and each repair was verified
// against the broker rather than reasoned about:
//
//   * the gold and silver ETFs were not lost - they are PLEDGED FOR MARGIN, so the demat feed
//     reports them at zero. Breeze's pledge endpoint states the position outright (ZEROGE
//     92,150 / HDFGOL 14,589 / GOLDEX 13,667 / ICIPSE 4,634, Rs 71.7L of collateral). Their
//     daily closes were fetched and reproduced twelve prices already recorded in healthy
//     captures to the paisa, which is what confirmed the instrument codes.
//   * 2026-05-27 and 05-29 were not a bonus issue, they double-counted the pledged holding.
//     Corrected, and the resulting ETF totals land within 0.15% of the live pledged value.
//   * 19 captures between 06-02 and 06-25 had lost their PRICES, not their holdings - one held
//     4 priced rows out of 33. 388 rows repriced from verified closes.
//   * 14 captures were not this portfolio at all and are in portfolio_snapshots_quarantine.
//
// So the hardcoded stretch is now stale: every capture inside 2026-05-15..07-20 assesses clean.
// Health lives in the `snapshot_quality` table, written by one assessment and read by every
// consumer, instead of each one re-deriving it - the gap analysis re-derived these rules from
// scratch and reported 3.5 million phantom shares before getting them right.
//
// The old dates remain ONLY as a fallback for the case where snapshot_quality has not been
// populated, so an empty table degrades to the previous conservative behaviour rather than
// silently declaring everything healthy.
const DAMAGED_FROM = '2026-05-15';
const DAMAGED_TO = '2026-07-20';

let _damagedCache = { at: 0, dates: null };

// Dates whose capture is flagged anything other than OK. Cached briefly: a single evolution
// request asks about several periods and would otherwise re-read the table for each.
async function loadDamagedDates() {
  if (_damagedCache.dates && Date.now() - _damagedCache.at < 60000) return _damagedCache.dates;
  const db = openDatabase();
  try {
    // "Assessed, nothing wrong" and "never assessed" are DIFFERENT, and conflating them was a
    // real bug: once every capture had been repaired the damaged list went empty, which read as
    // "no assessment available", which fell back to the stale hardcoded window and blocked 2M
    // and 3M all over again. So the presence of ANY assessment row is what decides, and the
    // damaged set is allowed to be empty.
    const [{ n: assessed } = { n: 0 }] = await allAsync(db,
      'SELECT COUNT(*) AS n FROM snapshot_quality');
    if (!assessed) {
      _damagedCache = { at: Date.now(), dates: null };
      return null;
    }
    const rows = await allAsync(db,
      "SELECT DISTINCT snapshot_date FROM snapshot_quality WHERE status <> 'OK'");
    const dates = new Set(rows.map((r) => r.snapshot_date));
    _damagedCache = { at: Date.now(), dates };
    return dates;
  } catch {
    return null;
  } finally {
    await closeAsync(db);
  }
}

function inDamagedWindow(d, damaged) {
  if (damaged) return damaged.has(d);
  return d >= DAMAGED_FROM && d <= DAMAGED_TO;   // fallback: no assessment available
}

// ── PARTIAL-CAPTURE GUARD ────────────────────────────────────────────────────
// Interleaved through the history are captures holding 5-8 names where the surrounding days
// hold 28-42 — 2026-02-19 records 7 holdings worth Rs 2.5L on a book that held 36 worth
// Rs 1.35cr the previous day and the day after. The fetch was truncated; what it did record is
// correctly priced, so nothing inside the row marks it as incomplete.
//
// Holding COUNT is the discriminator, not value: it stays flat day to day, does not depend on
// prices being resolved, and the gap here is enormous (7 against 36) rather than marginal. A
// capture holding less than half its neighbours' usual count is a fragment.
const MIN_COUNT_RATIO = 0.5;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── SYMBOL RENAMES ───────────────────────────────────────────────────────────
// The same asset is recorded under different broker codes either side of the migration. Left
// alone, every report shows the new code as a large gain and the old as an almost equal loss —
// ZEROGE +23.05L against GOLDCASE -23.12L — which is not a good decision and a bad one, but one
// holding counted twice. Collapsed to a single identity so attribution nets out.
const SYMBOL_ALIASES = {
  // ICICI Prudential Silver ETF, renamed mid-history. NOT the same fund as SILVERBEES, which is
  // Nippon's and is held and traded separately — merging the two would combine two distinct
  // positions into one line. Verified by quantity: the 2026-05-14 snapshot holds SILVERIETF at
  // 4,634 units and the current one holds ICIPSE at 4,634, one position under two names.
  SILVERIETF: 'ICICISILVE',
};

// The gold renames (ZEROGE/GOLDCASE, HDFGOL/HDFCGOLD, GOLDEX/GOLDBEES) are deliberately NOT
// listed here: resolveNseSymbol already collapses each pair to a single name, so repeating them
// would be a second copy of the same fact, free to drift out of step with the real map.

// The two sides of the attribution speak different languages: snapshots carry ICICI codes
// (BHAELE, ANARAT, GMRINF) while orders carry NSE names (BHARATELEC, ANANDRATHI, GMRAIRPORT).
// Unmapped, a stock's holding value and its own buys and sells land under separate keys, so one
// shows a phantom loss the size of the position and the other a matching phantom gain —
// GMRAIRPORT read as -Rs 80,221 purely because the sale was filed under a different name.
//
// Resolved through the same ICICI-to-NSE map the portfolio and scanner already use, so there is
// one definition of a stock's identity across the app rather than a second list to drift.
// Required lazily: portfolioService pulls a wide dependency graph and this keeps module load
// order independent of it.
let resolveNse = null;
function toNse(sym) {
  if (!resolveNse) {
    try { ({ resolveNseSymbol: resolveNse } = require('../portfolio/portfolioService')); } catch { resolveNse = (x) => x; }
  }
  return resolveNse(sym) || sym;
}

const canonical = (sym) => {
  const nse = String(toNse(sym) || sym).toUpperCase();
  return SYMBOL_ALIASES[nse] || nse;
};

// One date, healthy for EVERY portfolio. Picking each portfolio's own best date independently
// would combine Rams from May with Geetha from June and call the sum a single day's value —
// a total that never existed, over a period nobody can name.
async function valueAsOf(db, portfolios, date) {
  const ph = portfolios.map(() => '?').join(',');
  const rows = await allAsync(db,
    `SELECT snapshot_date, portfolio, payload_json FROM portfolio_snapshots
      WHERE portfolio IN (${ph}) AND snapshot_date <= ? AND snapshot_date >= ?
      ORDER BY snapshot_date DESC LIMIT 400`,
    [...portfolios, date, VALUE_HISTORY_STARTS]);

  // Each portfolio's own typical holding count, so a fragment is judged against that book's
  // norm rather than a figure blended across portfolios of very different sizes.
  const parsed = rows.map((row) => ({ row, snap: readSnapshot(row.payload_json) })).filter((r) => r.snap);
  const normalCount = new Map();
  for (const pf of portfolios) {
    const counts = parsed.filter((r) => r.row.portfolio === pf).map((r) => r.snap.count);
    normalCount.set(pf, median(counts) || 0);
  }

  // Group by date, keeping only days where every requested portfolio is present and healthy.
  const byDate = new Map();
  for (const { row, snap } of parsed) {
    const norm = normalCount.get(row.portfolio) || 0;
    const partial = norm > 0 && snap.count < norm * MIN_COUNT_RATIO;
    const d = byDate.get(row.snapshot_date) || { date: row.snapshot_date, parts: new Map(), bad: false };
    if (!snap.healthy || partial) d.bad = true;
    d.parts.set(row.portfolio, snap);
    byDate.set(row.snapshot_date, d);
  }

  const candidates = [...byDate.values()]
    .filter((d) => !d.bad && portfolios.every((p) => d.parts.has(p)))
    .map((d) => ({
      ...d,
      value: portfolios.reduce((t, p) => t + d.parts.get(p).value, 0),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

  const skipped = [...byDate.values()].filter((d) => d.bad || !portfolios.every((p) => d.parts.has(p))).length;

  const chosen = candidates[0];

  if (!chosen) {
    // No usable snapshot. Before giving up, fall back to the summary series — but only where
    // it predates the snapshots entirely, never as a way around a snapshot that was rejected
    // as unhealthy, since the summary for such a day carries the identical bad number.
    if (date < SNAPSHOT_STARTS) {
      const fromSummary = await summaryValueAsOf(db, portfolios, date);
      if (fromSummary) {
        return {
          value: fromSummary.value,
          invested: fromSummary.invested,
          asOf: fromSummary.asOf,
          driftDays: dayDiff(fromSummary.asOf, date),
          missing: [],
          // No per-holding detail exists this far back, so attribution is skipped for the
          // window rather than silently computed against an empty starting basket — which
          // would credit every holding with its entire value as a gain.
          holdings: new Map(),
          byPortfolio: new Map(),
          normalCount,
          skippedSnapshots: skipped,
          valueSource: 'summary',
        };
      }
    }
    return {
      value: 0, invested: 0, asOf: null, driftDays: 0, missing: portfolios,
      holdings: new Map(), byPortfolio: new Map(), normalCount, skippedSnapshots: skipped,
    };
  }

  const holdings = new Map();
  const byPortfolio = new Map();
  let invested = 0;
  for (const p of portfolios) {
    const snap = chosen.parts.get(p);
    invested += snap.invested;
    byPortfolio.set(p, r2(snap.value));
    for (const [sym, v] of snap.bySymbol) {
      const cur = holdings.get(sym) || { qty: 0, value: 0 };
      cur.qty += v.qty;
      cur.value += v.value;
      holdings.set(sym, cur);
    }
  }

  return {
    value: r2(chosen.value),
    invested: r2(invested),
    asOf: chosen.date,
    driftDays: dayDiff(chosen.date, date),
    missing: [],
    holdings,
    byPortfolio,
    normalCount,
    skippedSnapshots: skipped,
  };
}

// Equity cash flows from the order book. BUY = money in, SELL = money out, at traded value.
// F&O is excluded by exchange AND by contract shape — the leading space is what separates a
// real contract ("NIFTY 25Aug26 23900 CE") from an equity that merely ends in CE/PE.
async function rawEquityFlows(db, portfolios, from, to) {
  const ph = portfolios.map(() => '?').join(',');
  return allAsync(db,
    `SELECT trade_date, portfolio, symbol, side, quantity, price,
            quantity * price AS value
       FROM orders
      WHERE portfolio IN (${ph})
        AND trade_date > ? AND trade_date <= ?
        AND COALESCE(exchange,'') NOT IN ('NFO','BFO','MCX')
        AND symbol NOT LIKE '% CE' AND symbol NOT LIKE '% PE' AND symbol NOT LIKE '% FUT'
      ORDER BY trade_date ASC, id ASC`,
    [...portfolios, from, to]);
}

// ── PHANTOM FLOW GUARD ───────────────────────────────────────────────────────
// Seven dates in Feb 2026 each carry ~37 Rams BUY rows totalling ~Rs 135L, at identical
// quantities every time, priced at that day's close. They are holdings snapshots that were
// ingested as orders, not trades — the same 37-stock basket was not bought seven times in a
// fortnight. Left in, they read as Rs 950L of deposits and drag the 6M return to -74%.
//
// Detected economically rather than by counting symbols, because real days exist with 38
// symbols and Rs 3L. You cannot buy half your portfolio again in one day without the
// portfolio's value moving to match, so a single day's buying that exceeds half the portfolio
// is a re-import, not a purchase.
const DUMP_FRACTION = 0.5;

// Both tests must be per-portfolio, not against combined figures:
//
//   * Value — Geetha's re-import days are ~Rs 26L against her own ~Rs 31L book, plainly a full
//     dump, but they vanish under half of the Rs 161L combined value.
//   * Breadth — an absolute floor of "10 or more symbols" misses her entirely, because her whole
//     book is 7 names. Seven symbols is a fragment of Rams' 36 and the entirety of Geetha's.
//
// So breadth is measured against each book's own holding count. That keeps a single large
// conviction buy safe (one symbol never approaches half a book) while catching a basket dump in
// a portfolio of any size.
const MIN_BREADTH_RATIO = 0.5;

function findPhantomDays(flows, valueByPortfolio, countByPortfolio) {
  const byDay = new Map();
  for (const f of flows) {
    if (f.side !== 'BUY') continue;
    const k = `${f.trade_date}|${f.portfolio}`;
    const cur = byDay.get(k) || { date: f.trade_date, portfolio: f.portfolio, value: 0, symbols: new Set() };
    cur.value += Number(f.value) || 0;
    cur.symbols.add(f.symbol);
    byDay.set(k, cur);
  }
  const phantom = [];
  for (const d of byDay.values()) {
    const ref = valueByPortfolio.get(d.portfolio) || 0;
    const normalCount = countByPortfolio.get(d.portfolio) || 0;
    // Whole days are excluded rather than individual rows. Two of these dates also carry
    // genuine trades — 2026-02-11 has NEXT50IETF round-trips and small GROWW adds mixed in
    // with the re-import — so the day-level exclusion drops a handful of real fills too. That
    // is the safe direction here: those fills total under Rs 1L against Rs 1,089L of phantom
    // deposits, and keeping them would mean keeping the re-import they are interleaved with.
    // The row-level split lives in scripts/quarantine_phantom_orders.py, which fixes the
    // orders table itself; this stays a read-time guard so the report is right either way.
    // Needs both: a large rupee share AND a basket-sized spread of names. A single big buy in
    // one stock is a real decision and must survive.
    const broad = normalCount > 0 ? d.symbols.size >= normalCount * MIN_BREADTH_RATIO : d.symbols.size >= 10;
    if (ref > 0 && d.value > ref * DUMP_FRACTION && broad) {
      phantom.push({ date: d.date, portfolio: d.portfolio, value: r2(d.value), symbols: d.symbols.size });
    }
  }
  return phantom;
}

async function equityFlows(db, portfolios, from, to, valueByPortfolio, countByPortfolio) {
  const all = await rawEquityFlows(db, portfolios, from, to);
  const phantom = findPhantomDays(all, valueByPortfolio, countByPortfolio);
  if (!phantom.length) return { flows: all, phantom: [] };
  const drop = new Set(phantom.map((p) => `${p.date}|${p.portfolio}`));
  return {
    flows: all.filter((f) => !drop.has(`${f.trade_date}|${f.portfolio}`)),
    phantom: phantom.sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function modifiedDietz(v0, v1, flows, from, to) {
  const D = Math.max(1, dayDiff(from, to));
  let net = 0;
  let weighted = 0;
  for (const f of flows) {
    const signed = f.side === 'BUY' ? Number(f.value) : -Number(f.value);
    const di = Math.max(0, Math.min(D, dayDiff(from, f.trade_date)));
    net += signed;
    weighted += signed * ((D - di) / D);
  }
  const base = v0 + weighted;
  // A base at or below zero means the period was funded almost entirely by new money late in
  // the window — there is no meaningful capital to express a return against, so none is
  // claimed rather than printing a number that divides by near-nothing.
  const pct = base > 0 ? ((v1 - v0 - net) / base) * 100 : null;
  return {
    days: D,
    netFlow: r2(net),
    weightedBase: r2(base),
    gain: r2(v1 - v0 - net),
    returnPct: pct == null ? null : r2(pct),
  };
}

// The same rupees, on the same dates, into Nifty instead.
function indexCounterfactual(v0, flows, candles, from) {
  if (!candles.length) return null;
  const priceOn = (d) => {
    let last = null;
    for (const c of candles) {
      if (c.date <= d) last = c.close; else break;
    }
    return last ?? candles[0].close;
  };
  const startPx = priceOn(from);
  const last = candles[candles.length - 1];
  const endPx = Number(last.close);
  if (!(startPx > 0) || !(endPx > 0)) return null;

  let units = v0 / startPx;
  for (const f of flows) {
    const px = priceOn(f.trade_date);
    if (!(px > 0)) continue;
    const signed = f.side === 'BUY' ? Number(f.value) : -Number(f.value);
    units += signed / px;
  }
  return {
    startPrice: r2(startPx),
    endPrice: r2(endPx),
    // The candle series can lag the portfolio snapshot by a few days. Surfaced so a comparison
    // made against a stale index close is visible rather than assumed current.
    asOf: last.date,
    indexReturnPct: r2(((endPx - startPx) / startPx) * 100),
    value: r2(units * endPx),
  };
}

// ── ORPHAN PAIR MERGE ────────────────────────────────────────────────────────
// Some ICICI codes are missing from the shared map, so a stock's holding and its own trades
// still land under two keys. The signature is unmistakable: one symbol holds value at the start
// and vanishes with no sale recorded, another records the sale while never appearing as a
// holding, and the two contributions cancel almost exactly. ULTRACEMCO shows -Rs 175,380 held
// and ULTCEM +Rs 175,188 sold — one position whose real result was a Rs 192 loss, reported as
// a large win and a large loss sitting together in the same table.
//
// Matched on VALUE, never on name similarity. A near-exact offset between a vanished holding
// and an unattached trade is evidence two records describe one position; guessing that ULTCEM
// "looks like" ULTRACEMCO is how a wrong mapping gets in and stays. The inferred pairs are
// reported so the real map can be corrected at source.
const OFFSET_TOLERANCE = 0.02;

function mergeOrphanPairs(rows) {
  const heldOnly = rows.filter((c) => c.startValue > 0 && c.endValue === 0 && !c.bought && !c.sold);
  const tradedOnly = rows.filter((c) => c.startValue === 0 && c.endValue === 0 && (c.bought || c.sold));
  const merged = new Map();
  const inferred = [];

  for (const held of heldOnly) {
    const match = tradedOnly.find((t) => !merged.has(t.symbol)
      && Math.abs(held.contribution + t.contribution) <= Math.abs(held.contribution) * OFFSET_TOLERANCE);
    if (!match) continue;
    merged.set(match.symbol, held.symbol);
    merged.set(held.symbol, held.symbol);
    inferred.push({ holding: held.symbol, trades: match.symbol, netContribution: r2(held.contribution + match.contribution) });
  }
  if (!inferred.length) return { rows, inferred };

  const out = [];
  for (const c of rows) {
    const target = merged.get(c.symbol);
    if (!target) { out.push(c); continue; }
    const existing = out.find((o) => o.symbol === target);
    if (!existing) { out.push({ ...c, symbol: target }); continue; }
    existing.startValue = r2(existing.startValue + c.startValue);
    existing.endValue = r2(existing.endValue + c.endValue);
    existing.bought = r2(existing.bought + c.bought);
    existing.sold = r2(existing.sold + c.sold);
    existing.contribution = r2(existing.contribution + c.contribution);
  }
  return { rows: out, inferred };
}

// The date a period stops overlapping the damaged stretch on its own: the first day whose
// lookback starts after DAMAGED_TO. Reported so a blocked window reads as "wait" rather than
// "broken", and so nobody goes looking for a fix that does not exist.
// `base` is whichever obstacle actually blocks the period — the end of the damaged stretch, or
// the first day any value was ever recorded. Passing the wrong one is not a cosmetic slip: the
// 1Y window was being told it healed on 2027-07-21, computed from the damaged window, when the
// real answer is 2026-11-19 — eight months of difference, presented with total confidence.
function healDate(months, base) {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Which periods can be answered right now. Cheap — it only resolves each window's start date
// and checks where it lands, doing none of the flow, benchmark or attribution work.
async function workingPeriods({ portfolios, to }) {
  const damaged = await loadDamagedDates();
  const db = openDatabase();
  try {
    const out = [];
    for (const [name, months] of Object.entries(PERIODS)) {
      const requested = monthsBack(to, months);
      if (requested < VALUE_HISTORY_STARTS) continue;
      const start = await valueAsOf(db, portfolios, requested);
      if (start.asOf && !inDamagedWindow(start.asOf, damaged)) out.push(name);
    }
    return out;
  } finally {
    await closeAsync(db);
  }
}

async function getEvolution({ period = '3M', portfolios = PF.ALL } = {}) {
  const months = PERIODS[period] || 3;
  const to = istToday();
  const requestedFrom = monthsBack(to, months);

  const db = openDatabase();

  // Keep the benchmark current before reading it, because a week-old close quietly flatters or
  // punishes the comparison. But only when it is actually behind: candles are daily, so
  // refetching on every page load spent ~2.5s on a Yahoo round-trip to rewrite the same 247
  // rows. Failure is not fatal — the stored candles still work and their date is reported.
  //
  // The staleness test allows two days rather than requiring today's date: there is no candle
  // on a weekend or a holiday, so "newest < today" is permanently true every Saturday and
  // would refetch on every load precisely when there is nothing new to fetch.
  try {
    const newest = (await allAsync(db, 'SELECT MAX(date) AS date FROM nifty_candles'))[0]?.date;
    if (!newest || dayDiff(newest, to) > 2) await fetchAndStoreNiftyCandles();
  } catch { /* fall back to stored candles */ }

  try {
    const unavailable = requestedFrom < VALUE_HISTORY_STARTS
      ? `Portfolio history begins ${VALUE_HISTORY_STARTS}. A ${period} window starts ${requestedFrom}, `
        + 'before any recorded value exists, so this period cannot be computed without '
        + 'inventing a starting point.'
      : null;
    if (unavailable) {
      return {
        ok: false,
        period,
        portfolios,
        requestedFrom,
        to,
        unavailable,
        availableFrom: VALUE_HISTORY_STARTS,
        healsOn: healDate(months, VALUE_HISTORY_STARTS),
        // States the date rather than the rule. "Once that much time has passed" leaves the
        // reader to do the arithmetic, and the whole point of this panel is that they should
        // not have to work out whether something is broken or merely early.
        healsNote: `This period becomes available on ${healDate(months, VALUE_HISTORY_STARTS)}, `
          + `once ${period} back from today reaches ${VALUE_HISTORY_STARTS} — the first day any `
          + 'portfolio value was recorded. Nothing needs doing.',
        worksNow: await workingPeriods({ portfolios, to }),
      };
    }

    const [start, end] = await Promise.all([
      valueAsOf(db, portfolios, requestedFrom),
      valueAsOf(db, portfolios, to),
    ]);
    if (!start.asOf || !end.asOf) {
      return {
        ok: false, period, portfolios, requestedFrom, to,
        unavailable: `No portfolio value recorded for ${[...start.missing, ...end.missing].join(', ')} in this window.`,
      };
    }

    // The starting value landed inside the damaged stretch, so every figure built on it — the
    // return, the benchmark gap, the per-stock attribution — would be wrong in a way that looks
    // entirely reasonable on screen. Reported as unavailable instead.
    if (inDamagedWindow(start.asOf, await loadDamagedDates())) {
      // A refusal is only half an answer. Left at "not available" this reads as a bug — more so
      // because 3M and 6M work while 2M does not, which looks arbitrary until you know that the
      // longer windows reach back PAST the damaged stretch while the shorter one lands inside
      // it. So the response also carries the date the period heals itself and which periods
      // work right now, and the page offers those as buttons.
      const heals = healDate(months, DAMAGED_TO);
      return {
        ok: false,
        period,
        portfolios,
        requestedFrom,
        to,
        unavailable: `A ${period} window starts ${requestedFrom}, and the nearest stored value is `
          + `${start.asOf} — inside the ${DAMAGED_FROM} to ${DAMAGED_TO} stretch where the `
          + 'snapshots are wrong: the gold ETFs are recorded at zero quantity, some days carry no '
          + 'prices at all, and two days count the same holdings twice. A return computed from '
          + 'any of that would look entirely reasonable and be wrong.',
        // Why it cannot simply be repaired, since that is the obvious next question.
        whyNotFixable: 'The missing quantities cannot be rebuilt from the order book either: '
          + 'rolling positions back across this window misses two unrecorded bonus issues '
          + '(ANANDRATHI 1:1, CUB 4:3), and there is no intact snapshot inside the window to '
          + 'check any reconstruction against.',
        healsOn: heals,
        healsNote: `This period fixes itself on ${heals}, once ${period} back from today clears `
          + `${DAMAGED_TO}. Nothing needs doing.`,
        damagedWindow: { from: DAMAGED_FROM, to: DAMAGED_TO },
        worksNow: await workingPeriods({ portfolios, to }),
      };
    }

    const from = start.asOf;
    // Sized per portfolio against its larger endpoint, so a book that genuinely grew is not
    // mistaken for a re-import.
    const refValues = new Map(portfolios.map((p) => [p,
      Math.max(start.byPortfolio.get(p) || 0, end.byPortfolio.get(p) || 0)]));
    const { flows, phantom } = await equityFlows(db, portfolios, from, to, refValues,
      end.normalCount);
    const dietz = modifiedDietz(start.value, end.value, flows, from, to);

    let candles = [];
    try { candles = await getNiftyCandles({ fromDate: from, toDate: to }); } catch { /* no benchmark */ }
    const index = indexCounterfactual(start.value, flows, candles, from);

    // ── Per-symbol contribution ──────────────────────────────────────────────
    // value change, plus what was sold, minus what was bought. That folds mark-to-market and
    // realised profit into one figure, which is what "how much did this stock make me this
    // period" actually means — a stock sold at a profit mid-period would otherwise vanish.
    const attributable = from >= SNAPSHOT_STARTS;
    let best = [];
    let worst = [];
    let contributions = [];
    let attributionNote = null;
    let inferredAliases = [];
    if (attributable) {
      // Reuses the healthy snapshots already chosen for the endpoints, so attribution and the
      // headline are always describing the same two days.
      const bySym = new Map();
      const touch = (s) => {
        const k = canonical(String(s || '').toUpperCase());
        if (!bySym.has(k)) bySym.set(k, { symbol: k, startValue: 0, endValue: 0, bought: 0, sold: 0 });
        return bySym.get(k);
      };
      for (const [s, v] of start.holdings) touch(s).startValue = v.value;
      for (const [s, v] of end.holdings) touch(s).endValue = v.value;
      for (const f of flows) {
        const c = touch(f.symbol);
        if (f.side === 'BUY') c.bought += Number(f.value); else c.sold += Number(f.value);
      }
      contributions = [...bySym.values()].map((c) => ({
        symbol: c.symbol,
        startValue: r2(c.startValue),
        endValue: r2(c.endValue),
        bought: r2(c.bought),
        sold: r2(c.sold),
        exited: c.endValue === 0 && c.sold > 0,
        contribution: r2(c.endValue - c.startValue - c.bought + c.sold),
      }));
      const mergedResult = mergeOrphanPairs(contributions);
      inferredAliases = mergedResult.inferred;
      contributions = mergedResult.rows
        .filter((c) => Math.abs(c.contribution) >= 1)
        .sort((a, b) => b.contribution - a.contribution);
      best = contributions.slice(0, 5);
      worst = contributions.slice(-5).reverse().filter((c) => c.contribution < 0);
    } else {
      attributionNote = `Per-stock attribution needs holdings snapshots, which begin ${SNAPSHOT_STARTS}. `
        + `This window starts ${from}, so the headline return is shown without a stock-level breakdown.`;
    }

    const bought = flows.filter((f) => f.side === 'BUY').reduce((s, f) => s + Number(f.value), 0);
    const sold = flows.filter((f) => f.side === 'SELL').reduce((s, f) => s + Number(f.value), 0);

    return {
      ok: true,
      period,
      portfolios,
      from,
      to,
      requestedFrom,
      startDriftDays: start.driftDays,
      value: {
        start: start.value,
        end: end.value,
        change: r2(end.value - start.value),
        invested: end.invested,
        byPortfolio: Object.fromEntries(end.byPortfolio),
      },
      // Money moved in and out of the bank, kept separate from performance so a big deposit is
      // never mistaken for a good month.
      flows: { bought: r2(bought), sold: r2(sold), net: r2(bought - sold), count: flows.length },
      // Symbol pairs merged on matching value because the broker code is missing from the
      // shared map. Surfaced so the mapping can be fixed properly rather than re-derived here
      // every run.
      inferredAliases,
      // Order rows excluded as re-imports rather than trades. Listed, not hidden: they are a
      // data defect worth cleaning at source, and the user should see what was removed.
      excludedImports: phantom,
      dietz,
      index,
      // The rupee verdict: what the same money, moved on the same days, would be worth in Nifty.
      vsIndexRs: index ? r2(end.value - index.value) : null,
      best,
      worst,
      contributions,
      notes: {
        equityOnly: 'Equity only — the F&O book is tracked in Optix.',
        attribution: attributionNote,
        drift: start.driftDays > 3
          ? `Start value taken from ${from}, ${start.driftDays} days before the requested `
            + `${requestedFrom} — the value series is not daily.`
          : null,
        benchmarkStale: index && dayDiff(index.asOf, to) > 3
          ? `Nifty close is from ${index.asOf}, ${dayDiff(index.asOf, to)} days behind the `
            + 'portfolio value — the comparison is not like-for-like until candles refresh.'
          : null,
        phantom: phantom.length
          ? `${phantom.length} day(s) of bulk order rows totalling `
            + `${Math.round(phantom.reduce((t, p) => t + p.value, 0) / 100000)}L were excluded as `
            + 'portfolio re-imports, not trades: the same basket repeats at identical quantities '
            + `(${phantom.map((p) => p.date).join(', ')}). Worth cleaning up in the orders table.`
          : null,
        badSnapshots: (start.skippedSnapshots + end.skippedSnapshots) > 0
          ? `${start.skippedSnapshots + end.skippedSnapshots} snapshot(s) were skipped because `
            + 'their holdings had no prices attached; the nearest fully priced day was used instead.'
          : null,
        corpActions: 'Split and bonus records begin 2026-05-11; windows starting before that '
          + 'may contain unadjusted prices.',
      },
    };
  } finally {
    await closeAsync(db);
  }
}

module.exports = { getEvolution, PERIODS, VALUE_HISTORY_STARTS, SNAPSHOT_STARTS };
