const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || window.location.origin;

async function request(path) {
  const response = await fetch(`${API_BASE_URL}${path}`);
  if (!response.ok) {
    // Use the server's own explanation rather than a bare status code. The backend returns a
    // JSON { error, ... } body for failures the user can act on — an expired Breeze session
    // above all, which recurs every midnight IST — and "Request failed: 500" discarded it,
    // leaving nothing on screen to distinguish "log in again" from a real crash.
    // Extra fields (sessionExpired, loginUrl) ride along on the thrown error.
    let body = null;
    try { body = await response.json(); } catch { /* non-JSON error body */ }
    const err = new Error(body?.error || `Request failed: ${response.status}`);
    err.status = response.status;
    if (body) Object.assign(err, body);
    throw err;
  }
  return response.json();
}

export function fetchDashboard() {
  return request('/api/dashboard/summary');
}

// How the equity books evolved over a window — money-weighted return, the same flows run into
// Nifty, and the holdings that drove it. Defaults to both portfolios combined.
export function fetchPortfolioEvolution({ period = '3M', portfolio = 'both' } = {}) {
  return request(`/api/performance/evolution?period=${encodeURIComponent(period)}`
    + `&portfolio=${encodeURIComponent(portfolio)}`);
}

export function fetchDashboardInsights() {
  return request('/api/dashboard/insights');
}

