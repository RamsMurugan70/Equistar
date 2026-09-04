// Matches your BUY orders against the stock-picker sources that suggested them —
// the daily Top-25 universe scans (via universe_top_daily) and Investing.com ProPicks,
// matched against each pick's actual live window (first_seen_at..removed_at) so a pick
// since removed from the current sync can still match an order placed while it was live
// — see externalRecsRepository.replaceStrategy.
//
// Matching uses a trailing window (WINDOW_DAYS, calendar days) rather than requiring the
// exact purchase day: an order counts as matched if the stock was Top-25 on the order date
// or any of the WINDOW_DAYS days before it. This is deliberately loose — it catches "saw it
// Monday, bought Wednesday" and (for now) the fact that Midcap/Smallcap/Microcap scanning
// only has a couple of days of history, so an exact-day match would leave almost everything
// pre-dating that history untagged. Widen/narrow via WINDOW_DAYS below.
const { openDatabase, allAsync, getAsync, closeAsync } = require('../../db/connection');
const { resolveNseSymbol, getCurrentHoldingSymbols } = require('../portfolio/portfolioService');
const nseService = require('../market/nseService');
const { isFno: _isFno } = require('../../utils/tradeClassification');
const { round2, round1Pct } = require('../../utils/rounding');
const { LATEST_SCAN_GLOBAL, LATEST_SCAN_BY_UNIVERSE } = require('../../repositories/universeScoresLatestScan');

const WINDOW_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
function _daysBetween(a, b) { return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / DAY_MS); }

const TOP25_UNIVERSES = [
  { key: 'NIFTY500', label: 'Nifty 500 Top 25',      icon: '🏆' },
  { key: 'MIDCAP',   label: 'Nifty Midcap 150 Top 25',   icon: '🥈' },
  { key: 'SMALLCAP', label: 'Nifty Smallcap 250 Top 25', icon: '🥉' },
  { key: 'MICROCAP', label: 'Nifty Microcap 250 Top 25', icon: '🔬' },
];

// Exclusive category assignment for an order's matched sources — strict priority order:
//
//   1) ProPicks (any strategy)
//   2) TechCheck by Niti
//   3) Top-25 universes, in cap-size order: Nifty 500 > Midcap 150 > Smallcap 250 >
//      Microcap 250 (TOP25_UNIVERSES' own order, no rank tie-break — a Nifty 500 match wins
//      over Midcap even at a worse rank).
//
// The ordering is deliberate rather than alphabetical or by performance: the first two are
// named calls on a specific stock, while a Top-25 entry only says the stock screened well that
// day. When a buy matches both, the named call is the better explanation of why it was bought,
// so it gets the credit — and the Top-25 bucket stops absorbing trades it did not prompt.
//
// Returns null if the order matched nothing.
const SOURCE_PRIORITY = ['propicks', 'techcheck', 'top25'];

function pickPrimarySource(sources) {
  if (!sources.length) return null;
  for (const type of SOURCE_PRIORITY) {
    if (type === 'top25') {
      // Only this tier has sub-ranking; the others are one bucket each.
      for (const { key } of TOP25_UNIVERSES) {
        const hit = sources.find((s) => s.type === 'top25' && s.key === key);
        if (hit) return hit;
      }
      continue;
    }
    const hit = sources.find((s) => s.type === type);
    if (hit) return hit;
  }
  return null;
}

// Where each bucket sits in the header, left to right. Mirrors SOURCE_PRIORITY so the cards
// read in the same order the matcher applies, rather than by return — a list can look best
// simply because one holding in it ran, which says more about that holding than the list.
function sourceRank(key) {
  if (key === 'untagged') return 99;                       // always last: it is the leftovers
  if (String(key).startsWith('propicks:')) return 0;
  if (key === 'techcheck') return 1;
  const idx = TOP25_UNIVERSES.findIndex((u) => u.key === key);
  return idx >= 0 ? 2 + idx : 98;
}

