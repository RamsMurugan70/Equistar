const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// THIS PARTICIPANT'S OWN KEYS, held in module memory.
//
// They used to be environment variables, which is right for one developer and wrong for
// twenty-five participants with twenty-five ICICI developer apps of their own. They now come
// from this participant's encrypted database.
//
// Cached in a module variable because makeAuthHeaders() and getLoginUrl() are synchronous and
// run on every request; making them async would ripple through the whole service for no benefit,
// since this process serves exactly one person and their keys change only when they save new
// ones. refreshCredentials() runs at startup and after every save.
const credentials = require('../brokers/credentialsService');

let creds = { apiKey: '', apiSecret: '' };

async function refreshCredentials() {
  const c = await credentials.get('icicidirect').catch(() => null);
  creds = { apiKey: c?.apiKey || '', apiSecret: c?.apiSecret || '' };
  return { configured: !!creds.apiKey };
}

// Fire-and-forget at load. A participant who has not set their keys yet simply has none, and
// every path below reports that as "not configured" rather than failing obscurely.
refreshCredentials().catch(() => {});
const BASE_HOST  = 'api.icicidirect.com';
const BASE_PATH  = '/breezeapi/api/v1';

// Persist the daily session so server restarts don't force a re-login
// PER-INSTANCE, NOT PER-INSTALLATION. This used to resolve to one file under the app directory,
// which on a shared server means every participant reads and writes the same broker session — the
// first person to connect would hand their live trading session to all twenty-five. It now sits
// beside that participant's own database, in a directory only their process is given.
const SESSION_DIR = process.env.INSTANCE_DATA_DIR
  || path.join(__dirname, '..', '..', '..', 'data');
const SESSION_FILE = path.join(SESSION_DIR, 'breeze_session.json');


// ── Session (persisted to disk, expires end of trading day) ───────────────────
let session = {
  apiSession:   null,   // numeric token from login redirect (?apisession=...)
  sessionKey:   null,   // base64 session_token returned by customerdetails (used for auth)
  userId:       null,
  loginAt:      null,
  expiresAt:    null,
};

function saveSession() {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session), 'utf8');
  } catch (_e) { /* non-fatal */ }
}

function loadSession() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (raw && raw.expiresAt && new Date() < new Date(raw.expiresAt)) {
      session = raw;
      console.log(`◇ Breeze session restored from disk (user ${session.userId}, expires ${session.expiresAt})`);
    }
  } catch (_e) { /* no saved session */ }
}

loadSession();

function sessionExpiry() {
  // Breeze sessions expire at end of trading day (11:59 PM IST)
  const exp = new Date();
  exp.setHours(23, 59, 0, 0);
  return exp.toISOString();
}

function isTokenValid() {
  if (!session.sessionKey) return false;
  if (!session.expiresAt)  return false;
  return new Date() < new Date(session.expiresAt);
}

// ── Breeze auth headers (authenticated endpoints) ─────────────────────────────
// Per Breeze contract:
//   time_stamp = ISO8601 UTC truncated to seconds + '.000Z'
//   checksum   = SHA256(time_stamp + JSON.stringify(body) + api_secret)
//   X-Checksum = "token " + checksum
//   X-SessionToken = base64 session_token returned by customerdetails
function makeAuthHeaders(body) {
  const payload   = JSON.stringify(body || {});
  const timeStamp = new Date().toISOString().slice(0, 19) + '.000Z';
  const checksum  = crypto
    .createHash('sha256')
    .update(timeStamp + payload + creds.apiSecret)
    .digest('hex');

  return {
    'Content-Type':   'application/json',
    'X-Checksum':     `token ${checksum}`,
    'X-Timestamp':    timeStamp,
    'X-AppKey':       creds.apiKey,
    'X-SessionToken': session.sessionKey || '',
  };
}