export async function refreshCorpActions() {
  const response = await fetch(`${API_BASE_URL}/api/dashboard/refresh-corp-actions`, { method: 'POST' });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

export function fetchLiveBreakdown() {
  return request('/api/portfolio/live-breakdown');
}

export function fetchCostBasisOverrides(portfolio = '') {
  const params = portfolio ? `?portfolio=${encodeURIComponent(portfolio)}` : '';
  return request(`/api/portfolio/cost-basis${params}`);
}

export async function importCostBasisOverrides({ portfolio, overrides }) {
  const response = await fetch(`${API_BASE_URL}/api/portfolio/cost-basis`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ portfolio, overrides }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

export async function deleteCostBasisOverride(portfolio, symbol) {
  const response = await fetch(`${API_BASE_URL}/api/portfolio/cost-basis/${encodeURIComponent(portfolio)}/${encodeURIComponent(symbol)}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error(`Delete failed: ${response.status}`);
  return response.json();
}

// ── Options Recommendations (Python subprocess engines) ──────────────────────
export async function runOptionsRecommendation({ index, mode, dryRun = false, lots = null }) {
  const response = await fetch(`${API_BASE_URL}/api/options/recommend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index, mode, dryRun, lots }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

export async function refreshOptionsData() {
  const response = await fetch(`${API_BASE_URL}/api/options/refresh-data`, { method: 'POST' });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

export function fetchOptionsLastRefresh() {
  return request('/api/options/last-refresh');
}

export function fetchOptionsHealth() {
  return request('/api/options/health');
}

export async function recaptureOptionStrikes() {
  const response = await fetch(`${API_BASE_URL}/api/options/recapture-strikes`, { method: 'POST' });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

export function fetchOptionsSpotStrikes() {
  return request('/api/options/spot-strikes');
}

export async function breezeSetSession(sessionToken) {
  const response = await fetch(`${API_BASE_URL}/api/breeze/generate-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionToken }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

export function fetchOrdersMeta() {
  return request('/api/orders/meta');
}

export async function importOrderDownloads() {
  const response = await fetch(`${API_BASE_URL}/api/orders/import-downloads`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

export function fetchSellEvaluatorOptions() {
  return request('/api/orders/sell-evaluator/options');
}

export function fetchSellEvaluatorDates() {
  return request('/api/orders/sell-evaluator/dates');
}

export function fetchSellEvaluation({ portfolio, symbol, saleDate }) {
  const params = new URLSearchParams();
  if (portfolio) params.set('portfolio', portfolio);
  if (symbol) params.set('symbol', symbol);
  if (saleDate) params.set('saleDate', saleDate);
  return request(`/api/orders/sell-evaluator?${params.toString()}`);
}

export function fetchBuyEvaluatorReport() {
  return request('/api/orders/buy-evaluator/report');
}

// segment: 'equity' | 'fno' | 'all' (default). Equix tracks equity; F&O lives in Optix.
export function fetchOrders({ portfolio = '', symbol = '', page = 1, pageSize = 25, segment = '' } = {}) {
  const params = new URLSearchParams();
  if (portfolio) params.set('portfolio', portfolio);
  if (symbol) params.set('symbol', symbol);
  if (segment) params.set('segment', segment);
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  return request(`/api/orders?${params.toString()}`);
}

export function fetchPortfolio(portfolio = '') {
  const params = new URLSearchParams();
  if (portfolio) params.set('portfolio', portfolio);
  return request(`/api/portfolio/overview?${params.toString()}`);
}

export function fetchAsOfReport({ portfolio = '', date = '' } = {}) {
  const params = new URLSearchParams();
  if (portfolio) params.set('portfolio', portfolio);
  if (date) params.set('date', date);
  return request(`/api/portfolio/as-of?${params.toString()}`);
}

export async function importPortfolioDownloads() {
  const response = await fetch(`${API_BASE_URL}/api/portfolio/import-downloads`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

export function fetchRecommendations() {
  return request('/api/recommendations');
}

export async function addRecommendation(payload) {
  const response = await fetch(`${API_BASE_URL}/api/recommendations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

export function fetchExitCandidates(windowDays = 30) {
  return request(`/api/recommendations/exit-candidates?window=${windowDays}`);
}

export function fetchHeldSymbols() {
  return request('/api/portfolio/held-symbols');
}

export function fetchHoldingPeriods() {
  return request('/api/portfolio/holding-periods');
}

export function fetchRsiBatch(symbols) {
  return request(`/api/recommendations/rsi-batch?symbols=${encodeURIComponent(symbols.join(','))}`);
}

export function fetchRankMovementBatch(symbols) {
  return request(`/api/recommendations/rank-movement-batch?symbols=${encodeURIComponent(symbols.join(','))}`);
}

export function fetchMatchedOrders({ symbol, rec_date }) {
  return request(`/api/recommendations/matched-orders?symbol=${encodeURIComponent(symbol)}&rec_date=${encodeURIComponent(rec_date)}`);
}

export function fetchPickerMatches({ from = '', portfolio = '' } = {}) {
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (portfolio) q.set('portfolio', portfolio);
  return request(`/api/recommendations/picker-matches${q.toString() ? `?${q}` : ''}`);
}

export function fetchSymbolTechnicals(symbol) {
  return request(`/api/recommendations/symbol-technicals?symbol=${encodeURIComponent(symbol)}`);
}

export function fetchSymbol52wBatch(symbols) {
  return request(`/api/recommendations/symbol-52w-batch?symbols=${encodeURIComponent(symbols.join(','))}`);
}

export function fetchNifty500Consistent(universe = 'NIFTY500') {
  return request(`/api/recommendations/nifty500-consistent?universe=${universe}`);
}

export function fetchAskDataStatus() {
  return request('/api/ask-data/status');
}

export async function askData(question) {
  const response = await fetch(`${API_BASE_URL}/api/ask-data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

export function fetchNifty500Symbols(universe = 'NIFTY500') {
  return request(`/api/recommendations/nifty500-symbols?universe=${universe}`);
}

export function fetchNifty500StockPosition(symbol, days = 22, universe = 'NIFTY500') {
  return request(`/api/recommendations/nifty500-stock-position?symbol=${encodeURIComponent(symbol)}&days=${days}&universe=${universe}`);
}

export function fetchOrderImpact({ from, to, portfolio = '', horizon = 'now' } = {}) {
  const q = new URLSearchParams({ from, to, horizon });
  if (portfolio) q.set('portfolio', portfolio);
  return request(`/api/performance/order-impact?${q.toString()}`);
}

export function fetchSymbolHolding(symbol) {
  return request(`/api/portfolio/holding?symbol=${encodeURIComponent(symbol)}`);
}

export function fetchStockInsight(symbol, force = false) {
  return request(`/api/recommendations/stock-insight?symbol=${encodeURIComponent(symbol)}${force ? '&force=1' : ''}`);
}

export function fetchNifty500Top(limit = 25, universe = 'NIFTY500') {
  return request(`/api/recommendations/nifty500-top?limit=${limit}&universe=${universe}`);
}

export function fetchExternalRecs() {
  return request('/api/external-recs');
}

export async function startNifty500Scan(refreshFundamentals = false, universe = 'NIFTY500') {
  const response = await fetch(`${API_BASE_URL}/api/recommendations/nifty500-scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshFundamentals, universe }),
  });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

export async function refreshScores(portfolio = 'Rams') {
  const response = await fetch(`${API_BASE_URL}/api/scoring/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ portfolio }),
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

export async function refreshAllScores() {
  const response = await fetch(`${API_BASE_URL}/api/scoring/refresh-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

// ── Daily Sync ───────────────────────────────────────────────────────────────
// Day-end capture of orders + holdings, and the ledger of which trading days actually got
// captured. Neither broker login can be automated, so the page pairs the run with live
// connection state and a way to fix it.
export function fetchDailySyncStatus() {
  return request('/api/daily-sync/status');
}

export async function runDailySync() {
  const response = await fetch(`${API_BASE_URL}/api/daily-sync/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

// Day-by-day presence/absence of orders and holdings. Quiet days are separated from real gaps
// server-side, using holdings movement as the witness.
export function fetchCaptureCoverage(days = 45) {
  return request('/api/daily-sync/coverage?days=' + days);
}

export function fetchBreezeLoginUrl() {
  return request('/api/breeze/login-url');
}

export function fetchKiteLoginUrl() {
  return request('/api/kite/login-url');
}

// ── Kite Connect ─────────────────────────────────────────────────────────────
export function fetchKiteStatus() {
  return request('/api/kite/status');
}

export async function kiteExchangeToken(requestToken) {
  const response = await fetch(`${API_BASE_URL}/api/kite/exchange-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestToken }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

export function fetchKiteHoldings() {
  return request('/api/kite/holdings');
}

export async function saveKiteHoldings({ holdings, snapshotDate, portfolio }) {
  const response = await fetch(`${API_BASE_URL}/api/kite/save-holdings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ holdings, snapshotDate, portfolio }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

export async function revokeKiteSession() {
  const response = await fetch(`${API_BASE_URL}/api/kite/session`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

// ── Breeze Connect (ICICI Direct) ─────────────────────────────────────────────
export function fetchBreezeStatus() {
  return request('/api/breeze/status');
}

export async function breezeGenerateSession(sessionToken) {
  const response = await fetch(`${API_BASE_URL}/api/breeze/generate-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionToken }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

export async function fetchBreezeHoldings() {
  const response = await fetch(`${API_BASE_URL}/api/breeze/holdings`);
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

export async function saveBreezeHoldings({ holdings, snapshotDate, portfolio }) {
  const response = await fetch(`${API_BASE_URL}/api/breeze/save-holdings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ holdings, snapshotDate, portfolio }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

export function fetchBreezeOrders(from, to) {
  const p = new URLSearchParams();
  if (from) p.set('from', from);
  if (to)   p.set('to', to);
  const qs = p.toString();
  return request(`/api/breeze/orders${qs ? `?${qs}` : ''}`);
}

export async function saveBreezeOrders({ orders, portfolio = 'Rams' }) {
  const response = await fetch(`${API_BASE_URL}/api/breeze/save-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orders, portfolio }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

export function fetchKiteOrders() {
  return request('/api/kite/orders');
}

export async function saveKiteOrders({ orders, portfolio = 'Geetha' }) {
  const response = await fetch(`${API_BASE_URL}/api/kite/save-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orders, portfolio }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

export async function revokeBreezeSession() {
  const response = await fetch(`${API_BASE_URL}/api/breeze/session`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

export function fetchLatestScores(portfolio = '') {
  const params = new URLSearchParams();
  if (portfolio) params.set('portfolio', portfolio);
  return request(`/api/scoring/scores/latest?${params.toString()}`);
}

export async function uploadOrdersImport(payload) {
  const response = await fetch(`${API_BASE_URL}/api/imports/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

export function fetchFnoPnl({ from = '', to = '', granularity = 'monthly', portfolio = '' } = {}) {
  const p = new URLSearchParams();
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  if (granularity) p.set('granularity', granularity);
  if (portfolio) p.set('portfolio', portfolio);
  return request(`/api/pnl/fno?${p.toString()}`);
}

export function fetchBrokerage({ from = '', to = '', portfolio = '' } = {}) {
  const p = new URLSearchParams();
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  if (portfolio) p.set('portfolio', portfolio);
  return request(`/api/pnl/brokerage?${p.toString()}`);
}

export function fetchPerformance({ period = 'monthly', portfolio = 'both' } = {}) {
  const params = new URLSearchParams({ period, portfolio });
  return request(`/api/performance/summary?${params.toString()}`);
}

export function fetchPortfolioTrend({ portfolio = 'both', from = '', to = '' } = {}) {
  const params = new URLSearchParams({ portfolio });
  if (from) params.set('from', from);
  if (to)   params.set('to', to);
  return request(`/api/performance/trend?${params.toString()}`);
}

export function fetchInvestmentTrendReport({ portfolio = 'both', frequency = 'monthly', from = '', to = '' } = {}) {
  const params = new URLSearchParams({ portfolio, frequency });
  if (from) params.set('from', from);
  if (to)   params.set('to', to);
  return request(`/api/performance/trend-report?${params.toString()}`);
}

// ── Broker Tips ───────────────────────────────────────────────────────────────
export function fetchBrokerTips({ status, portfolio } = {}) {
  const p = new URLSearchParams();
  if (status)    p.set('status', status);
  if (portfolio) p.set('portfolio', portfolio);
  return request(`/api/broker-tips?${p.toString()}`);
}

export async function addBrokerTip(payload) {
  const response = await fetch(`${API_BASE_URL}/api/broker-tips`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

export async function updateBrokerTip(id, fields) {
  const response = await fetch(`${API_BASE_URL}/api/broker-tips/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

export async function deleteBrokerTip(id) {
  const response = await fetch(`${API_BASE_URL}/api/broker-tips/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

export async function uploadPortfolioImport(payload) {
  const response = await fetch(`${API_BASE_URL}/api/imports/portfolio`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

// ── TechCheckByNiti equity advice (pasted from WhatsApp) ─────────────────────
export function fetchEquityAdvice(source = '') {
  const p = new URLSearchParams();
  if (source) p.set('source', source);
  return request(`/api/equity-advice/?${p.toString()}`);
}

async function postJson(path, body) {
  const r = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(`Request failed: ${r.status}`);
  return r.json();
}

export function previewEquityAdvice(text)  { return postJson('/api/equity-advice/preview', { text }); }
export function ingestEquityAdvice(text, advisedOn) { return postJson('/api/equity-advice/ingest', { text, advisedOn }); }
export function refreshEquityAdvice()      { return postJson('/api/equity-advice/refresh', {}); }
export function mapEquityAdviceSymbol(id, symbol) { return postJson(`/api/equity-advice/${id}/symbol`, { symbol }); }
export function closeEquityAdvice(id)      { return postJson(`/api/equity-advice/${id}/close`, {}); }
export async function deleteEquityAdvice(id) {
  const r = await fetch(`${API_BASE_URL}/api/equity-advice/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`Request failed: ${r.status}`);
  return r.json();
}

// ── Broker setup ─────────────────────────────────────────────────────────────
// A participant's own API keys, which the desktop app never needed: it read one developer's
// credentials from a .env file on the machine it ran on.

export function fetchBrokerSetup() {
  return request('/api/broker-setup');
}

export async function saveBrokerKeys(broker, apiKey, apiSecret) {
  const response = await fetch(`${API_BASE_URL}/api/broker-setup/${broker}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey, apiSecret }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || 'Could not save those keys.'), body);
  return body;
}

export async function forgetBrokerKeys(broker) {
  const response = await fetch(`${API_BASE_URL}/api/broker-setup/${broker}`, { method: 'DELETE' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || 'Could not remove those keys.'), body);
  return body;
}