// FIFO lot matching, per (portfolio, resolved NSE symbol) — same logic as the client's
// computeOpenLots (App.jsx), reimplemented here so the backend can tell which BUY orders
// are still part of a currently open position vs. long since sold and closed out.
// Returns Map<orderId, remainingQty> for orders that still have shares open (0/absent if
// fully consumed by later sells).
function _computeOpenLotRemaining(resolvedOrders) {
  const sorted = [...resolvedOrders].sort((a, b) =>
    (a.trade_date || '').localeCompare(b.trade_date || '') || (a.id - b.id));

  const lotsByKey = new Map();   // `${portfolio}::${nseSymbol}` -> [{id, qty}, ...] (FIFO order)
  for (const o of sorted) {
    const key = `${o.portfolio}::${o.nseSymbol}`;
    if (!lotsByKey.has(key)) lotsByKey.set(key, []);
    const lots = lotsByKey.get(key);
    const qty = Number(o.quantity || 0);
    const side = String(o.side || '').toUpperCase();

    if (side === 'BUY' || side === 'B') {
      lots.push({ id: o.id, qty });
    } else if (side === 'SELL' || side === 'S') {
      let remaining = qty;
      while (remaining > 0 && lots.length > 0) {
        if (lots[0].qty <= remaining) { remaining -= lots[0].qty; lots.shift(); }
        else { lots[0].qty -= remaining; remaining = 0; }
      }
    }
  }

  const remainingById = new Map();
  for (const lots of lotsByKey.values()) {
    for (const lot of lots) remainingById.set(lot.id, (remainingById.get(lot.id) || 0) + lot.qty);
  }
  return remainingById;
}

