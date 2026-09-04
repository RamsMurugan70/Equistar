const BASE_URL = 'https://www.nseindia.com';
const YAHOO_CHART_BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

// ── In-memory momentum cache (30-minute TTL) ──────────────────────────────────
const MOMENTUM_CACHE = new Map();
const MOMENTUM_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getCachedMomentum(symbol) {
  const entry = MOMENTUM_CACHE.get(symbol);
  if (!entry) return null;
  if (Date.now() - entry.ts > MOMENTUM_CACHE_TTL_MS) {
    MOMENTUM_CACHE.delete(symbol);
    return null;
  }
  return entry.data;
}

function setCachedMomentum(symbol, data) {
  MOMENTUM_CACHE.set(symbol, { ts: Date.now(), data });
}
const MONTHS = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function buildHeaders(cookie = '') {
  return {
    'User-Agent': 'Mozilla/5.0',
    Accept: 'application/json, text/plain, */*',
    Referer: `${BASE_URL}/`,
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: cookie,
  };
}

function parseCookies(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return '';
  return setCookie
    .split(/,(?=[^;]+=[^;]+)/)
    .map((item) => item.split(';')[0].trim())
    .join('; ');
}

async function fetchJsonWithSession(url) {
  const homeResponse = await fetch(BASE_URL, {
    headers: buildHeaders(),
  });
  const cookie = parseCookies(homeResponse);

  const response = await fetch(url, {
    headers: buildHeaders(cookie),
  });

  if (!response.ok) {
    throw new Error(`NSE request failed: ${response.status}`);
  }

  return response.json();
}

function normalizeActionDate(action) {
  return action.exDate || action.exdate || action.recordDate || action.record_date || '';
}

