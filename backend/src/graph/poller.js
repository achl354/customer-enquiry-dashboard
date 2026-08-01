const cron = require('node-cron');
const graphClient = require('./client');
const repo = require('../db/repository');
const { domainOf } = require('../triage/classify');

let lastPollAt = null;
let task = null;

function isGraphConfigured() {
  return graphClient.isConfigured();
}

/**
 * Re-check open enquiries against their current Outlook follow-up flag and
 * category tags, and sync into the dashboard status. Category wins first —
 * a "Resolved" or "No Action Needed" category is an explicit, unambiguous
 * "I'm done with this" the same way flag='complete' is, so it moves
 * straight to RESOLVED/IGNORED regardless of current status. Falls back to
 * the flag if no category is set: 'complete' also moves straight to
 * RESOLVED; 'flagged' only advances a still-untouched NEW enquiry to
 * IN_PROGRESS — none of these ever downgrade a more specific status staff
 * already have (e.g. WAITING_ON_CUSTOMER).
 */
async function syncFlagStatuses() {
  const open = repo.listOpenEnquiriesForFlagSync();
  if (open.length === 0) return { checked: 0, updated: 0 };

  const results = await graphClient.fetchMessageFlags(open.map((e) => e.graphMessageId));

  let updated = 0;
  for (const enquiry of open) {
    const info = results.get(enquiry.graphMessageId);
    const nextStatus = repo.statusForCategories(info?.categories) || repo.statusForFlag(info?.flagStatus);
    if (nextStatus === 'RESOLVED' || nextStatus === 'IGNORED') {
      repo.updateEnquiry(enquiry.id, { status: nextStatus });
      updated += 1;
    } else if (nextStatus === 'IN_PROGRESS' && enquiry.status === 'NEW') {
      repo.updateEnquiry(enquiry.id, { status: 'IN_PROGRESS' });
      updated += 1;
    }
  }

  return { checked: open.length, updated };
}

/**
 * Re-check open enquiries' conversationId against Sent Items — i.e. "has
 * staff already replied to or forwarded this?" — and advance status
 * accordingly: a customer-facing reply (recipients overlap the original
 * sender's domain) moves to WAITING_ON_CUSTOMER; a purely internal forward
 * moves to IN_PROGRESS. Same "only ever advance" rule as flag sync — this
 * never undoes a more specific status staff already set (statusForReply
 * handles that via STATUS_RANK).
 */
async function syncReplyStatuses() {
  const open = repo.listOpenEnquiriesForReplySync();
  if (open.length === 0) return { checked: 0, updated: 0 };

  const replies = await graphClient.fetchReplyStatus(
    open.map((e) => ({ graphMessageId: e.graphMessageId, conversationId: e.conversationId }))
  );

  let updated = 0;
  for (const enquiry of open) {
    const reply = replies.get(enquiry.graphMessageId);
    if (!reply || !reply.hasReply) continue;

    const isCustomerFacing = reply.recipients.some((addr) => domainOf(addr) === enquiry.senderDomain);
    const nextStatus = repo.statusForReply(isCustomerFacing, enquiry.status);
    if (nextStatus) {
      repo.updateEnquiry(enquiry.id, { status: nextStatus });
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
  const replySync = await syncReplyStatuses();

  lastPollAt = new Date().toISOString();
  return {
    fetched: messages.length,
    ingested,
    flagsChecked: flagSync.checked,
    flagsUpdated: flagSync.updated,
    repliesChecked: replySync.checked,
    repliesUpdated: replySync.updated,
    polledAt: lastPollAt,
  };
}

/**
 * Start a scheduled poll (default every minute — override with
 * POLL_CRON_EXPRESSION, e.g. '*\/5 * * * *' for every 5 minutes, if
 * per-minute polling turns out to be more than the mailbox's volume needs).
 * No-op if Graph credentials aren't configured, so the app runs fine in
 * demo/seed-only mode.
 */
function startScheduledPolling(cronExpression = process.env.POLL_CRON_EXPRESSION || '* * * * *') {
  if (!isGraphConfigured()) {
    console.log('[graph-poller] Not configured (missing TENANT_ID/CLIENT_ID/CLIENT_SECRET/MAILBOX) — skipping live polling.');
    return null;
  }
  task = cron.schedule(cronExpression, async () => {
    try {
      const result = await runPollOnce();
      console.log(
        `[graph-poller] Polled: fetched=${result.fetched} ingested=${result.ingested} flagsChecked=${result.flagsChecked} flagsUpdated=${result.flagsUpdated} repliesChecked=${result.repliesChecked} repliesUpdated=${result.repliesUpdated}`
      );
    } catch (err) {
      console.error('[graph-poller] Poll failed:', err.message);
    }
  });
  console.log(`[graph-poller] Scheduled polling started (${cronExpression}).`);
  return task;
}

module.exports = { isGraphConfigured, runPollOnce, syncFlagStatuses, syncReplyStatuses, startScheduledPolling };
