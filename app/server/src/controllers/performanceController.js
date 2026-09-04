const { getPerformanceSummary, getPortfolioTrend, getInvestmentTrendReport } = require('../services/performance/performanceService');
const PF = require('../config/portfolios');

async function getPerformance(req, res, next) {
  try {
    const periodType = ['weekly', 'monthly', 'quarterly'].includes(req.query.period)
      ? req.query.period
      : 'monthly';
    const portfolio = [...PF.ALL, 'both'].includes(req.query.portfolio)
      ? req.query.portfolio
      : 'both';
    const data = await getPerformanceSummary({ periodType, portfolio });
    res.json(data);
  } catch (error) {
    next(error);
  }
}

async function getTrend(req, res, next) {
  try {
    const portfolio = [...PF.ALL, 'both'].includes(req.query.portfolio)
      ? req.query.portfolio
      : 'both';
    const { from = '', to = '' } = req.query;
    const data = await getPortfolioTrend({ portfolio, fromDate: from, toDate: to });
    res.json(data);
  } catch (error) {
    next(error);
  }
}

async function getTrendReport(req, res, next) {
  try {
    const portfolio = [...PF.ALL, 'both'].includes(req.query.portfolio)
      ? req.query.portfolio
      : 'both';
    const frequency = req.query.frequency === 'weekly' ? 'weekly' : 'monthly';
    const { from = '', to = '' } = req.query;
    const data = await getInvestmentTrendReport({ portfolio, frequency, fromDate: from, toDate: to });
    res.json(data);
  } catch (error) {
    next(error);
  }
}

// Stockwise verdict on the trades placed in a period — did the buys go up afterwards, and
// did the sells go down? See orderImpactService for the sign convention.
async function getOrderImpact(req, res, next) {
  try {
    const { from = '', to = '', portfolio = '', horizon = 'now' } = req.query;
    const svc = require('../services/performance/orderImpactService');
    res.json(await svc.getOrderImpact({ from, to, portfolio, horizon }));
  } catch (error) { next(error); }
}

// How the equity books evolved over a window: money-weighted return, the same flows run into
// Nifty for comparison, and which holdings drove it. Defaults to both portfolios combined.
async function getPortfolioEvolution(req, res, next) {
  try {
    const period = ['1M', '2M', '3M', '6M', '1Y'].includes(req.query.period) ? req.query.period : '3M';
    const requested = String(req.query.portfolio || 'both');
    const portfolios = requested === 'both' || !PF.ALL.includes(requested)
      ? PF.ALL
      : [requested];
    const svc = require('../services/performance/portfolioEvolutionService');
    res.json(await svc.getEvolution({ period, portfolios }));
  } catch (error) { next(error); }
}

module.exports = {
  getPerformance, getTrend, getTrendReport, getOrderImpact, getPortfolioEvolution,
};