function parseDateValue(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = new Date(`${text}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parts = text.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (parts) {
    const [, day, monthText, year] = parts;
    const monthIndex = MONTHS[monthText.toLowerCase()];
    if (monthIndex >= 0) {
      const date = new Date(Date.UTC(Number(year), monthIndex, Number(day)));
      return Number.isNaN(date.getTime()) ? null : date;
    }
  }

  const fallback = new Date(text);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function parseRatio(text) {
  const match = String(text || '').match(/(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/);
  if (!match) return null;

  const left = Number(match[1]);
  const right = Number(match[2]);
  if (!left || !right) return null;

  return { left, right };
}

function parseDividendAmount(text) {
  const match = String(text || '').match(/(?:rs|re)\.?\s*(\d+(?:\.\d+)?)\s*(?:\/-)?\s*per\s*(?:share|sh|equity\s+share)/i);
  if (!match) return null;

  const amount = Number(match[1]);
  return Number.isFinite(amount) ? amount : null;
}

function parseCorporateActionFactor(purpose) {
  const rawText = String(purpose || '').trim();
  const text = rawText.toLowerCase();

  if (text.includes('bonus')) {
    const ratio = parseRatio(rawText);
    if (ratio) {
      return {
        type: 'Bonus',
        effectType: 'quantity',
        factor: (ratio.left + ratio.right) / ratio.right,
        supported: true,
      };
    }
  }

  const splitMatch = rawText.match(/(?:face value split|stock split|split|sub-division|subdivision).*?from\s*rs\.?\s*(\d+(?:\.\d+)?)\/?-?\s*.*?to\s*rs\.?\s*(\d+(?:\.\d+)?)\/?-?\s*/i)
    || rawText.match(/(?:face value split|stock split|split|sub-division|subdivision).*?(\d+(?:\.\d+)?)\s*(?:to|\/|-|into)\s*(\d+(?:\.\d+)?)/i);
  if (splitMatch) {
    const from = Number(splitMatch[1]);
    const to = Number(splitMatch[2]);
    if (from > 0 && to > 0) {
      return {
        type: 'Split',
        factor: from / to,
        effectType: 'quantity',
        supported: true,
      };
    }
  }

  const consolidationMatch = rawText.match(/(?:consolidation|reverse split).*?from\s*rs\.?\s*(\d+(?:\.\d+)?)\/?-?\s*.*?to\s*rs\.?\s*(\d+(?:\.\d+)?)\/?-?\s*/i)
    || rawText.match(/(?:consolidation|reverse split).*?(\d+(?:\.\d+)?)\s*(?:to|\/|-|into)\s*(\d+(?:\.\d+)?)/i);
  if (consolidationMatch) {
    const from = Number(consolidationMatch[1]);
    const to = Number(consolidationMatch[2]);
    if (from > 0 && to > 0) {
      return {
        type: 'Consolidation',
        factor: from / to,
        effectType: 'quantity',
        supported: true,
      };
    }
  }

  if (text.includes('dividend')) {
    const amount = parseDividendAmount(rawText);
    if (amount !== null) {
      return {
        type: 'Dividend',
        effectType: 'cash',
        amountPerShare: amount,
        supported: true,
      };
    }
  }

  if (text.includes('rights')) {
    const ratio = parseRatio(rawText);
    return {
      type: 'Rights',
      effectType: 'unsupported',
      supported: false,
      ratio,
      note: 'Rights issues need subscription-price assumptions and are not auto-applied.',
    };
  }

  if (text.includes('demerger') || text.includes('de-merger') || text.includes('scheme of arrangement') || text.includes('amalgamation') || text.includes('merger')) {
    return {
      type: 'Restructure',
      effectType: 'unsupported',
      supported: false,
      note: 'Merger / demerger actions need instrument-specific valuation rules and are not auto-applied.',
    };
  }

  return {
    type: 'Other',
    effectType: 'unsupported',
    supported: false,
    note: 'This corporate action is not auto-applied yet.',
  };
}

async function fetchQuote(symbol) {
  const data = await fetchJsonWithSession(`${BASE_URL}/api/quote-equity?symbol=${encodeURIComponent(symbol)}`);
  const lastPrice = Number(
    data?.priceInfo?.lastPrice
    || data?.priceInfo?.close
    || data?.metadata?.lastPrice
    || 0
  );

  if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
    throw new Error(`NSE did not return a usable current price for ${symbol}.`);
  }

  return {
    symbol,
    currentPrice: lastPrice,
    companyName: data?.info?.companyName || data?.info?.symbol || symbol,
    asOf: data?.metadata?.lastUpdateTime || '',
  };
}

function average(numbers) {
  if (!numbers.length) return null;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function percentDistance(base, current) {
  if (!Number.isFinite(base) || base === 0 || !Number.isFinite(current)) {
    return null;
  }

  return ((current - base) / base) * 100;
}

// ── EMA helpers ───────────────────────────────────────────────────────────────
function emaSeries(closes, span) {
  if (!closes.length) return [];
  const k = 2 / (span + 1);
  const out = [closes[0]];
  for (let i = 1; i < closes.length; i += 1) {
    out.push(closes[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

// Trend ladder from EMA stack. EMA reacts faster than the SMA-based trendStatus,
// so deterioration shows up here weeks earlier.
function classifyEmaLadder({ price, ema20, ema50, ema200 }) {
  if (![price, ema20, ema50, ema200].every(Number.isFinite)) return null;
  if (price > ema20 && ema20 > ema50 && ema50 > ema200) return 'STRONG_UPTREND';
  if (ema50 > ema200 && price < ema20 && price > ema50)  return 'PULLBACK';      // dip within an uptrend
  if (ema50 > ema200 && price < ema50)                   return 'DISTRIBUTION';  // uptrend cracking
  if (price < ema200 && ema50 < ema200)                  return 'DOWNTREND';
  return 'MIXED';
}

// Count consecutive closes (from most recent backwards) strictly below an EMA.
function daysBelowEma(closes, ema) {
  let n = 0;
  for (let i = closes.length - 1; i >= 0; i -= 1) {
    if (closes[i] < ema[i]) n += 1;
    else break;
  }
  return n;
}

function classifyTrend({ currentPrice, dma50, dma200 }) {
  if (!Number.isFinite(currentPrice) || !Number.isFinite(dma50) || !Number.isFinite(dma200)) {
    return 'Data unavailable';
  }

  if (currentPrice > dma50 && dma50 > dma200) {
    return 'Strong Uptrend';
  }

  if (currentPrice > dma200 && currentPrice > dma50) {
    return 'Uptrend';
  }

  if (currentPrice > dma200 && currentPrice <= dma50) {
    return 'Weakening';
  }

  return 'Breakdown';
}

// `range` is a parameter because the callers need different amounts of history and asking for
// the longest would be wasteful. The momentum snapshot needs a year (200-day DMA, 52-week
// range); the GARCH fit needs two, so that a reading six months ago still has a full year of
// data behind it rather than being estimated off a half-sample.
async function fetchYahooChart(symbolWithSuffix, range = '1y') {
  const url = `${YAHOO_CHART_BASE_URL}/${encodeURIComponent(symbolWithSuffix)}?range=${encodeURIComponent(range)}&interval=1d&includePrePost=false&events=div%2Csplits`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json, text/plain, */*',
    },
  });

  if (!response.ok) {
    throw new Error(`Yahoo chart request failed for ${symbolWithSuffix}: ${response.status}`);
  }

  const data = await response.json();
  const result = data?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const timestamps = result?.timestamp || [];

  if (!result || !timestamps.length || !closes.length) {
    throw new Error(`Yahoo did not return usable price history for ${symbolWithSuffix}.`);
  }

  const points = timestamps
    .map((timestamp, index) => ({
      timestamp,
      close: Number(closes[index]),
    }))
    .filter((point) => Number.isFinite(point.close) && point.close > 0);

  if (!points.length) {
    throw new Error(`Yahoo price history was empty for ${symbolWithSuffix}.`);
  }

  // Extract current price from Yahoo meta (more up-to-date than last historical close)
  const regularMarketPrice = Number(result?.meta?.regularMarketPrice || 0);
  const regularMarketTime = result?.meta?.regularMarketTime
    ? new Date(result.meta.regularMarketTime * 1000).toISOString()
    : '';

  return {
    points,
    regularMarketPrice: regularMarketPrice > 0 ? regularMarketPrice : null,
    regularMarketTime,
  };
}

async function fetchPriceHistory(symbol, range = '1y') {
  const candidates = [`${symbol}.NS`, `${symbol}.BO`];
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const result = await fetchYahooChart(candidate, range);
      return {
        sourceSymbol: candidate,
        points: result.points,
        regularMarketPrice: result.regularMarketPrice,
        regularMarketTime: result.regularMarketTime,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Unable to fetch price history for ${symbol}.`);
}

