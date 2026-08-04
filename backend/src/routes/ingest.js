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

// lastModifiedDateTime/days_between are estimates, not confirmed archive
// data — labeled directly in the header text itself (not just in code
// comments or the README) so anyone opening the CSV cold sees the caveat
// without needing to go find documentation for it.
const FOLDER_MESSAGES_COLUMNS = [
  ['folder_id', (m) => m.folderId],
  ['folder_path', (m) => m.folderPath],
  ['subject', (m) => m.subject],
  ['sender', (m) => m.sender],
  ['recipients', (m) => m.recipients],
  ['receivedDateTime', (m) => m.receivedDateTime],
  ['lastModifiedDateTime (estimate - not a confirmed archive date)', (m) => m.lastModifiedDateTime || ''],
  ['days_between_received_and_modified (estimate)', (m) => daysBetween(m.receivedDateTime, m.lastModifiedDateTime)],
  ['hasAttachments', (m) => m.hasAttachments],
  ['conversationId', (m) => m.conversationId || ''],
  ['internetMessageId', (m) => m.internetMessageId || ''],
];

function daysBetween(receivedIso, modifiedIso) {
  if (!receivedIso || !modifiedIso) return '';
  const ms = new Date(modifiedIso).getTime() - new Date(receivedIso).getTime();
  return (ms / (1000 * 60 * 60 * 24)).toFixed(2);
}

// Shared by every endpoint below that takes a required "since" date —
// returns { error } (a ready-to-send 400 body) or { sinceIso }, never both.
function parseSinceParam(req) {
  const since = req.query.since || req.body?.since;
  if (!since) {
    return { error: 'Missing required "since" param — e.g. ?since=2026-07-01' };
  }
  if (Number.isNaN(new Date(since).getTime())) {
    return { error: `"since" is not a valid date: ${since}` };
  }
  return { sinceIso: new Date(since).toISOString(), sinceRaw: since };
}

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
  const { error, sinceIso } = parseSinceParam(req);
  if (error) return res.status(400).json({ error });
  try {
    const result = await backfillAllFoldersAndReassess(sinceIso);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full audit pull, read-only — every message received on/after `since`
// from every folder in the mailbox, CSV out. Does NOT touch this app's own
// database (unlike /backfill-all-folders, which ingests); this is purely a
// reporting export. See the README section on this for the estimate
// caveat around lastModifiedDateTime/days_between_received_and_modified —
// also labeled directly in the CSV's own column headers below.
//
// Same long-running caveat as /backfill-all-folders: ~380 folders,
// sequential, real network calls each. Watch server logs
// (fetchAllFolderMessagesSince logs progress every 25 folders) rather than
// assuming a timed-out HTTP response means the pull stopped.
router.get('/folder-messages', async (req, res) => {
  if (!isGraphConfigured()) {
    return res.status(400).json({ error: 'Microsoft Graph is not configured. Set TENANT_ID, CLIENT_ID, CLIENT_SECRET, MAILBOX in .env' });
  }
  const { error, sinceIso, sinceRaw } = parseSinceParam(req);
  if (error) return res.status(400).json({ error });
  const mailbox = req.query.mailbox || process.env.MAILBOX;
  try {
    const { messages, folderErrors, foldersChecked } = await graphClient.fetchAllFolderMessagesSince(mailbox, sinceIso);
    const receivedDates = messages.map((m) => m.receivedDateTime).filter(Boolean).sort();

    console.log(
      `[ingest] folder-messages: foldersChecked=${foldersChecked} messagesFound=${messages.length} ` +
      `foldersErrored=${folderErrors.length} oldest=${receivedDates[0] || 'n/a'} newest=${receivedDates[receivedDates.length - 1] || 'n/a'}`
    );
    if (folderErrors.length > 0) {
      console.warn('[ingest] folder-messages: folders that errored:', JSON.stringify(folderErrors));
    }

    const filenameSafeSince = String(sinceRaw).replace(/[^0-9A-Za-z-]/g, '');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="messages_since_${filenameSafeSince}.csv"`);
    res.set('X-Folders-Checked', String(foldersChecked));
    res.set('X-Messages-Found', String(messages.length));
    res.set('X-Folders-Errored', String(folderErrors.length));
    if (receivedDates.length > 0) {
      res.set('X-Oldest-Received', receivedDates[0]);
      res.set('X-Newest-Received', receivedDates[receivedDates.length - 1]);
    }
    res.send(toCsv(FOLDER_MESSAGES_COLUMNS, messages));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
