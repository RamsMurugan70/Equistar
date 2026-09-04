const express = require('express');
const controller = require('../controllers/brokerTipsController');
const router = express.Router();

router.get('/',      controller.list);
router.post('/',     controller.add);
router.patch('/:id', controller.update);
router.delete('/:id', controller.remove);

module.exports = router;
