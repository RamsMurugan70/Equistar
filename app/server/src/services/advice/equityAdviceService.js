// Ingest + tracking for pasted equity tips.
//
// Tracking model, deliberately different from the options side: an equity tip is judged
// against three levels — entry, stop and target — so "how did this call do?" is answered by
// where the price went relative to those, not by a payoff curve.
//
// STOP ON A CLOSING BASIS: the advisor writes "Weak below 620 Clbs", meaning the stop
// triggers on a daily CLOSE below the level, not an intraday touch. Those are materially
// different — an intraday wick through 620 that closes at 640 is not a stop-out — so the
// closing-basis flag is honoured rather than flattened into a simple price comparison.
const https = require('https');
const repo = require('../../repositories/equityAdviceRepository');
const parser = require('./equityAdviceParser');
const symbolMaster = require('./symbolMasterService');

const DEFAULT_SOURCE = 'TechCheckByNiti';

async function ingestPaste({ text, source = DEFAULT_SOURCE, advisedOn = null }) {
  if (!text || !String(text).trim()) return { ok: false, reason: 'Nothing pasted' };

  const knownNames = await symbolMaster.getNameIndex();
  const parsed = parser.parsePaste(text, { knownNames });
  if (!parsed.length) return { ok: true, parsed: 0, saved: 0, tips: [] };

  const tips = [];
  let saved = 0;
  for (const p of parsed) {
    const res = await repo.saveAdvice({
      source,
      // The date parsed from the message itself wins. The paste-level date is only a
      // fallback, and today's date only if neither exists — a tip dated 04 June must not be
      // recorded as advised today, or every performance figure is measured from the wrong day.
      advisedOn: p.advisedOn || advisedOn || new Date().toISOString().slice(0, 10),
      symbol: p.symbol,
      stockText: p.stockText,
      matchedName: p.matchedName,
      action: p.action,
      entryLow: p.entryLow,
      entryHigh: p.entryHigh,
      stopLevel: p.stopLevel,
      stopClosingBasis: p.stopClosingBasis,
      targetLow: p.targetLow,
      targetHigh: p.targetHigh,
      targetOpenEnded: p.targetOpenEnded,
      rawText: p.raw,
      parsed: p,
      confidence: p.confidence,
    });
    if (res.inserted) saved += 1;
    tips.push({ ...p, id: res.id, inserted: res.inserted });
  }
  return { ok: true, source, parsed: parsed.length, saved, duplicates: parsed.length - saved, tips };
}

// Preview without saving — lets the UI show what was understood before anything is stored.
async function previewPaste(text) {
  const knownNames = await symbolMaster.getNameIndex();
  return { tips: parser.parsePaste(text, { knownNames }) };
}

// Latest close per symbol.
//
// Two sources, in order:
//   1. universe_scores — already local, but covers only the ~751 index constituents
//   2. Yahoo daily candles — everything else
//
// The fallback is essential, not a nicety: an advisor tips small companies precisely because
// they are off-index. The first real tip (Kusumgar) is not in any of the four scanned
// universes, so a scan-only lookup would leave every such call permanently unpriced.
//
// Daily CLOSES specifically, because the stop is defined on a closing basis — an intraday
// quote would fire stops on wicks that closed well above the level.
function yahooDailyClose(symbol) {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: 'query1.finance.yahoo.com',
        path: `/v8/finance/chart/${encodeURIComponent(symbol)}.NS?range=5d&interval=1d`,
        method: 'GET', timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const r = JSON.parse(body)?.chart?.result?.[0];
            const ts = r?.timestamp || [];
            const cl = r?.indicators?.quote?.[0]?.close || [];
            for (let i = cl.length - 1; i >= 0; i -= 1) {
              if (cl[i] != null) {
                return resolve({ price: Math.round(cl[i] * 100) / 100,
                                 asOf: new Date((ts[i] + 19800) * 1000).toISOString().slice(0, 10) });
              }
            }
            resolve(null);
          } catch { resolve(null); }
        });
      });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function latestCloses(symbols) {
  const { openDatabase, allAsync, closeAsync } = require('../../db/connection');
  const { LATEST_SCAN_GLOBAL } = require('../../repositories/universeScoresLatestScan');
  if (!symbols.length) return new Map();
  const out = new Map();

  const db = openDatabase();
  try {
    const rows = await allAsync(db,
      `SELECT symbol, cmp, scan_date FROM universe_scores u
        WHERE symbol IN (${symbols.map(() => '?').join(',')}) AND ${LATEST_SCAN_GLOBAL}`, symbols);
    for (const r of rows) {
      if (r.cmp != null) out.set(r.symbol.toUpperCase(), { price: r.cmp, asOf: r.scan_date, source: 'scan' });
    }
  } finally { await closeAsync(db); }

  for (const sym of symbols) {
    if (out.has(sym)) continue;
    const y = await yahooDailyClose(sym);
    if (y) out.set(sym, { ...y, source: 'yahoo' });
  }
  return out;
}