async function fetchMomentumSnapshot(symbol) {
  // Serve from cache if available (30-min TTL)
  const cached = getCachedMomentum(symbol);
  if (cached) return cached;

  // Run NSE quote and Yahoo history concurrently; NSE quote is optional (403 is common server-side)
  const [nseQuoteResult, history] = await Promise.allSettled([
    fetchQuote(symbol),
    fetchPriceHistory(symbol),
  ]);

  if (history.status === 'rejected') {
    // Can't compute anything without price history
    throw history.reason;
  }

  const closes = history.value.points.map((point) => point.close);

  // Prefer NSE live price → Yahoo regularMarketPrice → last historical close
  let currentPrice;
  let asOf;
  if (nseQuoteResult.status === 'fulfilled') {
    currentPrice = nseQuoteResult.value.currentPrice;
    asOf = nseQuoteResult.value.asOf;
  } else {
    currentPrice = history.value.regularMarketPrice || (closes.length ? closes[closes.length - 1] : null);
    asOf = history.value.regularMarketTime || '';
  }

  const last50 = closes.slice(-50);
  const last200 = closes.slice(-200);
  const dma50 = average(last50);
  const dma200 = average(last200);
  const high52Week = closes.length ? Math.max(...closes) : null;
  const low52Week  = closes.length ? Math.min(...closes) : null;
  const threeMonthsAgoClose = closes.length >= 64 ? closes[closes.length - 64] : null;
  const return3M = percentDistance(threeMonthsAgoClose, currentPrice);

  // ── EMA stack (20/50/200) + ladder + slope ──────────────────────────────────
  const e20s  = emaSeries(closes, 20);
  const e50s  = emaSeries(closes, 50);
  const e200s = emaSeries(closes, 200);
  const ema20  = e20s.length  ? e20s[e20s.length - 1]   : null;
  const ema50  = e50s.length  ? e50s[e50s.length - 1]   : null;
  const ema200 = e200s.length >= 200 ? e200s[e200s.length - 1] : (e200s.length ? e200s[e200s.length - 1] : null);
  // 50EMA slope over the last 10 sessions, in % — direction of the trend itself
  const ema50SlopePct = (e50s.length > 10 && e50s[e50s.length - 11] > 0)
    ? ((ema50 - e50s[e50s.length - 11]) / e50s[e50s.length - 11]) * 100
    : null;
  const emaLadder = classifyEmaLadder({ price: currentPrice, ema20, ema50, ema200 });

  const result = {
    currentPrice,
    asOf,
    dma50,
    dma200,
    cmpVs50DmaPct: percentDistance(dma50, currentPrice),
    cmpVs200DmaPct: percentDistance(dma200, currentPrice),
    high52Week,
    distanceFrom52WeekHighPct: percentDistance(high52Week, currentPrice),
    low52Week,
    distanceFrom52WeekLowPct: percentDistance(low52Week, currentPrice),
    return3M,
    trendStatus: classifyTrend({ currentPrice, dma50, dma200 }),
    // EMA metrics (faster trend read; used by Action Queue early triggers)
    ema20, ema50, ema200,
    cmpVs20EmaPct: percentDistance(ema20, currentPrice),
    cmpVs50EmaPct: percentDistance(ema50, currentPrice),
    ema50SlopePct,
    ema20Below50: (Number.isFinite(ema20) && Number.isFinite(ema50)) ? ema20 < ema50 : null,
    daysBelow20Ema: daysBelowEma(closes, e20s),
    daysBelow50Ema: daysBelowEma(closes, e50s),
    emaLadder,
    historySource: history.value.sourceSymbol,
  };

  setCachedMomentum(symbol, result);
  return result;
}

