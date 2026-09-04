const express = require('express');
const controller = require('../controllers/equityAdviceController');
const router = express.Router();

router.post('/preview',        controller.preview);
router.post('/ingest',         controller.ingest);
router.get ('/',               controller.list);
router.post('/refresh',        controller.refresh);
router.post('/:id/symbol',     controller.mapSymbol);
router.post('/:id/close',      controller.close);
router.delete('/:id',          controller.remove);
router.get ('/symbols/status', controller.symbolStatus);
router.post('/symbols/refresh',controller.refreshSymbols);

module.exports = router;
