// Corporate actions that RESCALE a share price — splits and bonuses.
//
// Extracted so every "compare an old price to today's price" calculation uses one
// implementation. Comparing a pre-split fill against a post-split quote invents a loss that
// never happened: a stock bought at ₹1,000 that later split 10:1 and trades at ₹110 did not
// fall 89%, it rose 10%. Any report that skips this silently produces confident nonsense on
// exactly the positions held longest.
const { openDatabase, allAsync, closeAsync } = require('../../db/connection');

// Multiply a PRE-action price by this to express it in POST-action terms.
function priceScaleFactor(actionType, subject) {
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
        factor: priceScaleFactor(r.action_type, r.subject),
      });
    }
    return map;
  } catch {
    return new Map();   // corporate_actions may not exist yet — guard is best-effort
  } finally {
    await closeAsync(db);
  }
}

// Combined factor to restate a price dated `onDate` in today's terms, plus whether any
// action could NOT be quantified. An unparseable action is reported rather than ignored:
// silently treating it as 1.0 would present a wrong number as a right one.
function adjustmentFor(actions, onDate) {
  const relevant = (actions || []).filter((a) => a.exDate && a.exDate > onDate);
  if (!relevant.length) return { factor: 1, blocked: false, actions: [] };
  let factor = 1;
  let blocked = false;
  for (const a of relevant) {
    if (a.factor == null) { blocked = true; continue; }
    factor *= a.factor;
  }
  return { factor, blocked, actions: relevant };
}

// "Dividend - Rs 10 Per Share" / "Re 0.60 Per Share" / "Distribution - Rs 2.50 Per Unit …"
// Returns rupees per share, or null when the amount is not stated in a form we can trust.
function dividendPerShare(subject) {
  const s = subject || '';
  const m = s.match(/R[se]\.?\s*([\d.]+)\s*(?:\/-\s*)?Per\s*(?:Share|Sh\b|Unit)/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// symbol → [{ exDate, amount }] — cash actually paid out, per share.
//
// WHY THIS MATTERS FOR TIMING ANALYSIS: a share price DROPS by roughly the dividend on the
// ex-date. Comparing raw prices therefore credits a seller for a fall that was really a payout
// — and penalises a holder for a drop whose cash they received. Both are backwards, so any
// honest before/after comparison has to work in total return, not price return.
async function dividendsBySymbol() {
  const db = openDatabase();
  try {
    const rows = await allAsync(db,
      `SELECT symbol, subject, ex_date FROM corporate_actions
        WHERE action_type = 'DIVIDEND' AND ex_date IS NOT NULL`);
    const map = new Map();
    for (const r of rows) {
      const amount = dividendPerShare(r.subject);
      if (amount == null) continue;
      const key = String(r.symbol || '').toUpperCase();
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ exDate: r.ex_date, amount });
    }
    return map;
  } catch {
    return new Map();
  } finally { await closeAsync(db); }
}

// Earliest ex-date on record. The table is populated going forward from when the sync was
// switched on, so anything before this date is NOT covered — and an unadjusted split shows a
// 10:1 stock as down 90%. Callers comparing old prices must say so rather than present
// adjusted and unadjusted periods as equally trustworthy.
async function coverageFrom() {
  const db = openDatabase();
  try {
    const r = await allAsync(db,
      `SELECT MIN(ex_date) AS earliest FROM corporate_actions
        WHERE action_type IN ('SPLIT','BONUS') AND ex_date IS NOT NULL`);
    return r?.[0]?.earliest || null;
  } catch {
    return null;
  } finally { await closeAsync(db); }
}

// Dividend records begin when the sync was switched on, same as splits. Reported separately
// because a period before this date is not "dividend-free", it is dividend-UNKNOWN.
async function dividendCoverageFrom() {
  const db = openDatabase();
  try {
    const r = await allAsync(db,
      `SELECT MIN(ex_date) AS earliest FROM corporate_actions
        WHERE action_type = 'DIVIDEND' AND ex_date IS NOT NULL`);
    return r?.[0]?.earliest || null;
  } catch {
    return null;
  } finally { await closeAsync(db); }
}

module.exports = {
  priceScaleFactor, priceScaleActionsBySymbol, adjustmentFor, coverageFrom,
  dividendPerShare, dividendsBySymbol, dividendCoverageFrom,
};
