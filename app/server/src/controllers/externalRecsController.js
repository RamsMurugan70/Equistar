const externalRecsRepository = require('../repositories/externalRecsRepository');
const portfolioRepository = require('../repositories/portfolioRepository');
const { resolveNseSymbol } = require('../services/portfolio/portfolioService');
const { openDatabase, allAsync, closeAsync } = require('../db/connection');
const { LATEST_SCAN_GLOBAL } = require('../repositories/universeScoresLatestScan');

// Latest known CMP per symbol (most recent scan across any universe) — used to show
// "change since recommended" against each pick's price-when-added. The scan_date comes
// back with it because that price is as-of the last scan, not necessarily today (no scan
// runs on weekends/holidays), and the UI has to say which date it's comparing against.
async function latestCmpBySymbol() {
  const db = openDatabase();
  try {
    const rows = await allAsync(db, `SELECT symbol, cmp, scan_date FROM universe_scores u WHERE ${LATEST_SCAN_GLOBAL}`);
    return new Map(rows.map((r) => [r.symbol.toUpperCase(), { cmp: r.cmp, asOf: r.scan_date }]));
  } finally {
    await closeAsync(db);
  }
}

// ── Split/bonus guard for "change since added" ────────────────────────────────
// price_added is captured on the pre-action price scale; cmp comes from a scan taken
// after it. A 1:10 split therefore looks like a -90% "move" unless the old price is
// rescaled first. Only SPLIT and BONUS mechanically rescale the price by a knowable
// ratio — dividends/rights/buybacks don't, so they're deliberately ignored here.
//
// Returns the factor the OLD price must be multiplied by to land on the post-action
// scale, or null when the ratio can't be read (caller then suppresses the number
// rather than showing a wrong one).
function _priceScaleFactor(actionType, subject) {
  const s = subject || '';
  if (actionType === 'SPLIT') {
    // "Face Value Split (Sub-Division) - From Rs 10/- Per Share To Re 1/- Per Share"
    const from = s.match(/From\s+R[se]\.?\s*([\d.]+)/i);
    const to   = s.match(/To\s+R[se]\.?\s*([\d.]+)/i);
    if (!from || !to) return null;
    const f = parseFloat(from[1]), t = parseFloat(to[1]);
    if (!(f > 0) || !(t > 0)) return null;
    return t / f;                       // FV 10 → 1 means price × 0.1
  }
  if (actionType === 'BONUS') {
    // "Bonus 2:5" = 2 new shares for every 5 held → 5 shares become 7, price × 5/7.
    const m = s.match(/(\d+)\s*:\s*(\d+)/);
    if (!m) return null;
    const issued = parseInt(m[1], 10), held = parseInt(m[2], 10);
    if (!(held > 0) || !(issued >= 0)) return null;
    return held / (issued + held);
  }
  return null;
}

// symbol → [{ actionType, subject, exDate, factor }] for the two rescaling action types.
async function priceScaleActionsBySymbol() {
  const db = openDatabase();
  try {
    const rows = await allAsync(db,
      `SELECT symbol, action_type, subject, ex_date FROM corporate_actions
        WHERE action_type IN ('SPLIT','BONUS') AND ex_date IS NOT NULL`);
    const map = new Map();
    for (const r of rows) {
      const key = String(r.symbol || '').toUpperCase();
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({
        actionType: r.action_type, subject: r.subject, exDate: r.ex_date,
        factor: _priceScaleFactor(r.action_type, r.subject),
      });
    }
    return map;
  } catch {
    return new Map();   // corporate_actions may not exist yet — guard is best-effort
  } finally {
    await closeAsync(db);
  }
}

