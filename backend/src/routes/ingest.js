const express = require('express');
const { runPollOnce, backfillAllFoldersAndReassess, isGraphConfigured } = require('../graph/poller');
const graphClient = require('../graph/client');
const aiClassifier = require('../ai/classifier');
const { toCsv } = require('../utils/csv');

const router = express.Router();

const FOLDER_MAP_COLUMNS = [
  ['id', (f) => f.id],
  ['displayName', (f) => f.displayName],
  ['full_path', (f) => f.fullPath],
  ['parentFolderId', (f) => f.parentFolderId || ''],
  ['childFolderCount', (f) => f.childFolderCount],
  ['totalItemCount', (f) => f.totalItemCount],
  ['unreadItemCount', (f) => f.unreadItemCount],
];

router.get('/status', (req, res) => {
  res.json({
    graphConfigured: isGraphConfigured(),
    aiConfigured: aiClassifier.isConfigured(),
    mailbox: process.env.MAILBOX || null,
  });
});

// Read-only tree walk (GET, not POST — nothing here writes to the database
// or the mailbox). Defaults to the mailbox this app already polls; ?mailbox=
// only matters if you want to check a different one — Graph's own
// Application Access Policy is the real boundary on what's actually
// reachable, this is just which address to ask for.
//
// Deliberately by id, never by displayName — see fetchFolderTree's own
// comment for why name-based lookup was tested and found unreliable
// against this exact mailbox.
router.get('/folder-map', async (req, res) => {
  if (!isGraphConfigured()) {
    return res.status(400).json({ error: 'Microsoft Graph is not configured. Set TENANT_ID, CLIENT_ID, CLIENT_SECRET, MAILBOX in .env' });
  }
  const mailbox = req.query.mailbox || process.env.MAILBOX;
  try {
    const folders = await graphClient.fetchFolderTree(mailbox);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="folder_map.csv"`);
    res.send(toCsv(FOLDER_MAP_COLUMNS, folders));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/run', async (req, res) => {
  if (!isGraphConfigured()) {
    return res.status(400).json({ error: 'Microsoft Graph is not configured. Set TENANT_ID, CLIENT_ID, CLIENT_SECRET, MAILBOX in .env' });
  }
  try {
    const result = await runPollOnce();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One-time historical catch-up + reassessment — see the README section on
// this. `since` is required (no default) so this can never accidentally
// run against the mailbox's entire history — pass an ISO date/datetime,
// e.g. ?since=2026-07-01. Deliberately not wired into the scheduled poll;
// every enquiry received on/after `since` gets reclassified (a real AI
// call each, if configured), so this should only run when someone
// actually triggers it, not automatically on every deploy/restart.
//
// Can take a long time for a wide window — every ingested/reclassified
// enquiry is a real network call, done sequentially. The work itself
// keeps running server-side to completion even if this HTTP response
// times out on a proxy in front of it; check server logs for
// backfillAllFoldersAndReassess's progress lines, then re-check the
// dashboard, rather than assuming a timed-out request means it stopped.
router.post('/backfill-all-folders', async (req, res) => {
  if (!isGraphConfigured()) {
    return res.status(400).json({ error: 'Microsoft Graph is not configured. Set TENANT_ID, CLIENT_ID, CLIENT_SECRET, MAILBOX in .env' });
  }
  const since = req.query.since || req.body?.since;
  if (!since) {
    return res.status(400).json({ error: 'Missing required "since" param — e.g. POST /api/ingest/backfill-all-folders?since=2026-07-01' });
  }
  if (Number.isNaN(new Date(since).getTime())) {
    return res.status(400).json({ error: `"since" is not a valid date: ${since}` });
  }
  try {
    const result = await backfillAllFoldersAndReassess(new Date(since).toISOString());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
