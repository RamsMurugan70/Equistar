const express = require('express');
const controller = require('../controllers/importsController');

const router = express.Router();

router.post('/orders', controller.importOrders);
router.post('/portfolio', controller.importPortfolioSnapshot);
router.get('/latest', controller.getLatestImportRun);

module.exports = router;
