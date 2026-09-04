const express = require('express');
const controller = require('../controllers/performanceController');

const router = express.Router();

router.get('/summary', controller.getPerformance);
router.get('/trend',   controller.getTrend);
router.get('/trend-report', controller.getTrendReport);
router.get('/order-impact', controller.getOrderImpact);
router.get('/evolution', controller.getPortfolioEvolution);

module.exports = router;