// Build NSE-symbol → [portfolios] map from the latest snapshot per portfolio.
async function heldBySymbol() {
  const held = new Map();
  try {
    const snaps = await portfolioRepository.listPortfolioSnapshots('', 20);
    const seen = new Set();
    for (const s of snaps) {
      if (seen.has(s.portfolio)) continue;
      seen.add(s.portfolio);
      let payload;
      try { payload = JSON.parse(s.payload_json); } catch { continue; }
      for (const h of (payload?.portfolio || [])) {
        const raw = h.instrument || h.symbol || '';
        if (!raw) continue;
        const nse = (resolveNseSymbol(raw) || raw).toUpperCase();
        if (!held.has(nse)) held.set(nse, new Set());
        held.get(nse).add(s.portfolio);
      }
    }
  } catch { /* best-effort */ }
  return held;
}

async function ingest(req, res, next) {
  try {
    const { source, strategy, picks, asOfDate } = req.body || {};
    if (!source || !strategy || !Array.isArray(picks)) {
      return res.status(400).json({ error: 'source, strategy and picks[] are required' });
    }
    const result = await externalRecsRepository.replaceStrategy(source, strategy, picks, { asOfDate });
    res.json({ ok: true, strategy, ...result });
  } catch (e) { next(e); }
}

// Prefix shown next to each rank: NY = Nifty 500, MC = Midcap 150, SC = Smallcap 250, MI = Microcap 250.
const RANK_UNIVERSES = [
  { key: 'NIFTY500', prefix: 'NY' },
  { key: 'MIDCAP',   prefix: 'MC' },
  { key: 'SMALLCAP', prefix: 'SC' },
  { key: 'MICROCAP', prefix: 'MI' },
];

