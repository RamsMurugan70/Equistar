const ordersRepository = require('../../repositories/ordersRepository');
const sellEvaluatorService = require('./sellEvaluatorService');
const nseService = require('../market/nseService');
const { isFno } = require('../../utils/tradeClassification');

async function getOrders(filters) {
  const page = Number(filters.page || 1);
  const pageSize = Number(filters.pageSize || 50);
  const result = await ordersRepository.listOrders({
    portfolio: filters.portfolio || '',
    symbol: filters.symbol || '',
    from: filters.from || '',
    to: filters.to || '',
    // 'equity' | 'fno' | 'all' (default). Passed through untouched so the default stays
    // all-segments for every existing caller.
    segment: filters.segment || 'all',
    pageSize,
    offset: (page - 1) * pageSize,
  });

  return {
    page,
    pageSize,
    total: result.total,
    segment: filters.segment || 'all',
    rows: result.rows,
  };
}

async function getOrdersMeta() {
  return ordersRepository.getOrdersMeta();
}

async function getSellEvaluatorOptions() {
  return sellEvaluatorService.listSellEvaluatorOptions();
}

async function getSellEvaluatorDates() {
  return sellEvaluatorService.listSellEvaluatorDates();
}

async function getSellEvaluation(filters) {
  if (filters.saleDate) {
    return sellEvaluatorService.evaluateSoldDate(filters.saleDate);
  }
  // No portfolio given → combined across every portfolio that sold this symbol
  // (the dropdown now lists one entry per symbol, not per portfolio/symbol pair).
  if (filters.symbol && !filters.portfolio) {
    return sellEvaluatorService.evaluateSoldSymbolCombined(filters.symbol);
  }

  return sellEvaluatorService.evaluateSoldSymbol(filters.portfolio || '', filters.symbol || '');
}

function monthsAgoIso(months) {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.toISOString().slice(0, 10);
}

async function getBuyEvaluatorReport() {
  const fromDate = monthsAgoIso(3);
  const all = await ordersRepository.listRecentBuySummary(fromDate);

  // The query already drops the F&O exchanges; this catches a contract whose exchange column
  // is blank or mislabelled, by matching the symbol shape. Uses the shared classifier rather
  // than a second regex so "is this F&O" has ONE definition across the codebase — it is the
  // rule that knows RELIANCE/FINPIPE end in CE/PE but are not options.
  const rows = all.filter((r) => !isFno(r));

  // Orders carry ICICI's broker code, which is NOT the NSE symbol (BAAUTO = BAJAJ-AUTO,
  // NIFJUN = JUNIORBEES, FIRSOU = FSL). Quoting the raw code returns nothing, which is why
  // half these rows read "Data unavailable" even for large, liquid holdings. Resolved through
  // the same mapper the portfolio and scanner already use.
  // Required lazily: portfolioService pulls in a wide dependency graph and this keeps the
  // module load order independent of it.
  const { resolveNseSymbol } = require('../portfolio/portfolioService');

  const reportRows = await Promise.all(rows.map(async (row) => {
    const nseSymbol = (resolveNseSymbol(row.symbol) || row.symbol).toUpperCase();
    try {
      const momentum = await nseService.fetchMomentumSnapshot(nseSymbol);
      const averageBuyPrice = Number(row.average_buy_price || 0);
      const currentPrice = Number(momentum.currentPrice || 0);
      const priceChange = currentPrice - averageBuyPrice;
      const priceChangePct = averageBuyPrice > 0 ? (priceChange / averageBuyPrice) * 100 : 0;

      return {
        portfolio: row.portfolio,
        symbol: row.symbol,
        // Surfaced so a blank metric can be told apart from a symbol that failed to resolve.
        nseSymbol,
        quantity: Number(row.bought_quantity || 0),
        averageBuyPrice,
        totalBuyValue: Number(row.total_buy_value || 0),
        buyCount: Number(row.buy_count || 0),
        firstBuyDate: row.first_buy_date,
        lastBuyDate: row.last_buy_date,
        currentPrice,
        currentPriceAsOf: momentum.asOf || '',
        priceChange,
        priceChangePct,
        dma50: momentum.dma50,
        dma200: momentum.dma200,
        cmpVs50DmaPct: momentum.cmpVs50DmaPct,
        cmpVs200DmaPct: momentum.cmpVs200DmaPct,
        high52Week: momentum.high52Week,
        distanceFrom52WeekHighPct: momentum.distanceFrom52WeekHighPct,
        return3M: momentum.return3M,
        trendStatus: momentum.trendStatus,
        quoteStatus: 'ok',
      };
    } catch (error) {
      return {
        portfolio: row.portfolio,
        symbol: row.symbol,
        // Surfaced so a blank metric can be told apart from a symbol that failed to resolve.
        nseSymbol,
        quantity: Number(row.bought_quantity || 0),
        averageBuyPrice: Number(row.average_buy_price || 0),
        totalBuyValue: Number(row.total_buy_value || 0),
        buyCount: Number(row.buy_count || 0),
        firstBuyDate: row.first_buy_date,
        lastBuyDate: row.last_buy_date,
        currentPrice: null,
        currentPriceAsOf: '',
        priceChange: null,
        priceChangePct: null,
        dma50: null,
        dma200: null,
        cmpVs50DmaPct: null,
        cmpVs200DmaPct: null,
        high52Week: null,
        distanceFrom52WeekHighPct: null,
        return3M: null,
        trendStatus: 'Data unavailable',
        quoteError: error.message,
        quoteStatus: 'error',
      };
    }
  }));

  return {
    fromDate,
    asOfDate: new Date().toISOString().slice(0, 10),
    rows: reportRows,
  };
}

module.exports = {
  getOrders,
  getOrdersMeta,
  getSellEvaluatorOptions,
  getSellEvaluatorDates,
  getSellEvaluation,
  getBuyEvaluatorReport,
};
