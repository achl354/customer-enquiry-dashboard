const express = require('express');
const repo = require('../db/repository');

const router = express.Router();

router.get('/overview', (req, res) => {
  res.json(repo.overviewStats());
});

module.exports = router;
