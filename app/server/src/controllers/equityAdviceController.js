const service = require('../services/advice/equityAdviceService');
const symbolMaster = require('../services/advice/symbolMasterService');
const repo = require('../repositories/equityAdviceRepository');

async function preview(req, res, next) {
  try { res.json(await service.previewPaste(req.body?.text || '')); }
  catch (e) { next(e); }
}

async function ingest(req, res, next) {
  try {
    res.json(await service.ingestPaste({
      text: req.body?.text || '',
      source: req.body?.source || service.DEFAULT_SOURCE,
      advisedOn: req.body?.advisedOn || null,
    }));
  } catch (e) { next(e); }
}

async function list(req, res, next) {
  try { res.json(await service.listWithPerformance({ source: req.query.source || service.DEFAULT_SOURCE })); }
  catch (e) { next(e); }
}

async function refresh(req, res, next) {
  try { res.json(await service.refreshTracking({ source: req.query.source || service.DEFAULT_SOURCE })); }
  catch (e) { next(e); }
}

// Manual symbol mapping, for names the master can't resolve on its own.
async function mapSymbol(req, res, next) {
  try {
    await repo.setSymbol(Number(req.params.id), String(req.body?.symbol || '').toUpperCase(), req.body?.name || null);
    res.json({ ok: true });
  } catch (e) { next(e); }
}

async function close(req, res, next) {
  try {
    await repo.setStatus(Number(req.params.id), 'CLOSED', req.body?.outcome || 'CLOSED_MANUAL');
    res.json({ ok: true });
  } catch (e) { next(e); }
}

async function remove(req, res, next) {
  try { await repo.remove(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { next(e); }
}

async function refreshSymbols(_req, res, next) {
  try { res.json(await symbolMaster.refreshSymbolMaster()); }
  catch (e) { next(e); }
}

async function symbolStatus(_req, res, next) {
  try { res.json(await symbolMaster.status()); }
  catch (e) { next(e); }
}

module.exports = { preview, ingest, list, refresh, mapSymbol, close, remove, refreshSymbols, symbolStatus };
