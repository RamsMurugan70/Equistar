const express = require('express');
const controller = require('../controllers/scoringController');

const router = express.Router();

router.post('/refresh', controller.refreshScores);
router.post('/refresh-all', controller.refreshAllScores);
router.get('/scores', controller.getScores);
router.get('/scores/latest', controller.getLatestScores);

module.exports = router;
