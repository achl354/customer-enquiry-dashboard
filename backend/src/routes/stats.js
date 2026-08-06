const express = require('express');
const repo = require('../db/repository');

const router = express.Router();

const PERIOD_GRANULARITIES = ['month', 'quarter', 'year'];
const VOLUME_GRANULARITIES = ['day', 'week', 'month', 'quarter'];
const CATEGORY_TREND_GRANULARITIES = ['day', 'week', 'month', 'year'];

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
// db/repository.js for why this doesn't take a granularity param. Same
// optional ?sla=<hours> threshold as /resolution-trend (default 24,
// matching Urgent's "max acceptable resolution time" target).
router.get('/resolution-by-priority', (req, res) => {
  const slaHours = req.query.sla !== undefined ? Number(req.query.sla) : undefined;
  if (slaHours !== undefined && (Number.isNaN(slaHours) || slaHours <= 0)) {
    return res.status(400).json({ error: `Invalid "sla" hours: ${req.query.sla}` });
  }
  res.json(repo.resolutionTimeByPriority(slaHours));
});

// All-time snapshot of first-response time broken out by priority — same
// shape as resolution-by-priority, no SLA column (see
// firstResponseTimeByPriority in db/repository.js).
router.get('/first-response-by-priority', (req, res) => {
  res.json(repo.firstResponseTimeByPriority());
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

// Received volume broken out by category per period — day/week/month —
// behind the "Enquiries by category" trend chart. Every row's categories
// are zero-filled across every known category (see categoryTrend in
// db/repository.js), so a category with zero enquiries in a given period
// is a real 0, not a missing key.
router.get('/category-trend', (req, res) => {
  const granularity = validateGranularity(req, res, CATEGORY_TREND_GRANULARITIES);
  if (!granularity) return;
  res.json(repo.categoryTrend(granularity));
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

// Follow-up diagnostic to the one above — the category split for a single
// unattributed sender domain, e.g. ?domain=jdhealthcare.com.au. Tells you
// whether that domain's "Not attributed" volume is genuinely internal mail
// (facility doesn't apply) or customer-facing categories with an internal
// sender (facility extraction is missing something real). See
// unattributedDomainCategories in db/repository.js.
router.get('/unattributed-domain-categories', (req, res) => {
  const domain = req.query.domain;
  if (!domain) {
    return res.status(400).json({ error: 'Missing required "domain" query param.' });
  }
  res.json(repo.unattributedDomainCategories(domain));
});

module.exports = router;
