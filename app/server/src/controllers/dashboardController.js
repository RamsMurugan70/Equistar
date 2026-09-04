const dashboardService = require('../services/dashboard/dashboardService');
const { refreshCorporateActions } = require('../services/corporateActions/corporateActionsService');

async function getDashboard(req, res, next) {
  try {
    const data = await dashboardService.getDashboard();
    res.json(data);
  } catch (error) {
    next(error);
  }
}

async function getDashboardInsights(req, res, next) {
  try {
    const data = await dashboardService.getDashboardInsights();
    res.json(data);
  } catch (error) {
    next(error);
  }
}

async function refreshCorpActions(req, res, next) {
  try {
    const days = Number(req.query.days) || 45;
    const result = await refreshCorporateActions(days);
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
}

module.exports = {
  getDashboard,
  getDashboardInsights,
  refreshCorpActions,
};
