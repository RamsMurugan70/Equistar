const dailySyncService = require('../services/imports/dailySyncService');

// Broker connection state, today's capture, and any trading day still uncaptured.
async function getStatus(req, res, next) {
  try {
    const sinceDays = Number(req.query.sinceDays) || 45;
    res.json(await dailySyncService.getStatus({ sinceDays }));
  } catch (err) { next(err); }
}

// Capture now rather than waiting for the next slot. Returns 200 even when steps fail: a
// partial capture is a real outcome the page has to show step by step, not an error that
// collapses into one message and hides which half worked.
async function runNow(req, res, next) {
  try {
    const { tradeDate } = req.body || {};
    res.json(await dailySyncService.runDailySync({ trigger: 'manual', tradeDate }));
  } catch (err) { next(err); }
}

// Day-by-day presence/absence of orders and holdings for every portfolio, with quiet days told
// apart from real gaps by whether the holdings actually moved.
async function getCoverage(req, res, next) {
  try {
    const days = Number(req.query.days) || 45;
    const svc = require('../services/imports/captureCoverageService');
    res.json(await svc.getCoverage({ days }));
  } catch (err) { next(err); }
}

module.exports = { getStatus, runNow, getCoverage };
