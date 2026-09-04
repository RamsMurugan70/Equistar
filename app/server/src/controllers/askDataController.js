const askDataService = require('../services/askData/askDataService');

async function ask(req, res, next) {
  try {
    const { question } = req.body || {};
    if (!question || !String(question).trim()) return res.status(400).json({ error: 'question is required' });
    res.json(await askDataService.ask(question));
  } catch (error) { next(error); }
}

async function status(_req, res) {
  res.json({ configured: askDataService.isConfigured(), ...askDataService.providerInfo() });
}

module.exports = { ask, status };
