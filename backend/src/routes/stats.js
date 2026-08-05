const express = require('express');
const repo = require('../db/repository');

const router = express.Router();

const PERIOD_GRANULARITIES = ['month', 'quarter', 'year'];
const VOLUME_GRANULARITIES = ['day', 'week', 'month', 'quarter'];

function validateGranularity(req, res, allowed) {
  const granularity = req.query.granularity || (allowed.includes('month') ? 'month' : allowed[0]);
  if (!allowed.includes(granularity)) {
    res.status(400).json({ error: `Invalid granularity: ${granularity}. Use ${allowed.join(', ')}.` });
    return null;
  }
  return granularity;
}

router.get('/overview', (req, res) => {
  res.json(repo.overviewStats());
});

// KPI rollup for reporting — month/quarter/year avg. resolution time (+ SLA
// compliance against an optional ?sla=<hours> threshold, default 48), not
// part of the main overview payload since it's a distinct reporting view
// (a granularity toggle on the frontend) rather than something the page
// needs on every load.
router.get('/resolution-trend', (req, res) => {
  const granularity = validateGranularity(req, res, PERIOD_GRANULARITIES);
  if (!granularity) return;
  const slaHours = req.query.sla !== undefined ? Number(req.query.sla) : undefined;
  if (slaHours !== undefined && (Number.isNaN(slaHours) || slaHours <= 0)) {
    return res.status(400).json({ error: `Invalid "sla" hours: ${req.query.sla}` });
  }
  res.json(repo.resolutionTimeTrend(granularity, slaHours));
});

// Time from received to first staff reply (any reply, not just
// customer-facing ones) — see first_replied_at in db/index.js. Forward-
// looking only, so this can be sparse or empty for a while after deploy.
router.get('/first-response-trend', (req, res) => {
  const granularity = validateGranularity(req, res, PERIOD_GRANULARITIES);
  if (!granularity) return;
  res.json(repo.firstResponseTimeTrend(granularity));
});

// All-time snapshot, not a period trend — see resolutionTimeByPriority in
// db/repository.js for why this doesn't take a granularity param.
router.get('/resolution-by-priority', (req, res) => {
  res.json(repo.resolutionTimeByPriority());
});

// Open-count-at-end-of-period — see backlogTrend/backlogAtStmt in
// db/repository.js for the approximation this relies on.
router.get('/backlog-trend', (req, res) => {
  const granularity = validateGranularity(req, res, PERIOD_GRANULARITIES);
  if (!granularity) return;
  res.json(repo.backlogTrend(granularity));
});

// Unified received-vs-resolved volume KPI — day/week/month/quarter (no
// year; see volumeTrend in db/repository.js).
router.get('/volume-trend', (req, res) => {
  const granularity = validateGranularity(req, res, VOLUME_GRANULARITIES);
  if (!granularity) return;
  res.json(repo.volumeTrend(granularity));
});

// Status mix of enquiries *received* in the current month/fiscal-quarter/
// fiscal-year — a narrower window than /overview's byStatus (since
// TOTAL_SINCE, all of it). Shares the same month/quarter/year set as the
// other period-toggle panels (PERIOD_GRANULARITIES) — see the "global
// granularity" consolidation in Overview.jsx and statusByPeriod in
// db/repository.js.
router.get('/status-by-period', (req, res) => {
  const granularity = validateGranularity(req, res, PERIOD_GRANULARITIES);
  if (!granularity) return;
  res.json(repo.statusByPeriod(granularity));
});

// Diagnostic, not part of the Overview UI — the sender domains behind the
// "Not attributed" bucket, ranked by volume, so KNOWN_ORG_DOMAINS/
// GENERIC_DOMAINS in triage/classify.js can be recalibrated against real
// data instead of guessing. Visit directly (e.g. in a browser) when the
// "Not attributed" count looks high.
router.get('/unattributed-domains', (req, res) => {
  res.json(repo.unattributedDomains());
});

module.exports = router;