// ── Low-level HTTPS request helper ───────────────────────────────────────────
// Breeze uses GET requests WITH a JSON body for most endpoints.
function breezeRequest({ method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    headers = { ...headers };
    const bodyStr = body !== undefined ? JSON.stringify(body) : '';
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request(
      { hostname: BASE_HOST, path, method, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.Status !== 200) {
              reject(new Error(
                `Breeze API error: ${parsed.Error || parsed.Message || JSON.stringify(parsed)}`
              ));
            } else {
              resolve(parsed.Success);
            }
          } catch {
            reject(new Error(`Breeze parse error: ${data.slice(0, 300)}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

function getLoginUrl() {
  // Breeze wants the API key URL-encoded (NOT base64). Match Python quote_plus:
  // encodeURIComponent + the extra chars it leaves unescaped — e.g. ) → %29.
  const encoded = encodeURIComponent(creds.apiKey)
    .replace(/[()'!*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `https://api.icicidirect.com/apiuser/login?api_key=${encoded}`;
}

function getSessionStatus() {
  return {
    connected: isTokenValid(),
    loginAt:   session.loginAt,
    expiresAt: session.expiresAt,
    userId:    session.userId,
    hasApiKey: !!creds.apiKey,
  };
}

async function generateSession(apiSession) {
  // Re-read rather than trust the cache: the usual sequence is "save keys, then connect", and a
  // stale cache here would reject a key the participant had only just entered.
  await refreshCredentials();
  if (!creds.apiKey || !creds.apiSecret) {
    throw Object.assign(
      new Error('Add your ICICI Direct API key and secret on the Brokers page first.'),
      { code: 'NOT_CONFIGURED' });
  }

  // customerdetails is the bootstrap call: GET with a JSON body {SessionToken, AppKey},
  // PLAIN headers (no checksum). It returns the base64 session_token used thereafter.
  const data = await breezeRequest({
    method:  'GET',
    path:    `${BASE_PATH}/customerdetails`,
    headers: { 'Content-Type': 'application/json' },
    body:    { SessionToken: apiSession, AppKey: creds.apiKey },
  });

  const sessionKey = data?.session_token || data?.session_key || null;
  if (!sessionKey) {
    throw new Error(`Breeze customerdetails returned no session_token: ${JSON.stringify(data).slice(0, 200)}`);
  }

  session = {
    apiSession,
    sessionKey,
    userId:    data?.idirect_userid || data?.user_id || null,
    loginAt:   new Date().toISOString(),
    expiresAt: sessionExpiry(),
  };
  saveSession();
  // The desktop app also wrote this token into the Python engines' shared config file so its
  // options scripts could reuse it. That is removed here, and deliberately: the file lived in a
  // single installation directory, so on a shared server every participant's connect would
  // overwrite the last one's token — and the first symptom would be someone else's trades
  // failing, not a message anyone could act on. EquiStar ships no options engines, so nothing
  // needs the token outside this process.

  return {
    connected: true,
    loginAt:   session.loginAt,
    expiresAt: session.expiresAt,
    userId:    session.userId,
  };
}

const _num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

// Demat holdings: complete qty per stock (incl. pledged), but NO prices.
// Tries three variants because Breeze accounts behave differently:
//   1. empty body (default)
//   2. { isdemat: 'Y' }  — some account types need this flag
//   3. raw GET with no body at all (checksum still over '{}')
async function fetchDematHoldings() {
  const variants = [
    {},
    { isdemat: 'Y' },
  ];
  let lastErr;
  for (const body of variants) {
    try {
      const raw = await breezeRequest({
        method:  'GET',
        path:    `${BASE_PATH}/dematholdings`,
        headers: makeAuthHeaders(body),
        body,
      });
      if (raw && raw.length > 0) {
        console.log(`◇ Breeze dematholdings OK (body=${JSON.stringify(body)}): ${raw.length} rows`);
        return raw;
      }
      // Empty array is still valid (zero holdings) — return it
      console.log(`◇ Breeze dematholdings returned empty array (body=${JSON.stringify(body)})`);
      return raw || [];
    } catch (e) {
      console.log(`⚠ Breeze dematholdings (body=${JSON.stringify(body)}) failed: ${e.message}`);
      lastErr = e;
    }
  }
  throw lastErr;
}

// Portfolio holdings: carries average_price + current_market_price (per exchange).
async function fetchPortfolioHoldings(exchangeCode = 'NSE') {
  const body = { exchange_code: exchangeCode };
  try {
    const raw = await breezeRequest({
      method:  'GET',
      path:    `${BASE_PATH}/portfolioholdings`,
      headers: makeAuthHeaders(body),
      body,
    });
    return raw || [];
  } catch (e) {
    console.log(`⚠ Breeze portfolioholdings(${exchangeCode}) failed: ${e.message}`);
    return [];
  }
}

// Open F&O positions (weekly/monthly option-selling book): the portfoliopositions
// endpoint returns everything (equity BTST rows included), so filter to segment='fno'.
// Breeze's own `pnl` field comes back null for F&O rows, so compute it ourselves —
// SELL profits as premium decays (entry - ltp), BUY profits as it rises (ltp - entry).
const MONTH_NUM = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
function _parseBreezeExpiry(raw) {
  const m = String(raw || '').match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) return { day: null, mon: null, iso: null };
  return { day: parseInt(m[1], 10), mon: m[2], iso: `${m[3]}-${MONTH_NUM[m[2]] || '01'}-${m[1].padStart(2, '0')}` };
}
async function fetchFnoPositions() {
  const body = {};
  const raw = await breezeRequest({ method: 'GET', path: `${BASE_PATH}/portfoliopositions`, headers: makeAuthHeaders(body), body });
  const rows = (raw || []).filter((r) => String(r.segment || '').toLowerCase() === 'fno');

  return rows.map((r) => {
    const right = /call/i.test(r.right) ? 'CE' : /put/i.test(r.right) ? 'PE' : (r.right || '');
    const action = String(r.action || '').toUpperCase();
    const qty = _num(r.quantity);
    const entryPrice = _num(r.average_price);
    const ltp = _num(r.ltp);
    const { day, mon, iso } = _parseBreezeExpiry(r.expiry_date);
    const strike = r.strike_price != null ? Math.round(_num(r.strike_price)) : null;
    const label = (day && mon && strike != null && right)
      ? `${r.stock_code} ${String(day).padStart(2, '0')} ${mon} ${strike} ${right}` : (r.stock_code || '');
    const pnl = action === 'SELL' ? (entryPrice - ltp) * qty : (ltp - entryPrice) * qty;
    return {
      label, underlying: r.stock_code, exchange: r.exchange_code,
      expiryDate: iso, strike, right, action, quantity: qty,
      entryPrice, ltp, pnl: Math.round(pnl * 100) / 100,
      // Breeze keeps listing a contract in portfoliopositions after its expiry session
      // ends, until ICICI's settlement batch clears it — so a leg that has already
      // expired still reads as "open" here, with a stale mark-to-market P&L. Flagged
      // rather than dropped: callers decide whether to show it, and Position Watch still
      // needs the row to work out the settlement. (_expirySettled is only true after
      // 15:30 IST on expiry day, so a live position is never flagged mid-session.)
      expirySettled: _expirySettled(iso),
    };
  });
}

// Funds / limits. For this account the actual cash is tiny and `unallocated_balance`
// is the buying power generated by the pledged securities — i.e. the margin obtained
// from the pledge (value minus ICICI's haircut). Breeze exposes no field literally
// named "pledge margin", so we surface unallocated_balance as that figure.
async function fetchFunds() {
  const body = {};
  const raw = await breezeRequest({
    method:  'GET',
    path:    `${BASE_PATH}/funds`,
    headers: makeAuthHeaders(body),
    body,
  });
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

// Margin snapshot for a given exchange segment (NFO = F&O — the segment that matters
// for the Optix margin banner). `block_by_trade` is margin currently locked by open
// positions in that segment; `cash_limit` is the buying power available in it right now.
async function fetchMargin(exchangeCode = 'NFO') {
  const body = { exchange_code: exchangeCode };
  const raw = await breezeRequest({
    method:  'GET',
    path:    `${BASE_PATH}/margin`,
    headers: makeAuthHeaders(body),
    body,
  });
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

// Pledge + margin summary for the Optix margin banner: total value of pledged-for-margin
// holdings, the margin that pledge generates (Breeze unallocated_balance), and — for
// managing live trades — margin currently utilized by open F&O positions and what's
// still available to deploy. Live — needs a session.
//
// NOTE on the two "available margin" figures: `funds.unallocated_balance` (account-wide)
// and `margin(NFO).cash_limit` (F&O-segment-specific) do NOT match exactly on this account
// (~₹90K gap observed) — likely a margin-benefit/segment rule Breeze doesn't name in the
// API. We surface cash_limit as "Available Margin" since it's the F&O-segment figure that
// actually gates a new F&O order, but this is worth a one-time cross-check against ICICI's
// own margin/limits screen before fully trusting it for position sizing.
async function fetchPledgeSummary() {
  if (!isTokenValid()) return { connected: false };
  const [holdings, funds, margin] = await Promise.all([
    fetchHoldings().catch(() => []),
    fetchFunds().catch(() => ({})),
    fetchMargin('NFO').catch(() => ({})),
  ]);
  const pledged = holdings.filter((h) => h.pledged);
  const pledgedValue = pledged.reduce((s, h) => s + (h.curVal || 0), 0);
  return {
    connected:        true,
    pledgedCount:     pledged.length,
    pledgedValue:     Math.round(pledgedValue),
    marginFromPledge: Math.round(_num(funds.unallocated_balance)),
    cashBalance:      Math.round(_num(funds.total_bank_balance)),
    marginUtilized:   Math.round(_num(margin.block_by_trade)),
    marginAvailable:  Math.round(_num(margin.cash_limit)),
    // CONFIRMED (2026-07-23): margin(NFO/BFO).cash_limit and funds.unallocated_balance
    // do NOT match the "Current Limit" ICICI's own options order-entry screen shows
    // (₹56.79L from the API vs ₹21.26L on the ICICI UI — a ~2.5x gap, checked against
    // NSE/BSE/NFO/BFO exchange_code, none matched). Breeze's margin API appears to expose
    // a coarser buying-power figure that doesn't include whatever real-time exposure/VaR
    // haircut ICICI's own order screen applies. Do not treat marginAvailable as accurate
    // for trade sizing — flagged to the user, surfaced with a warning in the UI.
    marginAvailableUnreconciled: true,
    pledgedHoldings:  pledged.map((h) => ({ instrument: h.instrument, qty: h.qty, curVal: Math.round(h.curVal || 0) })),
    asOf:             new Date().toISOString(),
  };
}

async function fetchHoldings() {
  if (!isTokenValid()) {
    throw new Error('Breeze session expired or not connected. Please log in again.');
  }

  const [dematResult, portNse, portBse] = await Promise.all([
    fetchDematHoldings().catch((e) => {
      console.log(`⚠ Breeze dematholdings failed (${e.message}) — falling back to portfolioholdings`);
      return null;  // null signals fallback
    }),
    fetchPortfolioHoldings('NSE'),
    fetchPortfolioHoldings('BSE'),
  ]);

  const portAll = [...portNse, ...portBse];

  // Price + qty map by stock_code from portfolio holdings (avg cost + LTP, and the
  // FULL quantity incl. SAM-pledged shares — see the qty note below). A stock can
  // appear under both NSE and BSE with the same holding, so merge (keep the higher
  // qty and any non-zero price) instead of letting the last row overwrite.
  const priceMap = new Map();
  for (const p of portAll) {
    const code = p.stock_code || p.stock_code_name;
    if (!code) continue;
    const prev = priceMap.get(code);
    priceMap.set(code, {
      avgCost:  _num(p.average_price ?? p.avg_price ?? p.average_cost) || prev?.avgCost || 0,
      ltp:      _num(p.current_market_price ?? p.ltp ?? p.last_traded_price ?? p.current_price) || prev?.ltp || 0,
      qty:      Math.max(parseInt(p.quantity || p.total_quantity || 0, 10), prev?.qty || 0),
      exchange: prev?.exchange || p.exchange_code || 'NSE',
      isin:     p.isin_code || prev?.isin || '',
      dayChg:   _num(p.change_percentage) || prev?.dayChg || 0,
    });
  }

  // Primary source: demat holdings (has qty, no prices). Fall back to portfolio holdings
  // if the call failed outright.
  //
  // IMPORTANT: the demat endpoint has been observed to be flaky under load — on the same
  // account, back-to-back calls have returned 34 rows, then an HTML error page, then 40
  // rows, with the missing 6 being exactly the pledged-for-margin holdings (they don't
  // come back as qty-0 rows in that case, they're OMITTED entirely). So this can't just
  // rescue quantity on rows that exist (done above via priceMap) — it must also UNION in
  // any portfolioholdings symbol that's missing a demat row altogether, or a flaky demat
  // response silently drops pledged holdings from the saved snapshot.
  const dematCodes = new Set((dematResult || []).map((h) => h.stock_code || h.stock_code_name || h.isin_code).filter(Boolean));
  const portfolioOnly = portAll.filter((p) => {
    const code = p.stock_code || p.stock_code_name;
    return code && !dematCodes.has(code);
  });
  const source = dematResult ? [...dematResult, ...portfolioOnly] : portAll;

  // Deduplicate — portfolio returns one row per exchange per stock, and a portfolio-only
  // row could appear under both NSE and BSE.
  const seen = new Set();
  const rows = [];
  for (const h of source) {
    const code = h.stock_code || h.stock_code_name || h.isin_code || '';
    if (!code || seen.has(code)) continue;
    seen.add(code);
    rows.push(h);
  }

  return rows.map((h) => {
    const code = h.stock_code || h.stock_code_name || h.isin_code || '';
    const pr   = priceMap.get(code) || {};
    // Demat holdings EXCLUDE shares pledged for margin (SAM) — those come back as
    // quantity 0 even though you still own them (e.g. the gold/silver ETFs, and any
    // freshly-bought stock not yet settled into demat). The portfolioholdings feed
    // carries the full quantity (incl. SAM-pledged), so take the LARGER of the two:
    // regular stocks match; SAM-pledged / unsettled ones are rescued from
    // portfolioholdings instead of vanishing at qty 0.
    const dematQty = parseInt(h.quantity || h.demat_avail_quantity || h.total_quantity || 0, 10);
    const qty      = Math.max(dematQty, pr.qty || 0);
    // Pledged-for-margin (SAM): shares that are absent from the demat quantity (0) but
    // present in portfolioholdings — the gold/silver ETFs pledged for margin. Flag them
    // so the UI can tag them and the value still counts toward the portfolio total.
    const pledged  = dematQty === 0 && (pr.qty || 0) > 0;
    const avgCost = pr.avgCost || _num(h.average_price);
    const ltp     = pr.ltp     || _num(h.current_market_price || h.current_price);
    const invested = qty * avgCost;
    const curVal   = qty * ltp;
    return {
      instrument: code,
      exchange:   h.exchange_code || pr.exchange || 'NSE',
      isin:       h.isin_code || pr.isin || '',
      qty,
      avgCost,
      ltp,
      invested,
      curVal,
      pledged,
      pnl:    curVal - invested,
      dayChg: _num(h.change_percentage) || pr.dayChg || 0,
      netChg: avgCost > 0 ? ((ltp - avgCost) / avgCost) * 100 : 0,
    };
  });
}

// Normalise Breeze date strings (ISO or 'DD-Mon-YYYY ...') to YYYY-MM-DD
function _toYMD(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (m) {
    const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
                     jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
    const mm = months[m[2].toLowerCase()];
    if (mm) return `${m[3]}-${mm}-${m[1].padStart(2, '0')}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function _toBreezeDate(ymd) {
  return `${ymd}T00:00:00.000Z`;
}

const _MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function _ddMon(ymd) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-');
  const mi = Number(m) - 1;
  return (mi >= 0 && mi < 12) ? `${d}${_MON[mi]}${y.slice(2)}` : '';
}

// Map one raw Breeze trade row → normalised order. Enriches F&O legs with
// expiry / strike / right so options are identifiable (e.g. "NIFTY 09Jun26 23500 CE").
function _mapTrade(t, exchangeCode) {
  const qty   = Number(t.quantity || t.traded_quantity || 0);
  const exch  = t.exchange_code || exchangeCode;
  const isOpt = /option/i.test(t.product_type || '') || ['NFO', 'BFO'].includes(exch);
  const isFut = /future/i.test(t.product_type || '');

  // Breeze `average_cost` semantics differ by segment:
  //   • Cash       → TOTAL trade value (divide by qty for per-unit)
  //   • F&O (opt/fut) → already PER-UNIT execution price (use as-is)
  const avg = Number(t.average_cost || 0);
  const unitPrice = (isOpt || isFut)
    ? (avg > 0 ? avg : Number(t.ltp || 0))
    : (qty > 0 && avg > 0 ? avg / qty : Number(t.ltp || t.price || 0));

  let symbol = t.stock_code || t.symbol || '';
  if (isOpt && (t.strike_price || t.right)) {
    const r = /put/i.test(t.right || '') ? 'PE' : /call/i.test(t.right || '') ? 'CE' : String(t.right || '').toUpperCase();
    const expShort = _ddMon(_toYMD(t.expiry_date));
    const strike   = t.strike_price ? String(Number(t.strike_price)) : '';
    symbol = [t.stock_code || t.symbol, expShort, strike, r].filter(Boolean).join(' ');
  } else if (isFut) {
    symbol = [t.stock_code || t.symbol, _ddMon(_toYMD(t.expiry_date)), 'FUT'].filter(Boolean).join(' ');
  }

  // Charge fields ACTUALLY returned by Breeze /trades (verified against the raw response
  // 2026-08-05): `brokerage_amount` and `total_taxes`. There is NO `other_taxes` field.
  //
  // BUG FIXED 2026-08-05: this read `other_taxes || other_tax`, neither of which exists, so
  // every rupee of STT/exchange/GST/stamp was silently dropped for six months —
  // daily_brokerage held brokerage ONLY (stt, gst, exchange, stamp all exactly 0.00 across
  // the whole table) and the F&O P&L "Total Charges" tile was therefore never a total.
  // Verified recovery: 2026-07-16 BSESEN trade returns brokerage_amount 20, total_taxes 3.6.
  //
  // NOTE ON TIMING: taxes are not always populated on trade day — the same trade fetched on
  // 2026-08-05 shows total_taxes "0". They appear after settlement, so a same-day import
  // under-reports and a later re-import of that date is what fills it in.
  const otherTaxes = _num(t.total_taxes || t.other_taxes || t.other_tax || 0);
  const brokerage  = _num(t.brokerage   || t.brokerage_amount || 0);
  const stt        = _num(t.stt         || 0);

  // ZTA_DEBUG_CHARGES=1 dumps the raw key set of the FIRST trade seen in this process, once.
  // Added 2026-08-05 while diagnosing why daily_brokerage held brokerage only (STT/GST/
  // exchange always 0.00 across six months) and stopped entirely on 2026-07-16. If Breeze
  // ever starts returning charges under different names, this is how you find out.
  if (process.env.ZTA_DEBUG_CHARGES === '1' && !_mapTrade._dumped) {
    _mapTrade._dumped = true;
    console.log('◇ RAW Breeze trade keys:', Object.keys(t).join(', '));
    console.log('◇ RAW Breeze trade sample:', JSON.stringify(t).slice(0, 900));
  }

  return {
    trade_date: _toYMD(t.trade_date || t.order_date || t.exchange_trade_time || t.trade_time)
                || new Date().toISOString().slice(0, 10),
    // EXECUTION TIME, kept rather than collapsed into the date.
    //
    // Without it, same-day fills can only be ordered by database insert id — which is import
    // order, not trade order. A 0DTE short opened at 10:00 and bought back at 15:15 was
    // imported buy-first, so FIFO read the buy as opening a LONG and reported the round trip
    // with its side and entry/exit inverted. The P&L was right; the direction was not, on every
    // intraday round trip an option seller makes.
    trade_time: t.exchange_trade_time || t.trade_time || null,
    symbol,
    side:     String(t.action || t.transaction_type || '').toUpperCase().includes('SELL') ? 'SELL' : 'BUY',
    quantity: qty,
    price:    Math.round(unitPrice * 100) / 100,
    exchange: exch,
    product:  t.product_type || '',
    order_id: t.order_id || '',
    // Charges captured from raw Breeze response
    charges:  Math.round((brokerage + stt + otherTaxes) * 100) / 100,
    _raw_charges: { brokerage, stt, other_taxes: otherTaxes },
  };
}

// Executed trades (fills) for a date range on ONE exchange.
async function fetchOrders(fromYMD, toYMD, exchangeCode = 'NSE') {
  if (!isTokenValid()) {
    throw new Error('Breeze session expired or not connected. Please log in again.');
  }
  const body = {
    exchange_code: exchangeCode,
    from_date: _toBreezeDate(fromYMD),
    to_date:   _toBreezeDate(toYMD),
  };
  const raw = await breezeRequest({
    method:  'GET',
    path:    `${BASE_PATH}/trades`,
    headers: makeAuthHeaders(body),
    body,
  });
  return (raw || []).map((t) => _mapTrade(t, exchangeCode)).filter((o) => o.symbol && o.quantity > 0);
}

// Executed trades across ALL segments (cash + F&O, NSE + BSE). F&O is on NFO/BFO,
// so a single-exchange query misses every options/futures fill.
async function fetchAllOrders(fromYMD, toYMD) {
  if (!isTokenValid()) {
    throw new Error('Breeze session expired or not connected. Please log in again.');
  }
  const exchanges = ['NSE', 'NFO', 'BSE', 'BFO'];
  const all = [];
  const errors = [];
  for (const ex of exchanges) {
    try {
      const part = await fetchOrders(fromYMD, toYMD, ex);
      all.push(...part);
    } catch (e) {
      errors.push(`${ex}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 350));   // Breeze rate-limit cushion
  }
  // Newest first
  all.sort((a, b) => (a.trade_date < b.trade_date ? 1 : a.trade_date > b.trade_date ? -1 : 0));
  if (errors.length) console.log('◇ Breeze fetchAllOrders partial errors:', errors.join(' | '));
  return all;
}

// ── Live index spot price ─────────────────────────────────────────────────────
const SPOT_CFG = {
  NIFTY:  { stock_code: 'NIFTY',  exchange_code: 'NSE', product_type: 'cash' },
  // Breeze REST API uses 'BSESN' for SENSEX (not 'BSESEN' used by Python SDK)
  SENSEX: { stock_code: 'BSESN',  exchange_code: 'BSE', product_type: 'cash' },
};

async function fetchSpot(index) {
  if (!isTokenValid()) throw new Error('Breeze session not connected');
  const cfg = SPOT_CFG[index];
  if (!cfg) throw new Error(`Unknown index: ${index}`);
  const body = { ...cfg };
  const raw = await breezeRequest({
    method:  'GET',
    path:    `${BASE_PATH}/quotes`,
    headers: makeAuthHeaders(body),
    body,
  });
  const row = Array.isArray(raw) ? raw[0] : raw;
  const ltp = parseFloat(row?.ltp || row?.last_rate || row?.ltp_rate || 0);
  if (!ltp) throw new Error(`No spot price returned for ${index} (got: ${JSON.stringify(row)})`);
  return ltp;
}

// ── Live option premium (LTP) ─────────────────────────────────────────────────
// Read-only quote — never places an order.
const OPT_CFG = {
  NIFTY:  { stock_code: 'NIFTY',  exchange_code: 'NFO' },
  SENSEX: { stock_code: 'BSESEN', exchange_code: 'BFO' },
};

function _breezeExpiry(ymd) {
  // 'YYYY-MM-DD' → Breeze ISO format
  return /T/.test(ymd) ? ymd : `${ymd}T06:00:00.000Z`;
}

// Full quote row for ONE option contract, for any underlying — not just the two indices in
// OPT_CFG. Returns Breeze's record as-is so callers can read fields (lot size, OI, bid/ask)
// that fetchOptionLtp deliberately discards.
// Strike as Breeze wants it. Math.round() was used here, which is correct for index options
// (whole-number strikes) but silently destroys stock strikes on a 2.5 ladder: POWERGRID lists
// 237.5, 242.5, 262.5 ... and Math.round(262.5) asks for 263, a contract that does not exist,
// so the quote comes back empty and the leg is reported "could not be quoted (expired or
// untradeable)" when it is in fact perfectly tradeable.
//
// Rounded to 2dp so float noise (262.49999999) cannot leak into the request. String() then
// formats each case correctly on its own: a whole strike goes out as "24000" (no trailing
// ".0") and a half strike as "262.5".
function _strikeParam(strike) {
  return String(Math.round(Number(strike) * 100) / 100);
}

async function fetchOptionQuote({ stockCode, exchangeCode = 'NFO', expiryYMD, strike, right }) {
  if (!isTokenValid()) throw new Error('Breeze session not connected');
  const body = {
    stock_code:    stockCode,
    exchange_code: exchangeCode,
    product_type:  'options',
    expiry_date:   _breezeExpiry(expiryYMD),
    right:         String(right).toUpperCase() === 'CE' ? 'call' : 'put',
    strike_price:  _strikeParam(strike),
  };
  const raw = await breezeRequest({
    method: 'GET', path: `${BASE_PATH}/quotes`,
    headers: makeAuthHeaders(body), body,
  });
  const rows = Array.isArray(raw) ? raw : [raw];
  return rows[0] || null;
}

async function fetchOptionLtp(index, expiryYMD, strike, optionType) {
  if (!isTokenValid()) throw new Error('Breeze session not connected');
  const cfg = OPT_CFG[index];
  if (!cfg) throw new Error(`Unknown index: ${index}`);
  const body = {
    stock_code:    cfg.stock_code,
    exchange_code: cfg.exchange_code,
    product_type:  'options',
    expiry_date:   _breezeExpiry(expiryYMD),
    right:         optionType.toUpperCase() === 'CE' ? 'call' : 'put',
    strike_price:  _strikeParam(strike),
  };
  const raw = await breezeRequest({
    method:  'GET',
    path:    `${BASE_PATH}/quotes`,
    headers: makeAuthHeaders(body),
    body,
  });
  const rows = Array.isArray(raw) ? raw : [raw];
  // Prefer a row with a real traded price (Breeze sometimes returns a 0 placeholder)
  for (const r of rows) {
    const ltp = parseFloat(r?.ltp ?? r?.last_rate ?? r?.last ?? 0);
    if (ltp > 0) return ltp;
  }
  return null;
}

// ── Live equity LTP ───────────────────────────────────────────────────────────
async function fetchEquityLtp(symbol, exchange = 'NSE') {
  if (!isTokenValid()) throw new Error('Breeze session not connected');
  const body = {
    stock_code:    symbol.toUpperCase(),
    exchange_code: exchange.toUpperCase(),
    product_type:  'cash',
  };
  const raw = await breezeRequest({
    method:  'GET',
    path:    `${BASE_PATH}/quotes`,
    headers: makeAuthHeaders(body),
    body,
  });
  const row = Array.isArray(raw) ? raw[0] : raw;
  const ltp = parseFloat(row?.ltp || row?.last_rate || row?.ltp_rate || 0);
  return ltp > 0 ? ltp : null;
}

function revokeToken() {
  session = { apiSession: null, sessionKey: null, userId: null, loginAt: null, expiresAt: null };
  try { fs.unlinkSync(SESSION_FILE); } catch (_e) { /* already gone */ }
  return { connected: false };
}

// ── Position watch: is a sold option still open, or has it been squared off? ──
// ICICI's GTT (stop-loss/target) orders are set on ICICI's own app/web, not through
// this app or the Breeze API — Breeze has no endpoint that shows a GTT order's
// armed/triggered state directly. What Breeze CAN see is the EFFECT: once a GTT
// fires, it becomes a real executed trade, so a squared-off position shows up as a
// same-day opposite-side (BUY) fill against the original SELL. This derives
// open/partial/squared-off status purely from today's trades + the live open
// positions feed — no new persistence needed, since this strategy is 0DTE/1DTE and
// never held overnight (see nifty_recommendation.py's own "square off same day"
// discipline).
function _fnoPositionKey(underlying, expiryDate, strike, right) {
  return `${underlying}|${expiryDate}|${strike}|${right}`;
}

// Today's executed F&O fills (NFO + BFO), with structured expiry/strike/right kept
// separate (not baked into a display string) so they can be matched against
// fetchFnoPositions() by (underlying, expiry, strike, right) rather than by label
// text, which the two endpoints format slightly differently.
async function _fetchFnoTradesToday() {
  if (!isTokenValid()) throw new Error('Breeze session expired or not connected. Please log in again.');
  const today = new Date().toISOString().slice(0, 10);
  const body = { from_date: _toBreezeDate(today), to_date: _toBreezeDate(today) };
  const trades = [];
  for (const exchangeCode of ['NFO', 'BFO']) {
    try {
      const raw = await breezeRequest({
        method: 'GET', path: `${BASE_PATH}/trades`,
        headers: makeAuthHeaders({ ...body, exchange_code: exchangeCode }),
        body: { ...body, exchange_code: exchangeCode },
      });
      for (const t of (raw || [])) {
        const qty = Number(t.quantity || t.traded_quantity || 0);
        if (!qty) continue;
        const right = /put/i.test(t.right || '') ? 'PE' : /call/i.test(t.right || '') ? 'CE' : String(t.right || '').toUpperCase();
        const { iso: expiryDate } = _parseBreezeExpiry(t.expiry_date) || {};
        const strike = t.strike_price != null ? Math.round(_num(t.strike_price)) : null;
        trades.push({
          underlying: t.stock_code || '',
          expiryDate: expiryDate || _toYMD(t.expiry_date) || null,
          strike, right,
          action: String(t.action || t.transaction_type || '').toUpperCase().includes('SELL') ? 'SELL' : 'BUY',
          quantity: qty,
          price: _num(t.average_cost) || _num(t.ltp) || 0,
          tradeTime: t.exchange_trade_time || t.trade_time || t.trade_date || null,
          orderId: t.order_id || '',
        });
      }
    } catch (e) {
      console.log(`⚠ Breeze trades(${exchangeCode}) for position watch failed: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 350));   // Breeze rate-limit cushion
  }
  return trades;
}

// ── Expiry settlement helpers ─────────────────────────────────────────────────
// Breeze has NO auto-square-off / order-status field — verified 2026-08-06 against the raw
// /trades payload, whose entire key set is: book_type, trade_date, stock_code, action,
// quantity, average_cost, brokerage_amount, product_type, exchange_code, order_id, segment,
// settlement_code, dp_id, client_id, ltp, eatm_withheld_amount, cash_withheld_amount,
// total_taxes, order_type, expiry_date, right, strike_price. (`order_type` is Market/Limit,
// not a square-off marker.) So the exit reason has to be INFERRED:
//   • a matching BUY fill exists      → bought back (broker auto-square-off or manual)
//   • no BUY, position gone, expiry passed → expired at settlement
// Those two are NOT the same outcome and must not share a P&L formula, hence the split below.
//
// Date.now() is UTC epoch ms and machine-timezone independent, so IST is simply +330 min and
// every getUTC* read then yields IST. Do NOT also add getTimezoneOffset() — that double-
// shifts on an IST machine (the bug documented in positionMonitorService.istNow).
const MARKET_CLOSE_HM = 1530;
function _istNow()   { return new Date(Date.now() + 330 * 60000); }
function _istToday() { return _istNow().toISOString().slice(0, 10); }
function _istHM()    { const d = _istNow(); return d.getUTCHours() * 100 + d.getUTCMinutes(); }

// An expiry only counts as settled once its session is actually over — on expiry day itself
// that means after 15:30 IST, so a still-live position isn't prematurely called "expired".
function _expirySettled(expiryDate) {
  if (!expiryDate) return false;
  const today = _istToday();
  if (expiryDate < today) return true;
  if (expiryDate > today) return false;
  return _istHM() >= MARKET_CLOSE_HM;
}

// Index options are CASH SETTLED at intrinsic value. A short that expires OTM keeps the full
// premium; one that expires ITM is settled against you at intrinsic and can be a large loss.
// Treating every expiry as "premium kept in full" would silently invent profit on an ITM
// short, so moneyness is resolved from spot before any expiry P&L is reported.
function _intrinsic(right, strike, spot) {
  if (spot == null || strike == null) return null;
  return right === 'PE' ? Math.max(0, strike - spot) : Math.max(0, spot - strike);
}

const _SPOT_INDEX_BY_UNDERLYING = { BSESEN: 'SENSEX', BSESN: 'SENSEX', NIFTY: 'NIFTY' };
const _YF_TICKER = { NIFTY: '%5ENSEI', SENSEX: '%5EBSESN' };

// Settlement is decided by the underlying's CLOSE ON THE EXPIRY DATE — not by live spot,
// which would be a different day's price whenever this is viewed after expiry day and would
// silently flip an OTM expiry to ITM (or back) as the market moves on. Yahoo's daily candles
// are keyed by date, so the right day can be picked out explicitly.
function _fetchYahooDailyCloses(index) {
  return new Promise((resolve) => {
    const ticker = _YF_TICKER[index];
    if (!ticker) { resolve(null); return; }
    const req = https.request(
      { hostname: 'query1.finance.yahoo.com',
        path: `/v8/finance/chart/${ticker}?range=3mo&interval=1d`,
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
            const map = new Map();
            ts.forEach((t, i) => {
              if (cl[i] == null) return;
              // +330 min → the IST calendar day this candle belongs to.
              map.set(new Date((t + 19800) * 1000).toISOString().slice(0, 10), cl[i]);
            });
            resolve(map.size ? map : null);
          } catch { resolve(null); }
        });
      });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function getPositionWatch() {
  if (!isTokenValid()) throw new Error('Breeze session expired or not connected. Please log in again.');
  const [openPositions, trades] = await Promise.all([
    fetchFnoPositions(),
    _fetchFnoTradesToday(),
  ]);

  const openMap = new Map();
  for (const p of openPositions) {
    if (p.action !== 'SELL' || !p.expiryDate || p.strike == null || !p.right) continue;
    openMap.set(_fnoPositionKey(p.underlying, p.expiryDate, p.strike, p.right), p);
  }

  const sellsByKey = new Map();
  const buysByKey = new Map();
  for (const t of trades) {
    if (!t.expiryDate || t.strike == null || !t.right) continue;
    const key = _fnoPositionKey(t.underlying, t.expiryDate, t.strike, t.right);
    const bucket = t.action === 'SELL' ? sellsByKey : buysByKey;
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push(t);
  }

  // The expiry-date close is only needed for shorts that reached expiry without a buyback —
  // resolved once per underlying, and only then, so a normal intraday watch does no extra work.
  const needCloseFor = new Set();
  for (const [key, sells] of sellsByKey) {
    const [underlying, expiryDate] = key.split('|');
    const soldQty = sells.reduce((s, t) => s + t.quantity, 0);
    const boughtQty = (buysByKey.get(key) || []).reduce((s, t) => s + t.quantity, 0);
    const stillOpen = openMap.get(key)?.quantity || 0;
    if (soldQty - boughtQty - stillOpen > 0 && _expirySettled(expiryDate)) needCloseFor.add(underlying);
  }
  const closesByUnderlying = new Map();   // underlying -> Map(dateYMD -> close)
  for (const underlying of needCloseFor) {
    const idx = _SPOT_INDEX_BY_UNDERLYING[String(underlying).toUpperCase()];
    if (!idx) continue;
    const closes = await _fetchYahooDailyCloses(idx);
    if (closes) closesByUnderlying.set(underlying, closes);
    else console.log(`⚠ expiry-date close for ${underlying} unavailable — settlement P&L withheld`);
  }
  // Resolve the close for a specific expiry; falls back to Breeze's live quote only when the
  // expiry is TODAY and the session has already closed (then LTP is that day's close anyway).
  const _closeOnExpiry = async (underlying, expiryDate) => {
    const hit = closesByUnderlying.get(underlying)?.get(expiryDate);
    if (hit != null) return hit;
    if (expiryDate !== _istToday()) return null;
    const idx = _SPOT_INDEX_BY_UNDERLYING[String(underlying).toUpperCase()];
    if (!idx) return null;
    try { return await fetchSpot(idx); } catch { return null; }
  };

  const positions = [];
  for (const [key, sells] of sellsByKey) {
    const soldQty = sells.reduce((s, t) => s + t.quantity, 0);
    const avgSellPrice = soldQty ? sells.reduce((s, t) => s + t.quantity * t.price, 0) / soldQty : null;
    const open = openMap.get(key) || null;
    const openQty = open ? open.quantity : 0;
    const buys = (buysByKey.get(key) || []).sort((a, b) => (a.tradeTime || '') < (b.tradeTime || '') ? -1 : 1);
    const squaredOffQty = buys.reduce((s, t) => s + t.quantity, 0);
    const avgBuyPrice = squaredOffQty ? buys.reduce((s, t) => s + t.quantity * t.price, 0) / squaredOffQty : null;
    const lastExitTime = buys.length ? buys[buys.length - 1].tradeTime : null;

    const [underlying, expiryDate, strikeStr, right] = key.split('|');
    const strike = Number(strikeStr);

    // Quantity that left the book WITHOUT a buyback fill — i.e. carried to expiry.
    const expiredQty = Math.max(0, soldQty - squaredOffQty - openQty);
    const settled = expiredQty > 0 && openQty === 0 && _expirySettled(expiryDate);
    const spot = settled ? await _closeOnExpiry(underlying, expiryDate) : null;
    const intrinsic = settled ? _intrinsic(right, strike, spot) : null;
    // OTM at expiry → worthless → full premium kept. ITM → cash-settled at intrinsic.
    const expiredWorthless = settled && intrinsic != null ? intrinsic === 0 : null;

    let status;
    if (openQty >= soldQty)  status = 'OPEN';
    else if (openQty > 0)    status = 'PARTIALLY_SQUARED_OFF';
    else if (settled)        status = expiredWorthless === false ? 'EXPIRED_ITM' : 'EXPIRED';
    else                     status = 'SQUARED_OFF';

    // Realized P&L has up to two independent legs: the part bought back, and the part left
    // to expire. They're summed only when each is actually knowable — an unresolved spot
    // leaves the expiry leg null rather than guessing a number.
    const buybackPnl = (squaredOffQty > 0 && avgSellPrice != null && avgBuyPrice != null)
      ? (avgSellPrice - avgBuyPrice) * squaredOffQty : null;
    const expiryPnl = settled && avgSellPrice != null && intrinsic != null
      ? (avgSellPrice - intrinsic) * expiredQty : null;

    let pnl;
    if (open) pnl = open.pnl;                                     // still live → mark-to-market
    else if (buybackPnl == null && expiryPnl == null) pnl = null;  // nothing resolvable yet
    else pnl = Math.round(((buybackPnl || 0) + (expiryPnl || 0)) * 100) / 100;

    positions.push({
      underlying, expiryDate, strike, right,
      label: `${underlying} ${expiryDate} ${strikeStr} ${right}`,
      status, soldQty, avgSellPrice: avgSellPrice != null ? Math.round(avgSellPrice * 100) / 100 : null,
      openQty, squaredOffQty,
      avgBuyPrice: avgBuyPrice != null ? Math.round(avgBuyPrice * 100) / 100 : null,
      lastExitTime,
      ltp: open ? open.ltp : null,
      pnl,
      // Expiry-settlement detail (null unless this position actually reached expiry) so the
      // UI can show WHY a position closed, not just that it did.
      expiredQty: settled ? expiredQty : 0,
      expirySpot: spot,
      expiryIntrinsic: intrinsic != null ? Math.round(intrinsic * 100) / 100 : null,
      expiredWorthless,
      expiryPnl: expiryPnl != null ? Math.round(expiryPnl * 100) / 100 : null,
      buybackPnl: buybackPnl != null ? Math.round(buybackPnl * 100) / 100 : null,
      // True when we know it expired but couldn't price the settlement (spot unavailable).
      expiryUnpriced: settled && intrinsic == null,
    });
  }

  const rank = (s) => (s === 'OPEN' ? 0 : s === 'PARTIALLY_SQUARED_OFF' ? 1 : 2);
  positions.sort((a, b) => rank(a.status) - rank(b.status));
  return { asOf: new Date().toISOString(), positions };
}

module.exports = {
  refreshCredentials,
  getLoginUrl,
  getSessionStatus,
  generateSession,
  fetchHoldings,
  fetchPledgeSummary,
  fetchOrders,
  fetchAllOrders,
  fetchSpot,
  fetchEquityLtp,
  fetchOptionLtp,
  fetchOptionQuote,
  fetchFnoPositions,
  getPositionWatch,
  revokeToken,
};
