const express = require('express');
const { runPollOnce, backfillAllFoldersAndReassess, getBackfillStatus, isGraphConfigured } = require('../graph/poller');
const graphClient = require('../graph/client');
const aiClassifier = require('../ai/classifier');
const { csvField, toCsv } = require('../utils/csv');

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

// The folders actually in day-to-day use, per the Outlook mobile
// "Favorites" sidebar — confirmed by name against a real folder_map.csv
// pull (all 32 matched an existing displayName with no ambiguity). ~380
// folders exist in total, but most are stale/historical (old rep
// archives, one-off restores) — walking all of them for every audit
// export is both slow (the actual cause of requests not completing) and
// mostly noise. This is the default scope for /folder-messages; pass
// ?allFolders=true to fall back to the full walk.
const ACTIVE_FOLDER_NAMES = [
  'Product request',
  '1. CUST SERVICE EMAILS',
  '0. Info & Promotions',
  '3. REPS + STAFF',
  'FREIGHT',
  '2. COMPANY INTERNAL',
  'NDIS',
  "4. NSW PO's",
  "5. VIC PO's",
  "7. SA PO's",
  "6. QLD PO's",
  "9. NT PO's",
  "8. TAS PO's",
  "10. WA PO's",
  '12. OSTOMY ORDERS',
  '11. ONLINE ORDERS',
  '13. RENTALS',
  '14. ACTIVTEC/AneticAid/MOVETEC',
  '14.5 BMB',
  '15. Faulty / Return Paperwork',
  '16. Price Lists',
  '18. NZ Orders',
  '17. Campaign Queries',
  '19. Freight Spreadsheets',
  '20. LOAN TRIAL PAPERWORK',
  '21. HoverTech',
  '22. REPAIRS',
  "23. POD's",
  '24. GATEWAY REHAB / PSB',
  'Roller Blind Orders',
  'PAULA',
  'SCOTT',
];

// Matches by trimmed displayName against an already-fetched folder tree —
// pure local filtering, never a fresh Graph name lookup (that's exactly
// the unreliable path this whole feature exists to avoid). Logs anything
// in ACTIVE_FOLDER_NAMES that doesn't match a real folder (renamed,
// deleted) rather than silently dropping it.
function filterToActiveFolders(folders) {
  const wanted = new Set(ACTIVE_FOLDER_NAMES.map((n) => n.trim().toLowerCase()));
  const matched = folders.filter((f) => wanted.has(f.displayName.trim().toLowerCase()));
  const matchedNames = new Set(matched.map((f) => f.displayName.trim().toLowerCase()));
  const missing = ACTIVE_FOLDER_NAMES.filter((n) => !matchedNames.has(n.trim().toLowerCase()));
  if (missing.length > 0) {
    console.warn('[ingest] filterToActiveFolders: no folder matched these names (renamed or deleted?):', JSON.stringify(missing));
  }
  return matched;
}

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

