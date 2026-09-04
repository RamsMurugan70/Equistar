const importsService = require('../services/imports/importsService');

async function importOrders(req, res, next) {
  try {
    const { portfolio, fileName, ordersByDate } = req.body || {};
    // Dedup-append (skip orders already in the DB) instead of replacing dates,
    // so uploading an overlapping CSV (e.g. a wide Tradebook export) is safe.
    const orders = [];
    for (const [tradeDate, list] of Object.entries(ordersByDate || {})) {
      for (const o of (list || [])) {
        orders.push({
          tradeDate,
          tradeId:  o.tradeId || o.order_id || null,
          symbol:   o.symbol,
          side:     o.side,
          quantity: o.quantity,
          price:    o.price,
          exchange: o.exchange,
        });
      }
    }
    const result = await importsService.importMissingOrders({ portfolio, fileName, orders });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

async function importPortfolioSnapshot(req, res, next) {
  try {
    const result = await importsService.importPortfolioSnapshot(req.body);
    res.json(result);
  } catch (error) {
    next(error);
  }
}

async function getLatestImportRun(_req, res, next) {
  try {
    const result = await importsService.getLatestImportRun();
    res.json(result || null);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  importOrders,
  importPortfolioSnapshot,
  getLatestImportRun,
};
