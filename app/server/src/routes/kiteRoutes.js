const express    = require('express');
const controller = require('../controllers/kiteController');
const router     = express.Router();

router.get ('/status',        controller.getStatus);
router.get ('/login-url',     controller.getLoginUrl);
router.get ('/callback',      controller.handleCallback);
router.post('/exchange-token',controller.exchangeToken);
router.get ('/holdings',      controller.getHoldings);
router.post('/save-holdings', controller.saveHoldings);
router.get ('/orders',        controller.getOrders);
router.post('/save-orders',   controller.saveOrders);
router.delete('/session',     controller.revokeToken);

module.exports = router;