// Strips accidental leading/trailing quote characters — an email address
// never legitimately contains one, but MAILBOX is easy to enter with
// quotes by habit in a hosting dashboard's raw env var field (unlike a
// .env file, most of those don't strip them), and a query param can pick
// one up depending on how a URL got quoted/pasted on the way in. Graph
// itself surfaces this unhelpfully — "ErrorIncorrectRoutingHint", not
// anything that says "check for a stray quote" — so this is cheap
// insurance against a confusing failure rather than a fix for a
// specific confirmed cause.
function resolveMailbox(req) {
  const raw = req.query.mailbox || process.env.MAILBOX || '';
  return raw.trim().replace(/^['"]+|['"]+$/g, '');
}

router.get('/status', (req, res) => {
  res.json({
    graphConfigured: isGraphConfigured(),
    aiConfigured: aiClassifier.isConfigured(),
    mailbox: resolveMailbox({ query: {} }) || null,
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
  const mailbox = resolveMailbox(req);
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
// Fires the job and responds immediately (202) rather than waiting for the
// whole run to finish — a wide window over hundreds/thousands of messages,
// each reclassified sequentially, can easily outlast what a proxy in front
// of this app will hold one idle connection open for. Waiting on it here
// previously meant a perfectly successful run could still show up
// client-side as a bare "failed to fetch" once that timeout hit, with no
// way to tell a real failure apart from a slow one. Poll GET
// /backfill-status instead — see getBackfillStatus in graph/poller.js.
router.post('/backfill-all-folders', async (req, res) => {
  if (!isGraphConfigured()) {
    return res.status(400).json({ error: 'Microsoft Graph is not configured. Set TENANT_ID, CLIENT_ID, CLIENT_SECRET, MAILBOX in .env' });
  }
  const { error, sinceIso } = parseSinceParam(req);
  if (error) return res.status(400).json({ error });

  if (getBackfillStatus().running) {
    return res.status(202).json({
      started: false,
      running: true,
      message: 'A backfill is already running. Poll GET /api/ingest/backfill-status for progress.',
    });
  }

  backfillAllFoldersAndReassess(sinceIso).catch((err) => {
    console.error('[ingest] backfill-all-folders: failed:', err.message);
  });

  res.status(202).json({
    started: true,
    message: 'Backfill started in the background. Poll GET /api/ingest/backfill-status for progress and the final result.',
  });
});

// Poll this after POSTing /backfill-all-folders. `running: true` while it's
// still going; once it flips to false, `lastResult` holds the final
// {fetched, ingested, failedIngest, reassessed, reclassified, failed}
// summary (or {error} if the run failed outright).
router.get('/backfill-status', (req, res) => {
  res.json(getBackfillStatus());
});

// Full audit pull, read-only — every message received on/after `since`,
// CSV out. Does NOT touch this app's own database (unlike
// /backfill-all-folders, which ingests); this is purely a reporting
// export. See the README section on this for the estimate caveat around
// lastModifiedDateTime/days_between_received_and_modified — also labeled
// directly in the CSV's own column headers below.
//
// Defaults to just ACTIVE_FOLDER_NAMES (~32 folders) rather than the full
// ~380 — most of the rest are stale (old rep archives, one-off restores),
// and walking all of them sequentially is exactly what made earlier runs
// take too long to ever finish downloading. Pass ?allFolders=true for the
// full walk.
//
// Streamed row-by-row as each folder completes rather than buffered until
// the whole walk finishes — even at the smaller ~32-folder scope this
// keeps the connection active throughout instead of one big response at
// the end, which is what let a slow run go from "downloading" to "just
// gone" if a proxy timed out the idle connection before anything was ever
// sent.
router.get('/folder-messages', async (req, res) => {
  if (!isGraphConfigured()) {
    return res.status(400).json({ error: 'Microsoft Graph is not configured. Set TENANT_ID, CLIENT_ID, CLIENT_SECRET, MAILBOX in .env' });
  }
  const { error, sinceIso, sinceRaw } = parseSinceParam(req);
  if (error) return res.status(400).json({ error });
  const mailbox = resolveMailbox(req);
  const allFolders = req.query.allFolders === 'true' || req.query.allFolders === '1';

  let folders;
  try {
    const fullTree = await graphClient.fetchFolderTree(mailbox);
    folders = allFolders ? fullTree : filterToActiveFolders(fullTree);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const filenameSafeSince = String(sinceRaw).replace(/[^0-9A-Za-z-]/g, '');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="messages_since_${filenameSafeSince}.csv"`);
  res.set('X-Folders-Checked', String(folders.length));
  res.write(FOLDER_MESSAGES_COLUMNS.map(([header]) => csvField(header)).join(',') + '\n');

  const receivedDates = [];
  let totalMessages = 0;
  try {
    const { folderErrors } = await graphClient.fetchAllFolderMessagesSince(mailbox, sinceIso, {
      folders,
      onFolderMessages: (folderMessages) => {
        for (const m of folderMessages) {
          res.write(FOLDER_MESSAGES_COLUMNS.map(([, get]) => csvField(get(m))).join(',') + '\n');
          totalMessages += 1;
          if (m.receivedDateTime) receivedDates.push(m.receivedDateTime);
        }
      },
    });
    receivedDates.sort();
    console.log(
      `[ingest] folder-messages: foldersChecked=${folders.length} messagesFound=${totalMessages} ` +
      `foldersErrored=${folderErrors.length} oldest=${receivedDates[0] || 'n/a'} newest=${receivedDates[receivedDates.length - 1] || 'n/a'}`
    );
    if (folderErrors.length > 0) {
      console.warn('[ingest] folder-messages: folders that errored:', JSON.stringify(folderErrors));
    }
  } catch (err) {
    // Headers (and possibly some rows) are already sent at this point, so
    // a clean JSON error response is no longer possible — log it and just
    // end the stream with whatever was captured so far.
    console.error('[ingest] folder-messages: failed mid-stream:', err.message);
  }
  res.end();
});

module.exports = router;
