const express = require('express');
const controller = require('../controllers/costBasisController');

const router = express.Router();
router.get('/',                         controller.getOverrides);
router.post('/',                        controller.importOverrides);
router.delete('/:portfolio/:symbol',    controller.removeOverride);

module.exports = router;