async function list(req, res, next) {
  try {
    const rows = await externalRecsRepository.listAll(req.query.source || '');
    // Enrich with the user's own rank in EVERY scanned universe + held tags (facts we generate).
    // Full rank (1..N by score, not trend-filtered) so every scanned stock shows its true
    // position — e.g. Wipro NY #401, not a blank — and a stock in 2 lists shows both.
    const universeScannerService = require('../services/universe/universeScannerService');
    const perUniverse = {};   // key -> { ranks, names }
    await Promise.all(RANK_UNIVERSES.map(async ({ key }) => {
      try { perUniverse[key] = await universeScannerService.getFullRankMap(key); }
      catch { perUniverse[key] = { ranks: {}, names: {} }; }
    }));
    const held = await heldBySymbol();
    const cmpBySymbol = await latestCmpBySymbol();
    const scaleActions = await priceScaleActionsBySymbol();

    const norm = (s) => String(s || '').toUpperCase()
      .replace(/\b(LTD|LIMITED|CORPORATION|CORP|COMPANY|CO|INDIA|INDIAN|THE|AND|&)\b/g, '')
      .replace(/[^A-Z0-9]/g, '');
    // Merged name index across all 4 universes — a company's NSE symbol is the
    // same regardless of which cap-size list it's in, so any universe can resolve it.
    const mergedNames = {};
    for (const { key } of RANK_UNIVERSES) Object.assign(mergedNames, perUniverse[key].names);
    const nameKeys = Object.keys(mergedNames);

    // investing.com often links NSE stocks via their BSE code (symbol=null), so
    // resolve those to the NSE symbol by company name against the scan universes.
    function resolveNse(pick) {
      if (pick.symbol) {
        const sym = pick.symbol.toUpperCase();
        if (RANK_UNIVERSES.some(({ key }) => perUniverse[key].ranks[sym] != null)) return sym;
      }
      const cn = norm(pick.company);
      if (cn) {
        if (mergedNames[cn]) return mergedNames[cn];
        const hit = nameKeys.find((k) => cn.length >= 4 && (k.startsWith(cn) || cn.startsWith(k)) && k.length >= 4);
        if (hit) return mergedNames[hit];
      }
      return pick.symbol ? pick.symbol.toUpperCase() : null;   // held-check even if unranked
    }

    const picks = rows.map((r) => {
      const sym = resolveNse(r);
      const heldBy = sym && held.has(sym) ? [...held.get(sym)] : [];
      const ranks = sym
        ? RANK_UNIVERSES
            .map(({ key, prefix }) => ({ universe: key, prefix, rank: perUniverse[key].ranks[sym] ?? null }))
            .filter((x) => x.rank != null)
        : [];
      // Change in the stock's own price since the strategy first flagged it — latest scan
      // price vs. price-when-added, regardless of whether the pick itself is still Added or
      // has since been Removed (the stock keeps moving either way). Guarded on price_added
      // being a positive number so a 0/null never yields a divide-by-zero Infinity.
      const cmpInfo = sym ? (cmpBySymbol.get(sym) ?? null) : null;
      const cmp = cmpInfo?.cmp ?? null;

      // Rescale price_added for any split/bonus that went ex between the day we first
      // recorded the pick and the scan cmp came from — otherwise a 1:10 split reads as a
      // -90% crash. NOTE: the window can only start at first_seen_at, since investing.com
      // doesn't tell us the date THEY added the pick; an action between their add date and
      // our first sync is undetectable. Harmless going forward (history starts at the
      // first sync), but it means a freshly-imported back-history isn't split-safe.
      const addedDay = (r.first_seen_at || r.captured_at || '').slice(0, 10);
      const actionsSinceAdded = (sym && addedDay && cmpInfo?.asOf
        ? (scaleActions.get(sym) || []).filter((a) => a.exDate > addedDay && a.exDate <= cmpInfo.asOf)
        : []);
      // An action we can see but can't parse means we KNOW the two prices are on different
      // scales but not by how much — suppress the number instead of publishing a wrong one.
      const unparsedAction = actionsSinceAdded.some((a) => a.factor == null);
      const scaleFactor = actionsSinceAdded.reduce((acc, a) => acc * (a.factor ?? 1), 1);
      const priceAddedAdjusted = Number(r.price_added) > 0 ? r.price_added * scaleFactor : null;

      const canCompare = cmp != null && priceAddedAdjusted > 0 && !unparsedAction;
      const changeSinceAdded = canCompare ? cmp - priceAddedAdjusted : null;
      const changeSinceAddedPct = canCompare ? ((cmp - priceAddedAdjusted) / priceAddedAdjusted) * 100 : null;
      return {
        id: r.id,
        strategy: r.strategy,
        symbol: r.symbol || sym,
        exchange: r.exchange,
        company: r.company,
        action: r.action,
        priceAdded: r.price_added,
        returnPct: r.return_pct,
        cmp,
        cmpAsOf: cmpInfo?.asOf ?? null,
        changeSinceAdded,
        changeSinceAddedPct,
        // Only set when a split/bonus actually landed in the window, so the UI can mark the
        // row as adjusted (or explain why the number is withheld).
        priceAddedAdjusted: actionsSinceAdded.length ? priceAddedAdjusted : null,
        corpActionsSinceAdded: actionsSinceAdded.map((a) => ({ type: a.actionType, subject: a.subject, exDate: a.exDate, factor: a.factor })),
        changeBlockedByCorpAction: unparsedAction,
        isLive: !!r.is_live,
        stockUrl: r.stock_url,
        asOfDate: r.as_of_date,
        capturedAt: r.captured_at,
        firstSeenAt: r.first_seen_at,
        removedAt: r.removed_at,
        ranks,   // e.g. [{universe:'NIFTY500', prefix:'NY', rank:458}, {universe:'MIDCAP', prefix:'MC', rank:12}]
        heldBy,
      };
    });

    // NEWEST capture across every row, not rows[0].
    //
    // Taking the first row made this the OLDEST pick of whichever strategy sorted first
    // alphabetically. Sync all four today and the header still read "synced 03 Aug, 31 days ago"
    // — a stale-data warning firing on data that was an hour old, which trains you to ignore it.
    const capturedAt = rows.reduce((max, r) => (r.captured_at > max ? r.captured_at : max), '')
      || null;

    // Per-strategy freshness is NOT sent separately — every pick already carries its own
    // captured_at, and the panel takes the max within each group. One source, no second field
    // to fall out of step with the first.
    const strategies = [...new Set(rows.map((r) => r.strategy))];
    res.json({ picks, strategies, capturedAt });
  } catch (e) { next(e); }
}

module.exports = { ingest, list };
