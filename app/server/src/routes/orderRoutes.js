const express = require('express');
const controller = require('../controllers/ordersController');

const router = express.Router();
router.get('/', controller.listOrders);
router.get('/meta', controller.getOrdersMeta);
router.get('/sell-evaluator/options', controller.getSellEvaluatorOptions);
router.get('/sell-evaluator/dates', controller.getSellEvaluatorDates);
router.get('/sell-evaluator', controller.getSellEvaluation);
router.get('/buy-evaluator/report', controller.getBuyEvaluatorReport);
router.post('/import-downloads', controller.importOrdersFromDownloads);

module.exports = router;