async function fetchCorporateActions(symbol, fromDate, toDate) {
  const url = new URL(`${BASE_URL}/api/corporates-corporateActions`);
  url.searchParams.set('index', 'equities');
  url.searchParams.set('symbol', symbol);
  if (fromDate) url.searchParams.set('from_date', fromDate);
  if (toDate) url.searchParams.set('to_date', toDate);

  const data = await fetchJsonWithSession(url.toString());
  const items = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);

  return items
    .map((item) => {
      const parsed = parseCorporateActionFactor(item.purpose || item.subject || item.desc || '');
      const actionDate = normalizeActionDate(item);
      return {
        purpose: item.purpose || item.subject || item.desc || '',
        actionDate,
        actionDateIso: parseDateValue(actionDate)?.toISOString().slice(0, 10) || '',
        factor: parsed?.factor || 1,
        actionType: parsed?.type || '',
        effectType: parsed?.effectType || 'unsupported',
        amountPerShare: parsed?.amountPerShare || 0,
        supported: Boolean(parsed?.supported),
        note: parsed?.note || '',
      };
    })
    .filter((item) => item.actionDate)
    .sort((left, right) => {
      const leftTime = parseDateValue(left.actionDate)?.getTime() || 0;
      const rightTime = parseDateValue(right.actionDate)?.getTime() || 0;
      return leftTime - rightTime;
    });
}

module.exports = {
  fetchQuote,
  fetchMomentumSnapshot,
  fetchPriceHistory,
  fetchCorporateActions,
  parseCorporateActionFactor,
  parseDateValue,
};
