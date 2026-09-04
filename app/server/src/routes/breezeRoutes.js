const express    = require('express');
const controller = require('../controllers/breezeController');
const router     = express.Router();

router.get ('/status',           controller.getStatus);
router.get ('/login-url',        controller.getLoginUrl);
router.get ('/callback',         controller.handleCallback);
router.post('/generate-session', controller.generateSession);
router.get ('/holdings',         controller.getHoldings);
router.get ('/pledge-summary',   controller.getPledgeSummary);
router.post('/save-holdings',    controller.saveHoldings);
router.get ('/orders',           controller.getOrders);
router.post('/backfill-order-ids', controller.backfillOrderIds);
router.post('/save-orders',      controller.saveOrders);
router.delete('/session',        controller.revokeToken);

module.exports = router;
