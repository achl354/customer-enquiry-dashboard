const cron = require('node-cron');
const graphClient = require('./client');
const repo = require('../db/repository');

let lastPollAt = null;
let task = null;

function isGraphConfigured() {
  return graphClient.isConfigured();
}

async function runPollOnce() {
  const sinceIso = lastPollAt;
  const messages = await graphClient.fetchMessagesSince(sinceIso);

  let ingested = 0;
  for (const raw of messages) {
    const id = repo.ingestEmail(raw);
    if (id) ingested += 1;
  }

  lastPollAt = new Date().toISOString();
  return { fetched: messages.length, ingested, polledAt: lastPollAt };
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
      console.log(`[graph-poller] Polled: fetched=${result.fetched} ingested=${result.ingested}`);
    } catch (err) {
      console.error('[graph-poller] Poll failed:', err.message);
    }
  });
  console.log(`[graph-poller] Scheduled polling started (${cronExpression}).`);
  return task;
}

module.exports = { isGraphConfigured, runPollOnce, startScheduledPolling };
