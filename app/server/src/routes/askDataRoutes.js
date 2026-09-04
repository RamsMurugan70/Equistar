const express = require('express');
const controller = require('../controllers/askDataController');
const router = express.Router();
router.post('/', controller.ask);
router.get('/status', controller.status);
module.exports = router;
