const express = require('express');
const controller = require('../controllers/portfolioController');
const costBasisController = require('../controllers/costBasisController');

const router = express.Router();
router.get('/overview', controller.getPortfolioOverview);
router.get('/as-of', controller.getAsOfReport);
router.get('/live-breakdown', controller.getLiveBreakdown);
router.get('/held-symbols', controller.getHeldSymbols);
router.get('/holding', controller.getHoldingForSymbol);
router.get('/holding-periods', controller.getHoldingPeriods);
router.get('/tax-lots', controller.getTaxLots);
router.post('/import-downloads', controller.importPortfoliosFromDownloads);

// Cost basis overrides — must come before any wildcard routes
router.get('/cost-basis',                          costBasisController.getOverrides);
// Distinct from the overrides list above: this reports where a cost basis is MISSING and cannot
// be reconstructed from the order history, rather than where one has been supplied by hand.
router.get('/cost-basis/coverage',                 costBasisController.getCoverage);
router.post('/cost-basis',                         costBasisController.importOverrides);
router.delete('/cost-basis/:portfolio/:symbol',    costBasisController.removeOverride);

module.exports = router;
