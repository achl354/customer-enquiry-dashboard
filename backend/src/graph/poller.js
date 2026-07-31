const cron = require('node-cron');
const graphClient = require('./client');
const repo = require('../db/repository');

let lastPollAt = null;
let task = null;

function isGraphConfigured() {
  return graphClient.isConfigured();
}

/**
 * Re-check open enquiries against their current Outlook follow-up flag and
 * sync it into the dashboard status. 'complete' always wins (the strongest
 * signal a human is done with this thread) and moves straight to RESOLVED
 * regardless of current status. 'flagged' only advances a still-untouched
 * NEW enquiry to IN_PROGRESS — it never downgrades a more specific status
 * staff already set themselves (e.g. WAITING_ON_CUSTOMER).
 */
async function syncFlagStatuses() {
  const open = repo.listOpenEnquiriesForFlagSync();
  if (open.length === 0) return { checked: 0, updated: 0 };

  const flags = await graphClient.fetchMessageFlags(open.map((e) => e.graphMessageId));

  let updated = 0;
  for (const enquiry of open) {
    const nextStatus = repo.statusForFlag(flags.get(enquiry.graphMessageId));
    if (nextStatus === 'RESOLVED' && enquiry.status !== 'RESOLVED') {
      repo.updateEnquiry(enquiry.id, { status: 'RESOLVED' });
      updated += 1;
    } else if (nextStatus === 'IN_PROGRESS' && enquiry.status === 'NEW') {
      repo.updateEnquiry(enquiry.id, { status: 'IN_PROGRESS' });
      updated += 1;
    }
  }

  return { checked: open.length, updated };
}

async function runPollOnce() {
  const sinceIso = lastPollAt;
  const messages = await graphClient.fetchMessagesSince(sinceIso);

  let ingested = 0;
  for (const raw of messages) {
    const id = await repo.ingestEmail(raw);
    if (id) ingested += 1;
  }

  const flagSync = await syncFlagStatuses();

  lastPollAt = new Date().toISOString();
  return {
    fetched: messages.length,
    ingested,
    flagsChecked: flagSync.checked,
    flagsUpdated: flagSync.updated,
    polledAt: lastPollAt,
  };
}

/**
 * Start a scheduled poll (default every 5 minutes). No-op if Graph credentials
 * aren't configured, so the app runs fine in demo/seed-only mode.
 */
function startScheduledPolling(cronExpression = '*/5 * * * *') {
  if (!isGraphConfigured()) {
    console.log('[graph-poller] Not configured (missing TENANT_ID/CLIENT_ID/CLIENT_SECRET/MAILBOX) — skipping live polling.');
    return null;
  }
  task = cron.schedule(cronExpression, async () => {
    try {
      const result = await runPollOnce();
      console.log(
        `[graph-poller] Polled: fetched=${result.fetched} ingested=${result.ingested} flagsChecked=${result.flagsChecked} flagsUpdated=${result.flagsUpdated}`
      );
    } catch (err) {
      console.error('[graph-poller] Poll failed:', err.message);
    }
  });
  console.log(`[graph-poller] Scheduled polling started (${cronExpression}).`);
  return task;
}

module.exports = { isGraphConfigured, runPollOnce, syncFlagStatuses, startScheduledPolling };