async function getPickerMatches({ from = '', portfolio = '' } = {}) {
  const db = openDatabase();
  try {
    // FIFO needs the FULL order history (every buy and sell, any date, any portfolio) to
    // correctly determine which buy lots are still open — `from`/`portfolio` are applied
    // afterward, as filters on the resulting open lots, not on what goes into the FIFO math.
    const allOrdersRaw = await allAsync(
      db,
      `SELECT id, trade_date, portfolio, symbol, side, quantity, price, exchange FROM orders`,
    );
    const equityOrdersRaw = allOrdersRaw.filter((o) => !_isFno(o));
    if (!equityOrdersRaw.length) return { orders: [], positions: [], summary: [] };

    const resolvedAll = equityOrdersRaw.map((o) => ({ ...o, nseSymbol: (resolveNseSymbol(o.symbol) || o.symbol).toUpperCase() }));

    // Two DIFFERENT broker codes for the same NSE symbol (e.g. a stale one-day 2022 lot
    // vs a fresh 2026 buy under a renamed code) both resolve into the same `nseSymbol` —
    // so FIFO must run per (portfolio, nseSymbol), not per raw broker symbol, otherwise a
    // long-closed lot under one broker code could wrongly look "open" once you buy the
    // same real stock again under a different code.
    const remainingQtyByOrderId = _computeOpenLotRemaining(resolvedAll);

    // Only surface orders that are still part of a CURRENTLY OPEN lot — a buy whose shares
    // were later sold (even if you re-bought the same stock since, possibly under a
    // different broker code) is done, and comparing its old price against today's price
    // would badly distort "return since buy" for that closed-out lot.
    let held = resolvedAll
      .filter((o) => String(o.side || '').toUpperCase() !== 'SELL' && String(o.side).toUpperCase() !== 'S')
      .map((o) => ({ ...o, quantity: remainingQtyByOrderId.get(o.id) || 0 }))
      .filter((o) => o.quantity > 0);

    // Cross-check against the broker-confirmed CURRENT holdings snapshot, not just the
    // orders-derived FIFO math above — real-world order histories don't always net
    // perfectly to zero for a fully-exited stock (partial-fill rounding, a corporate
    // action that wasn't logged as a sell, a stale broker-code mapping), which can leave
    // a phantom 1-2-share "open" lot that FIFO alone can't tell apart from a real position.
    // The snapshot is what the broker actually shows you own right now, so it's the
    // deciding vote — EXCEPT for a buy dated after the snapshot itself, which hasn't had
    // a chance to appear there yet; those are trusted on FIFO alone rather than wrongly
    // dropped for being "missing" from a snapshot that predates them.
    const currentHoldingSymbols = await getCurrentHoldingSymbols();
    held = held.filter((o) => {
      const snap = currentHoldingSymbols[o.portfolio];
      if (!snap) return false;
      if (snap.symbols.includes(o.nseSymbol)) return true;
      return snap.asOf != null && o.trade_date > snap.asOf;
    });

    if (portfolio) held = held.filter((o) => o.portfolio === portfolio);
    if (from)      held = held.filter((o) => o.trade_date >= from);
    if (!held.length) return { orders: [], positions: [], summary: [] };

    const symbols = [...new Set(held.map((o) => o.nseSymbol))];
    // Widen the fetch window by WINDOW_DAYS so trailing-window matching has scan rows to look back at.
    const minDateRaw = held.reduce((m, o) => (o.trade_date < m ? o.trade_date : m), held[0].trade_date);
    const minDate = new Date(new Date(`${minDateRaw}T00:00:00Z`).getTime() - WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);

    // Top-25 scan rows across all 4 universes, for every symbol we bought — matched below via a
    // trailing window (see WINDOW_DAYS note at the top of the file) rather than an exact-day key.
    const placeholders = symbols.map(() => '?').join(',');
    const top25Rows = await allAsync(
      db,
      `SELECT universe, scan_date, rank, symbol
         FROM universe_top_daily
        WHERE symbol IN (${placeholders}) AND scan_date >= ? AND rank <= 25`,
      [...symbols, minDate],
    );
    const top25BySymbol = new Map();   // symbol -> [{universe, scan_date, rank}]
    for (const r of top25Rows) {
      const key = r.symbol.toUpperCase();
      if (!top25BySymbol.has(key)) top25BySymbol.set(key, []);
      top25BySymbol.get(key).push({ universe: r.universe, scanDate: r.scan_date, rank: r.rank });
    }
    // For an order, find the best (lowest-rank) Top-25 appearance per universe within the
    // trailing window [tradeDate - WINDOW_DAYS, tradeDate].
    function matchTop25(symbol, tradeDate) {
      const rows = top25BySymbol.get(symbol) || [];
      const inWindow = rows.filter((r) => {
        const d = _daysBetween(r.scanDate, tradeDate);   // >0 if scan was before the order
        return d >= 0 && d <= WINDOW_DAYS;
      });
      const byUniverse = new Map();
      for (const r of inWindow) {
        const cur = byUniverse.get(r.universe);
        if (!cur || r.rank < cur.rank) byUniverse.set(r.universe, r);
      }
      return [...byUniverse.values()];
    }

    // ProPicks — matched against the pick's actual live window (first_seen_at..removed_at,
    // or first_seen_at..now if still Added), not just "currently Added". The sync table
    // upserts per-symbol (see externalRecsRepository.replaceStrategy) so a stock dropped
    // from today's Added list still has its own row with the real dates it was live —
    // an order placed while it was live still matches, even after it's since been removed.
    // investing.com often links a pick via its BSE code, so the sync stores symbol=NULL for
    // those rows (company name only) — resolve those against the universe scans' name index,
    // same as externalRecsController.list() does for the ProPicks page's own rank display.
    const propicksRowsRaw = await allAsync(
      db,
      `SELECT symbol, company, strategy, action, as_of_date, price_added, first_seen_at, removed_at
         FROM external_recommendations`,
    );
    const norm = (s) => String(s || '').toUpperCase()
      .replace(/\b(LTD|LIMITED|CORPORATION|CORP|COMPANY|CO|INDIA|INDIAN|THE|AND|&)\b/g, '')
      .replace(/[^A-Z0-9]/g, '');
    const nameRows = await allAsync(db, `SELECT DISTINCT symbol, name FROM universe_scores`);
    const nameIndex = new Map();   // normalized company name -> NSE symbol
    for (const r of nameRows) { const k = norm(r.name); if (k && !nameIndex.has(k)) nameIndex.set(k, r.symbol.toUpperCase()); }
    const nameKeys = [...nameIndex.keys()];

    const propicksIndex = new Map();   // symbol -> [{strategy, as_of_date, price_added}]
    for (const r of propicksRowsRaw) {
      let key = r.symbol ? r.symbol.toUpperCase() : null;
      if (!key || !symbols.includes(key)) {
        const cn = norm(r.company);
        if (cn) {
          if (nameIndex.has(cn) && symbols.includes(nameIndex.get(cn))) key = nameIndex.get(cn);
          else { const hit = nameKeys.find((k) => cn.length >= 4 && (k.startsWith(cn) || cn.startsWith(k)) && k.length >= 4 && symbols.includes(nameIndex.get(k))); if (hit) key = nameIndex.get(hit); }
        }
      }
      if (!key || !symbols.includes(key)) continue;
      if (!propicksIndex.has(key)) propicksIndex.set(key, []);
      propicksIndex.get(key).push({
        strategy: r.strategy, asOfDate: r.as_of_date, priceAdded: r.price_added, action: r.action,
        firstSeenAt: r.first_seen_at, removedAt: r.removed_at,
      });
    }

    // A currently-Added pick always matches (same as before — we don't know when your
    // specific buy happened relative to when the strategy first flagged it, so any buy of
    // a stock the strategy currently likes counts). A Removed pick only matches if your
    // buy date actually fell inside its live window (first_seen_at..removed_at, with a
    // WINDOW_DAYS grace either side) — this is what lets a pick since dropped from today's
    // sync still credit an order placed while it was live, instead of going untagged.
    function matchPropicks(symbol, tradeDate) {
      const rows = propicksIndex.get(symbol) || [];
      return rows.filter((p) => {
        if (p.action !== 'Removed') return true;
        if (!p.firstSeenAt || !p.removedAt) return true;   // no dated history — don't drop a real match
        const firstSeenDate = p.firstSeenAt.slice(0, 10);
        const removedDate = p.removedAt.slice(0, 10);
        if (_daysBetween(firstSeenDate, tradeDate) < -WINDOW_DAYS) return false;
        if (_daysBetween(removedDate, tradeDate) > WINDOW_DAYS) return false;
        return true;
      });
    }

    // ── TechCheck by Niti ────────────────────────────────────────────────────
    // Named calls pasted from the advisor's chat, each with an advice date and — once the
    // target or stop is reached — a close date. Matched on the same principle as ProPicks:
    // the call's LIVE WINDOW, advised_on..closed_at, with the usual grace either side. A buy
    // made while the call was running counts; one made after the target already hit does not,
    // because the call was over by then and did not prompt it.
    //
    // Price is deliberately not part of the test. The advice names an entry ("Adding cmp
    // 4650") but treating that as a threshold would silently drop buys filled a little higher,
    // which is normal execution rather than ignoring the call. Membership is the question
    // here, exactly as it is for the other two sources.
    const techCheckRowsRaw = await allAsync(
      db,
      `SELECT symbol, advised_on, action, status, outcome, closed_at, entry_low, stop_level
         FROM equity_advice WHERE symbol IS NOT NULL`,
    );
    const techCheckIndex = new Map();
    for (const r of techCheckRowsRaw) {
      const key = String(r.symbol).toUpperCase();
      if (!symbols.includes(key)) continue;
      if (!techCheckIndex.has(key)) techCheckIndex.set(key, []);
      techCheckIndex.get(key).push({
        advisedOn: r.advised_on, action: r.action, status: r.status,
        outcome: r.outcome, closedAt: r.closed_at,
        entryLow: r.entry_low, stopLevel: r.stop_level,
      });
    }

    function matchTechCheck(symbol, tradeDate) {
      const rows = techCheckIndex.get(symbol) || [];
      return rows.filter((a) => {
        if (!a.advisedOn) return false;
        // Buying before the call existed is not following it.
        if (_daysBetween(a.advisedOn, tradeDate) < -WINDOW_DAYS) return false;
        // Still open — anything from the advice date onward counts.
        if (!a.closedAt) return true;
        return _daysBetween(a.closedAt, tradeDate) <= WINDOW_DAYS;
      });
    }

    // Latest known price per symbol (most recent scan across any universe) — used to show a
    // rough "since this order" return, as a first cut toward comparing picker performance.
    const cmpRows = await allAsync(
      db,
      `SELECT symbol, cmp, scan_date FROM universe_scores u
        WHERE symbol IN (${placeholders})
          AND ${LATEST_SCAN_GLOBAL}`,
      symbols,
    );
    const cmpIndex = new Map(cmpRows.map((r) => [r.symbol.toUpperCase(), { cmp: r.cmp, asOf: r.scan_date }]));

    const matched = held.map((o) => {
      const top25 = matchTop25(o.nseSymbol, o.trade_date);
      const propicks = matchPropicks(o.nseSymbol, o.trade_date);
      const techCheck = matchTechCheck(o.nseSymbol, o.trade_date);
      // Prefer the broker snapshot's own live price (covers ETFs/commodities that never
      // appear in the equity universe scan, and is simply more current) — fall back to the
      // scan-table price only for a symbol the snapshot doesn't have yet (see the
      // post-snapshot-date buy exception above).
      const snapshotHolding = currentHoldingSymbols[o.portfolio]?.holdingsBySymbol?.[o.nseSymbol] || null;
      const cmpInfo = snapshotHolding
        ? { cmp: snapshotHolding.ltp, asOf: currentHoldingSymbols[o.portfolio].asOf }
        : (cmpIndex.get(o.nseSymbol) || null);
      const returnPct = cmpInfo?.cmp && o.price ? round1Pct((cmpInfo.cmp - o.price) / o.price) : null;
      const sources = [
        ...top25.map((t) => {
          const u = TOP25_UNIVERSES.find((x) => x.key === t.universe);
          const daysBefore = _daysBetween(t.scanDate, o.trade_date);
          const ageSuffix = daysBefore > 0 ? ` (${daysBefore}d earlier)` : '';
          return { type: 'top25', key: t.universe, label: `${u ? `${u.icon} ${u.label}` : `${t.universe} Top25`} #${t.rank}${ageSuffix}`, rank: t.rank };
        }),
        ...propicks.map((p) => ({
          type: 'propicks', key: `propicks:${p.strategy}`,
          label: `📊 ProPicks — ${p.strategy}${p.action === 'Removed' ? ' (removed)' : ''}`,
          asOfDate: p.asOfDate, action: p.action, firstSeenAt: p.firstSeenAt, removedAt: p.removedAt,
        })),
        ...techCheck.map((a) => ({
          type: 'techcheck', key: 'techcheck',
          // The label stays plain because it doubles as the SUMMARY CARD's title, and that card
          // aggregates every call from this advisor. DATAPATTNS alone matches two calls — one
          // that hit its target and one still running — so stamping either outcome on the
          // heading would describe the whole advisor by whichever call happened to match first.
          // The per-call outcome rides along in its own fields for the expanded row.
          label: '🧠 TechCheck by Niti',
          outcomeLabel: a.status === 'CLOSED' && a.outcome
            ? (a.outcome === 'TARGET_HIT' ? 'target hit' : 'stopped out')
            : 'open',
          advisedOn: a.advisedOn, status: a.status, outcome: a.outcome,
          closedAt: a.closedAt, entryLow: a.entryLow, stopLevel: a.stopLevel,
        })),
      ];
      return {
        id: o.id, tradeDate: o.trade_date, portfolio: o.portfolio,
        symbol: o.nseSymbol, brokerSymbol: o.symbol, quantity: o.quantity, price: o.price,
        invested: round2(o.quantity * o.price),
        cmp: cmpInfo?.cmp ?? null, cmpAsOf: cmpInfo?.asOf ?? null, returnPct,
        sources, tagged: sources.length > 0,
        primarySource: pickPrimarySource(sources),
      };
    });

    // Collapse individual buy orders into one POSITION per (portfolio, symbol) — the unit
    // the summary cards and the Untracked Holdings report actually show. Money figures
    // (invested/currentValue/pnl) come from the broker snapshot directly rather than being
    // summed from the individual orders above: order history isn't adjusted for stock
    // splits/bonuses, so an old pre-split buy price compared against today's post-split
    // price (or vice versa) can produce a wildly wrong return — the snapshot already
    // reflects whatever actually happened to the position, split or not.
    const positionsByKey = new Map();   // `${portfolio}::${symbol}` -> { ...group state }
    for (const o of matched) {
      const key = `${o.portfolio}::${o.symbol}`;
      if (!positionsByKey.has(key)) positionsByKey.set(key, { portfolio: o.portfolio, symbol: o.symbol, buys: [], sourcesByKey: new Map() });
      const g = positionsByKey.get(key);
      g.buys.push(o);
      for (const s of o.sources) if (!g.sourcesByKey.has(s.key)) g.sourcesByKey.set(s.key, s);
    }

    const positions = [...positionsByKey.values()].map((g) => {
      const buys = [...g.buys].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
      const earliest = buys[0];
      const sources = [...g.sourcesByKey.values()];
      const snapshotHolding = currentHoldingSymbols[g.portfolio]?.holdingsBySymbol?.[g.symbol] || null;

      let quantity, invested, currentValue, pnl, returnPct, cmp, cmpAsOf, priced;
      if (snapshotHolding) {
        quantity = snapshotHolding.quantity;
        invested = round2(snapshotHolding.invested);
        currentValue = round2(snapshotHolding.currentValue);
        pnl = round2(snapshotHolding.pnl);
        returnPct = invested > 0 ? round1Pct(pnl / invested) : null;
        cmp = snapshotHolding.ltp;
        cmpAsOf = currentHoldingSymbols[g.portfolio]?.asOf ?? null;
        priced = true;
      } else {
        // Bought after the snapshot was taken — no broker-confirmed figures yet, so fall
        // back to what we recorded ourselves (accurate for a brand-new position with no
        // split/bonus history to worry about).
        quantity = buys.reduce((s, b) => s + b.quantity, 0);
        invested = round2(buys.reduce((s, b) => s + b.invested, 0));
        const cmpInfo = cmpIndex.get(g.symbol) || null;
        cmp = cmpInfo?.cmp ?? null;
        cmpAsOf = cmpInfo?.asOf ?? null;
        priced = cmp != null;
        currentValue = priced ? round2(quantity * cmp) : null;
        pnl = priced ? round2(currentValue - invested) : null;
        returnPct = priced && invested > 0 ? round1Pct((currentValue - invested) / invested) : null;
      }

      return {
        portfolio: g.portfolio, symbol: g.symbol,
        quantity, invested, currentValue, pnl, returnPct, cmp, cmpAsOf, priced,
        tradeDate: earliest.tradeDate, tradeCount: buys.length,
        sources, tagged: sources.length > 0,
        // The category a position counts toward is decided across ALL its buys (not just
        // the earliest) — a stock you've held a while and later top-up-bought while it was
        // a live ProPicks strategy pick should show as ProPicks, not silently stay under
        // whatever list flagged the very first lot. A position is still one thing with one
        // P&L, so it can't be split across categories — priority order (ProPicks > Nifty
        // 500 > best-rank other) just picks ONE from the union of everything it ever matched.
        primarySource: pickPrimarySource(sources),
        buys: buys.map((b) => ({ id: b.id, tradeDate: b.tradeDate, quantity: b.quantity, price: b.price, invested: b.invested, sources: b.sources })),
      };
    });

    // Aggregate performance per picker category — each POSITION counts toward exactly ONE
    // category (its primarySource), so a stock is never double-counted across cards.
    const bySource = new Map();
    for (const p of positions) {
      const key   = p.primarySource ? p.primarySource.key   : 'untagged';
      const label = p.primarySource ? p.primarySource.label.replace(/ #\d+.*$/, '') : '🔍 Not from a tracked list';
      if (!bySource.has(key)) bySource.set(key, { key, label, trades: 0, invested: 0, investedPriced: 0, currentValue: 0, priced: 0, wins: 0 });
      const b = bySource.get(key);
      b.trades += p.tradeCount;
      b.invested += p.invested;
      if (p.priced) {
        b.investedPriced += p.invested;
        b.currentValue += p.currentValue;
        b.priced += 1;
        if (p.returnPct != null && p.returnPct > 0) b.wins += 1;
      }
    }
    const summary = [...bySource.values()]
      .map((b) => ({
        key: b.key, label: b.label, trades: b.trades, priced: b.priced, wins: b.wins,
        invested: round2(b.invested),
        // currentValue/pnlPct are computed over the PRICED subset only (apples-to-apples) —
        // mixing in unpriced positions' full invested amount with zero current value would
        // understate pnlPct for any category with F&O-adjacent or unscanned symbols.
        currentValue: b.priced ? round2(b.currentValue) : null,
        // Absolute ₹ gain/loss over the priced subset (same denominator as pnlPct above).
        pnlAmount: b.priced ? round2(b.currentValue - b.investedPriced) : null,
        pnlPct: b.priced && b.investedPriced ? round1Pct((b.currentValue - b.investedPriced) / b.investedPriced) : null,
        winRate: b.priced ? round1Pct(b.wins / b.priced) : null,
      }))
      // Priority order first (ProPicks, TechCheck, then Top-25 by cap size), and only within
      // the same bucket by return. Sorting purely by return put whichever list happened to
      // hold a runaway winner in front, which reads as "this list is best" when it usually
      // means "one stock in it ran".
      .sort((a, b) => {
        const d = sourceRank(a.key) - sourceRank(b.key);
        return d !== 0 ? d : (b.pnlPct ?? -Infinity) - (a.pnlPct ?? -Infinity);
      });

    return { orders: matched, positions, summary };
  } finally {
    await closeAsync(db);
  }
}

// On-demand technical detail for a single symbol, for the "Your Trades vs Recommendations"
// row expander: RSI + technical score per universe it's scanned in, its rank within each
// (computed on the fly from universe_scores — universe_top_daily only stores the Top-25,
// not full rank), and 200 EMA distance from a live momentum snapshot. Lazy — only called
// when a row is expanded, so it doesn't slow down the main table.
async function getSymbolTechnicals(rawSymbol) {
  const symbol = (resolveNseSymbol(rawSymbol) || rawSymbol).toUpperCase();
  const db = openDatabase();
  try {
    // Latest scan per universe this symbol appears in, plus its full rank within that
    // universe's latest scan (position by combined_score, not just Top-25) — computed via
    // correlated subqueries in one round trip instead of one rank query per universe.
    const latestRows = await allAsync(
      db,
      `SELECT universe, scan_date, rsi, technical_score, combined_score, ema_ladder, cmp,
              (SELECT COUNT(*) FROM universe_scores WHERE universe = u.universe AND scan_date = u.scan_date AND combined_score > u.combined_score) + 1 AS rnk,
              (SELECT COUNT(*) FROM universe_scores WHERE universe = u.universe AND scan_date = u.scan_date) AS total
         FROM universe_scores u
        WHERE symbol = ?
          AND ${LATEST_SCAN_BY_UNIVERSE}`,
      [symbol],
    );

    const ranks = latestRows.map((r) => ({
      universe: r.universe, scanDate: r.scan_date,
      rank: r.rnk, total: r.total,
    }));

    // Live 200 EMA — not stored in universe_scores, needs a price-history computation.
    // Tolerate failure (Yahoo/NSE flakiness) — the rest of the technicals still return.
    let ema200 = null, cmpVs200EmaPct = null, currentPrice = null, priceAsOf = null;
    try {
      const snap = await nseService.fetchMomentumSnapshot(symbol);
      currentPrice = snap.currentPrice;
      priceAsOf = snap.asOf;
      ema200 = Number.isFinite(snap.ema200) ? snap.ema200 : null;
      cmpVs200EmaPct = (Number.isFinite(ema200) && ema200 && Number.isFinite(currentPrice))
        ? round1Pct((currentPrice - ema200) / ema200) : null;
    } catch (_e) { /* leave EMA fields null — RSI/rank below still work */ }

    return {
      symbol,
      byUniverse: latestRows.map((r) => ({
        universe: r.universe, scanDate: r.scan_date,
        rsi: r.rsi, technicalScore: r.technical_score, emaLadder: r.ema_ladder, cmp: r.cmp,
      })),
      ranks,
      currentPrice, priceAsOf, ema200, cmpVs200EmaPct,
    };
  } finally {
    await closeAsync(db);
  }
}

// Batch RSI lookup (latest scan, any universe) for a list of symbols — a single query,
// used to add "current RSI" to the Dashboard's Exit Candidates list without an N+1 fetch
// per stock. Pure DB read (RSI is already stored from the daily scanner), no live API calls.
async function getRsiBatch(rawSymbols) {
  const symbols = [...new Set((rawSymbols || []).map((s) => (resolveNseSymbol(s) || s).toUpperCase()))];
  if (!symbols.length) return {};
  const db = openDatabase();
  try {
    const placeholders = symbols.map(() => '?').join(',');
    const rows = await allAsync(
      db,
      `SELECT symbol, rsi, scan_date FROM universe_scores u
        WHERE symbol IN (${placeholders})
          AND ${LATEST_SCAN_GLOBAL}`,
      symbols,
    );
    const out = {};
    for (const r of rows) out[r.symbol.toUpperCase()] = { rsi: r.rsi, asOf: r.scan_date };
    return out;
  } finally {
    await closeAsync(db);
  }
}

// Current universe rank (per universe the symbol is scanned in) plus its rank ~1 week
// earlier, so the Dashboard's Exit Candidates list can show "current position, and
// how far it moved in the last week" without an N+1 fetch per stock. A stock is
// normally scanned in exactly one universe (NIFTY500 / MIDCAP / SMALLCAP / MICROCAP
// are mutually exclusive membership lists), so the per-symbol array is usually length 1.
async function getRankMovementBatch(rawSymbols) {
  const symbols = [...new Set((rawSymbols || []).map((s) => (resolveNseSymbol(s) || s).toUpperCase()))];
  if (!symbols.length) return {};
  const db = openDatabase();
  try {
    const placeholders = symbols.map(() => '?').join(',');
    const latestRows = await allAsync(
      db,
      `SELECT symbol, universe, scan_date, combined_score,
              (SELECT COUNT(*) FROM universe_scores WHERE universe = u.universe AND scan_date = u.scan_date AND combined_score > u.combined_score) + 1 AS rnk,
              (SELECT COUNT(*) FROM universe_scores WHERE universe = u.universe AND scan_date = u.scan_date) AS total
         FROM universe_scores u
        WHERE symbol IN (${placeholders})
          AND ${LATEST_SCAN_BY_UNIVERSE}`,
      symbols,
    );
    if (!latestRows.length) return {};

    // Closest scan on/before 7 days before the overall latest scan, PER SYMBOL — daily
    // scans don't cover every calendar day, and which days a given symbol appears in
    // varies (universe membership/coverage gaps), so "the universe's closest date" can
    // still miss for an individual symbol. Anchoring to each symbol's own scan history
    // avoids that.
    const anchor = await getAsync(db, `SELECT MAX(scan_date) AS d FROM universe_scores`);
    const histRows = anchor?.d
      ? await allAsync(
          db,
          `SELECT symbol, universe, scan_date,
                  (SELECT COUNT(*) FROM universe_scores WHERE universe = u.universe AND scan_date = u.scan_date AND combined_score > u.combined_score) + 1 AS rnk,
                  (SELECT COUNT(*) FROM universe_scores WHERE universe = u.universe AND scan_date = u.scan_date) AS total
             FROM universe_scores u
            WHERE symbol IN (${placeholders})
              AND scan_date = (
                SELECT MAX(scan_date) FROM universe_scores
                 WHERE symbol = u.symbol AND universe = u.universe AND scan_date <= date(?, '-6 days')
              )`,
          [...symbols, anchor.d],
        )
      : [];
    const histMap = new Map(histRows.map((r) => [`${r.symbol.toUpperCase()}|${r.universe}`, r]));

    const out = {};
    for (const r of latestRows) {
      const sym = r.symbol.toUpperCase();
      const hist = histMap.get(`${sym}|${r.universe}`);
      if (!out[sym]) out[sym] = [];
      out[sym].push({
        universe: r.universe,
        currentRank: r.rnk, currentTotal: r.total, scanDate: r.scan_date,
        weekAgoRank: hist?.rnk ?? null, weekAgoTotal: hist?.total ?? null, weekAgoScanDate: hist?.scan_date ?? null,
        // Positive = rank number went up = moved DOWN the list (worse). Negative = improved.
        rankChange: hist ? (r.rnk - hist.rnk) : null,
      });
    }
    return out;
  } finally {
    await closeAsync(db);
  }
}

module.exports = { getPickerMatches, getSymbolTechnicals, getRsiBatch, getRankMovementBatch };
