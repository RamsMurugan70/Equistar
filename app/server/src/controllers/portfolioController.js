const portfolioService = require('../services/portfolio/portfolioService');
const downloadsPortfolioImportService = require('../services/imports/downloadsPortfolioImportService');

async function getPortfolioOverview(req, res, next) {
  try {
    const data = await portfolioService.getPortfolioOverview(req.query.portfolio || '');
    res.json(data);
  } catch (error) {
    next(error);
  }
}

async function importPortfoliosFromDownloads(_req, res, next) {
  try {
    const data = await downloadsPortfolioImportService.scanDownloadsAndImportPortfolios();
    res.json(data);
  } catch (error) {
    next(error);
  }
}

// Currently-held symbols per portfolio, computed live from orders (never stale) —
// used to cross-check "is this actually still held" before flagging exit candidates.
async function getHeldSymbols(_req, res, next) {
  try {
    const data = await portfolioService.getHeldSymbolsFromOrders();
    res.json(data);
  } catch (error) {
    next(error);
  }
}

// Earliest still-open buy date per (portfolio, symbol) — for "how long have I held
// this" on the Dashboard's Exit Candidates cards, resolved across broker-code changes.
async function getHoldingPeriods(_req, res, next) {
  try {
    const data = await portfolioService.getHoldingPeriods();
    res.json(data);
  } catch (error) {
    next(error);
  }
}

async function getLiveBreakdown(_req, res, next) {
  try {
    const data = await portfolioService.getLiveBreakdown();
    res.json({ breakdown: data });
  } catch (error) {
    next(error);
  }
}

async function getAsOfReport(req, res, next) {
  try {
    const data = await portfolioService.getAsOfReport(req.query.portfolio || '', req.query.date || '');
    res.json(data);
  } catch (error) {
    next(error);
  }
}

// One symbol's position across Rams + Geetha — for the Stock Sleuth holdings box.
// Returns held:false (not a 404) when the stock isn't owned; "you don't hold this" is a
// legitimate answer to the question, not an error.
async function getHoldingForSymbol(req, res, next) {
  try {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });
    res.json(await portfolioService.getHoldingForSymbol(symbol));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getHoldingForSymbol,
  getPortfolioOverview,
  importPortfoliosFromDownloads,
  getLiveBreakdown,
  getAsOfReport,
  getHeldSymbols,
  getHoldingPeriods,
};
