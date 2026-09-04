const express = require('express');
const controller = require('../controllers/dashboardController');

const router = express.Router();
router.get('/summary', controller.getDashboard);
router.get('/insights', controller.getDashboardInsights);
router.post('/refresh-corp-actions', controller.refreshCorpActions);

module.exports = router;
