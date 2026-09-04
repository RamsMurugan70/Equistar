// GARCH(1,1) conditional volatility for one stock, now and 1/3/6 months ago.
//
// WHY IT SHELLS OUT TO PYTHON. The fit is a constrained maximum-likelihood problem and scipy
// solves it properly; Node has no numerical optimiser here, and hand-rolling one for a
// three-parameter likelihood with a stationarity constraint is how you get a number that looks
// fine and is wrong. The quant code in this project already lives in Options_Data_Agent and the
// universe scanner already calls it the same way, so this follows the existing seam rather than
// inventing a second one.
//
// The spawn costs about a second, which is why the result is cached for 30 minutes - the same
// TTL nseService uses for its momentum snapshot, and far longer than a daily volatility figure
// needs to be fresh.
const path = require('path');
const { execFile } = require('child_process');
const nseService = require('./nseService');

const ENGINES = require('../../config/engines');
const SCRIPT = ENGINES.script('garch_vol.py');
const TTL_MS = 30 * 60 * 1000;

const cache = new Map();   // symbol -> { at, data }

function runPython(input) {
  return new Promise((resolve, reject) => {
    const child = execFile(ENGINES.python, [SCRIPT],
      { cwd: ENGINES.dir, timeout: 90000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.slice(-300) || err.message));
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error(`garch_vol.py returned unparseable output: ${stdout.slice(0, 200)}`)); }
      });
    child.stdin.end(JSON.stringify(input));
  });
}

// The change between two readings is expressed in VOLATILITY POINTS, not percent. Volatility is
// already a percentage, so "up 12%" would be ambiguous between 20->22.4 and 20->32. Points are
// unambiguous: 20 -> 32 is +12 points.
function delta(now, then) {
  if (now == null || then == null) return null;
  return Math.round((now - then) * 100) / 100;
}

async function getGarchVolatility(symbol) {
  const key = String(symbol || '').toUpperCase();
  if (!key) return null;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  let history;
  try {
    history = await nseService.fetchPriceHistory(key, '2y');
  } catch (e) {
    return { ok: false, reason: `no price history for ${key}` };
  }

  const points = (history.points || []).filter((p) => Number.isFinite(p.close));
  const closes = points.map((p) => p.close);
  const dates = points.map((p) => new Date(p.timestamp * 1000).toISOString().slice(0, 10));

  let raw;
  try {
    raw = await runPython({ closes, dates });
  } catch (e) {
    return { ok: false, reason: e.message.split('\n').pop().slice(0, 160) };
  }
  if (!raw?.ok) {
    const out = { ok: false, reason: raw?.reason || 'fit failed' };
    cache.set(key, { at: Date.now(), data: out });
    return out;
  }

  const p = raw.points || {};
  const now = p.now?.vol ?? null;
  const data = {
    ok: true,
    symbol: key,
    source: `${history.sourceSymbol} · ${raw.observations} daily returns`,
    vol: now,
    asOf: p.now?.asOf || null,
    longRunVol: raw.longRunVol,
    persistence: raw.persistence,
    params: raw.params,
    // Each period carries the reading THEN and the move since, so the header can show either
    // without the frontend re-deriving arithmetic the backend already did.
    changes: {
      m1: { was: p.m1?.vol ?? null, asOf: p.m1?.asOf || null, change: delta(now, p.m1?.vol) },
      m3: { was: p.m3?.vol ?? null, asOf: p.m3?.asOf || null, change: delta(now, p.m3?.vol) },
      m6: { was: p.m6?.vol ?? null, asOf: p.m6?.asOf || null, change: delta(now, p.m6?.vol) },
    },
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

module.exports = { getGarchVolatility };
