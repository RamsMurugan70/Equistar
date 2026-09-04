const express = require('express');
const controller = require('../controllers/recommendationsController');

const router = express.Router();
router.get('/', controller.listRecommendations);
router.post('/', controller.addRecommendation);
router.get('/exit-candidates', controller.exitCandidates);
router.get('/matched-orders', controller.matchedOrders);
router.get('/picker-matches', controller.pickerMatches);
router.get('/symbol-technicals', controller.symbolTechnicals);
router.get('/symbol-52w-batch', controller.symbol52wBatch);
router.get('/rsi-batch', controller.rsiBatch);
router.get('/rank-movement-batch', controller.rankMovementBatch);
router.get('/nifty500-top', controller.nifty500Top);
router.get('/nifty500-top-history', controller.nifty500TopHistory);
router.get('/nifty500-consistent', controller.nifty500Consistent);
router.get('/nifty500-stock-position', controller.nifty500StockPosition);
router.get('/nifty500-symbols', controller.nifty500Symbols);
router.get('/stock-insight', controller.stockInsight);
router.post('/nifty500-scan', controller.nifty500Scan);

module.exports = router;