async function refreshTracking({ source = DEFAULT_SOURCE } = {}) {
  const rows = await repo.listAdvice({ source });
  const open = rows.filter((r) => r.status === 'OPEN' && r.symbol);
  const closes = await latestCloses([...new Set(open.map((r) => r.symbol.toUpperCase()))]);

  let updated = 0;
  let unpriced = 0;
  for (const r of open) {
    const px = closes.get(r.symbol.toUpperCase());
    if (!px || px.price == null) { unpriced += 1; continue; }

    // Target counts as reached at the LOW end of the range — that is when the advisor's call
    // has paid off; the upper bound and the trailing "+" are upside, not the bar.
    const targetLevel = r.target_low ?? r.target_high ?? null;
    const targetHit = targetLevel != null && px.price >= targetLevel;
    // Closing basis is satisfied by definition here because the scan price IS a close.
    const stopHit = r.stop_level != null && px.price < r.stop_level;

    await repo.applyPriceUpdate(r.id, { price: px.price, asOf: px.asOf, targetHit, stopHit });
    updated += 1;
  }
  return { source, checked: open.length, updated, unpriced };
}

// Shape each row for the UI, with return-since-advice computed against the stated entry.
async function listWithPerformance({ source = DEFAULT_SOURCE } = {}) {
  const rows = await repo.listAdvice({ source });
  const symbols = [...new Set(rows.filter((r) => r.symbol).map((r) => r.symbol.toUpperCase()))];
  const closes = await latestCloses(symbols);

  const tips = rows.map((r) => {
    const px = r.symbol ? closes.get(r.symbol.toUpperCase()) : null;
    const cmp = px?.price ?? r.last_px ?? null;
    const entry = r.entry_low ?? null;
    const retPct = entry > 0 && cmp != null ? Math.round(((cmp - entry) / entry) * 1000) / 10 : null;

    // Distance to the two decision levels, as percentages — the practical read on whether a
    // call is near its stop or close to paying out.
    const toStopPct = entry > 0 && r.stop_level != null && cmp != null
      ? Math.round(((cmp - r.stop_level) / cmp) * 1000) / 10 : null;
    const targetLevel = r.target_low ?? r.target_high ?? null;
    const toTargetPct = targetLevel != null && cmp != null
      ? Math.round(((targetLevel - cmp) / cmp) * 1000) / 10 : null;

    return {
      id: r.id,
      source: r.source,
      advisedOn: r.advised_on,
      symbol: r.symbol,
      stockText: r.stock_text,
      name: r.matched_name,
      action: r.action,
      entry,
      entryHigh: r.entry_high,
      stop: r.stop_level,
      stopClosingBasis: !!r.stop_closing,
      targetLow: r.target_low,
      targetHigh: r.target_high,
      targetOpenEnded: !!r.target_open,
      status: r.status,
      outcome: r.outcome,
      closedAt: r.closed_at,
      cmp,
      cmpAsOf: px?.asOf ?? r.last_px_at ?? null,
      returnPct: retPct,
      toStopPct,
      toTargetPct,
      targetHitAt: r.target_hit_at,
      targetHitPx: r.target_hit_px,
      stopHitAt: r.stop_hit_at,
      stopHitPx: r.stop_hit_px,
      confidence: r.confidence,
      rawText: r.raw_text,
      flags: safeJson(r.parsed_json, {})?.flags || [],
    };
  });

  const closed = tips.filter((t) => t.status === 'CLOSED');
  const wins = closed.filter((t) => t.outcome === 'TARGET_HIT').length;
  const losses = closed.filter((t) => t.outcome === 'STOP_HIT').length;
  const openTips = tips.filter((t) => t.status === 'OPEN');
  const openRets = openTips.map((t) => t.returnPct).filter((v) => v != null);

  return {
    tips,
    summary: {
      total: tips.length,
      open: openTips.length,
      closed: closed.length,
      targetHit: wins,
      stopHit: losses,
      // Withheld until enough calls resolve — a hit rate over two or three tips is noise.
      winRate: (wins + losses) >= 5 ? Math.round((wins / (wins + losses)) * 1000) / 10 : null,
      resolvedCount: wins + losses,
      avgOpenReturnPct: openRets.length
        ? Math.round((openRets.reduce((a, b) => a + b, 0) / openRets.length) * 10) / 10 : null,
      unresolvedSymbols: tips.filter((t) => !t.symbol).length,
    },
  };
}

function safeJson(s, f) { try { return JSON.parse(s); } catch { return f; } }

module.exports = {
  ingestPaste, previewPaste, refreshTracking, listWithPerformance, DEFAULT_SOURCE,
};
