const express = require('express');
const controller = require('../controllers/dailySyncController');

const router = express.Router();

router.get('/status', controller.getStatus);
router.post('/run', controller.runNow);
router.get('/coverage', controller.getCoverage);

module.exports = router;
