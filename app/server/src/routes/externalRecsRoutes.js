const express = require('express');
const controller = require('../controllers/externalRecsController');

const router = express.Router();
router.post('/', controller.ingest);   // userscript pushes the current picks here
router.get('/', controller.list);      // Equix reads the enriched list

module.exports = router;
