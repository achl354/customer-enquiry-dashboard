const express = require('express');
const repo = require('../db/repository');

const router = express.Router();

router.get('/overview', (req, res) => {
  res.json(repo.overviewStats());
});

// KPI rollup for reporting — month/quarter/year avg. resolution time, not
// part of the main overview payload since it's a distinct reporting view
// (a granularity toggle on the frontend) rather than something the page
// needs on every load.
router.get('/resolution-trend', (req, res) => {
  const granularity = req.query.granularity || 'month';
  if (!['month', 'quarter', 'year'].includes(granularity)) {
    return res.status(400).json({ error: `Invalid granularity: ${granularity}. Use month, quarter, or year.` });
  }
  res.json(repo.resolutionTimeTrend(granularity));
});

module.exports = router;
