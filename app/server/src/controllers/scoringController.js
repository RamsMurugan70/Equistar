const scoringService = require('../services/scoring/scoringService');
const PF = require('../config/portfolios');

async function refreshScores(req, res, next) {
  try {
    const { portfolio = PF.ICICI, csvPath } = req.body || {};
    // Prefer snapshot CSV (includes pledged holdings); fall back to explicit path or default
    let resolvedCsv = csvPath;
    if (!resolvedCsv) {
      try { resolvedCsv = await scoringService.generateCsvFromSnapshot(portfolio); } catch { /* use default */ }
    }
    const data = await scoringService.refreshCurrentScores(portfolio, resolvedCsv);
    res.json(data);
  } catch (error) {
    next(error);
  }
}

async function getScores(req, res, next) {
  try {
    const { date, portfolio = '' } = req.query;
    const scoreDate = date || new Date().toISOString().slice(0, 10);
    const rows = await scoringService.getScoresForDate(scoreDate, portfolio);
    res.json({ scoreDate, portfolio, rows });
  } catch (error) {
    next(error);
  }
}

async function getLatestScores(req, res, next) {
  try {
    const { portfolio = '' } = req.query;
    const data = await scoringService.getLatestScores(portfolio);
    res.json(data);
  } catch (error) {
    next(error);
  }
}

async function refreshAllScores(req, res, next) {
  try {
    const results = await scoringService.refreshAllScores();
    res.json(results);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  refreshScores,
  refreshAllScores,
  getScores,
  getLatestScores,
};
