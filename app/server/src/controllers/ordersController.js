const ordersService = require('../services/orders/ordersService');
const downloadsOrdersImportService = require('../services/imports/downloadsOrdersImportService');

async function listOrders(req, res, next) {
  try {
    const data = await ordersService.getOrders(req.query);
    res.json(data);
  } catch (error) {
    next(error);
  }
}

async function getOrdersMeta(_req, res, next) {
  try {
    const data = await ordersService.getOrdersMeta();
    res.json(data);
  } catch (error) {
    next(error);
  }
}

async function importOrdersFromDownloads(_req, res, next) {
  try {
    const data = await downloadsOrdersImportService.scanDownloadsAndImportOrders();
    res.json(data);
  } catch (error) {
    next(error);
  }
}

async function getSellEvaluatorOptions(_req, res, next) {
  try {
    const data = await ordersService.getSellEvaluatorOptions();
    res.json(data);
  } catch (error) {
    next(error);
  }
}

async function getSellEvaluatorDates(_req, res, next) {
  try {
    const data = await ordersService.getSellEvaluatorDates();
    res.json(data);
  } catch (error) {
    next(error);
  }
}

async function getSellEvaluation(req, res, next) {
  try {
    const data = await ordersService.getSellEvaluation(req.query);
    res.json(data);
  } catch (error) {
    next(error);
  }
}

async function getBuyEvaluatorReport(_req, res, next) {
  try {
    const data = await ordersService.getBuyEvaluatorReport();
    res.json(data);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listOrders,
  getOrdersMeta,
  importOrdersFromDownloads,
  getSellEvaluatorOptions,
  getSellEvaluatorDates,
  getSellEvaluation,
  getBuyEvaluatorReport,
};
