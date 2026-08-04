const cron = require('node-cron');
const graphClient = require('./client');
const repo = require('../db/repository');
const { domainOf } = require('../triage/classify');

let lastPollAt = null;
let task = null;
// Guards against a scheduled cron tick and a manual POST /api/ingest/run
// (or two overlapping cron ticks, if a poll ever runs longer than the
// interval) both calling runPollOnce() at once. ingestEmail() only skips
// classification for messages already committed to the DB — while two
// passes are both mid-flight for the same not-yet-ingested message, both
// would pass that check and both would pay for classification. Concurrent
// callers get the same in-flight promise instead of starting a second pass.
let pollInFlight = null;

function isGraphConfigured() {
  return graphClient.isConfigured();
}

/**
 * Re-check open enquiries against their current Outlook folder location,
 * follow-up flag, and category tags, and sync into the dashboard status.
 * Category wins first — a "Resolved" or "No Action Needed" category is an
 * explicit, unambiguous "I'm done with this," so it moves straight to
 * RESOLVED/IGNORED regardless of current status (e.g. "No Action Needed"
 * applied before archiving still resolves to IGNORED, not RESOLVED, since
 * this is checked before the folder-move signal below ever gets a look).
 * Next, a move out of Inbox (confirmed directly with staff as their actual
 * filing habit — see statusForFolderMove) moves straight to RESOLVED.
 * Falls back to the flag if neither is set: 'complete' also moves straight
 * to RESOLVED; 'flagged' only advances a still-untouched NEW enquiry to
 * IN_PROGRESS — none of these ever downgrade a more specific status staff
 * already have (e.g. WAITING_ON_CUSTOMER).
 *
 * If the message itself is confirmed gone (its id no longer resolves at
 * all via Graph — see fetchMessageFlags) and none of the above already
 * resolved it, that's treated the same as a folder move: RESOLVED. In this
 * mailbox a message going fully unreachable is what archiving looks like
 * one step further along, not evidence of unconfirmed loss.
 */
async function syncFlagStatuses() {
  const open = repo.listOpenEnquiriesForFlagSync();
  if (open.length === 0) return { checked: 0, updated: 0 };

  const results = await graphClient.fetchMessageFlags(open.map((e) => e.graphMessageId));

  let updated = 0;
  for (const enquiry of open) {
    const info = results.get(enquiry.graphMessageId);
    const nextStatus =
      repo.statusForCategories(info?.categories) ||
      repo.statusForFolderMove(info?.movedOutOfInbox) ||
      repo.statusForFlag(info?.flagStatus) ||
      repo.statusForMissingMessage(info?.missing);
    if (nextStatus === 'RESOLVED' || nextStatus === 'IGNORED') {
      const patch = { status: nextStatus };
      // lastModifiedDateTime is Graph's own record of when the message was
      // actually last touched (a folder move counts) — a real historical
      // timestamp, unlike our own updated_at which just reflects whenever
      // this poll cycle happened to run. Absent for the statusForMissingMessage
      // path (message unreachable, nothing left to ask Graph about) — left
      // null there rather than guessed at; see resolutionStatsStmt.
      if (nextStatus === 'RESOLVED' && info?.lastModifiedDateTime) {
        patch.resolvedAt = info.lastModifiedDateTime;
      }
      repo.updateEnquiry(enquiry.id, patch);
      updated += 1;
    } else if (nextStatus === 'IN_PROGRESS' && enquiry.status === 'NEW') {
      repo.updateEnquiry(enquiry.id, { status: 'IN_PROGRESS' });
      updated += 1;
    }
  }

  return { checked: open.length, updated };
}

/**
 * Repair pass for RESOLVED enquiries that don't have resolved_at yet —
 * either resolved before that column existed, or resolved on a poll cycle
 * where the message came back missing at that exact moment (transient
 * failure, not necessarily gone for good). Re-fetches lastModifiedDateTime
 * for each and sets it if the message still resolves. A message that's
 * confirmed gone for good stays resolved_at: null permanently — there's
 * nothing left to ask Graph about, and this list only shrinks over time as
 * more of it succeeds, never grows (see listResolvedEnquiriesMissingResolvedAt),
 * so re-checking the same small leftover set each poll is a deliberately
 * accepted cost rather than worth adding retry-limiting complexity for.
 */
async function backfillResolvedAt() {
  const candidates = repo.listResolvedEnquiriesMissingResolvedAt();
  if (candidates.length === 0) return { checked: 0, updated: 0 };

  const results = await graphClient.fetchMessageFlags(candidates.map((e) => e.graphMessageId));

  let updated = 0;
  for (const enquiry of candidates) {
    const info = results.get(enquiry.graphMessageId);
    if (info?.lastModifiedDateTime) {
      repo.updateEnquiry(enquiry.id, { resolvedAt: info.lastModifiedDateTime });
      updated += 1;
    }
  }

  return { checked: candidates.length, updated };
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

function runPollOnce() {
  if (pollInFlight) return pollInFlight;

  pollInFlight = (async () => {
    const sinceIso = lastPollAt;
    const isBackfill = sinceIso == null;
    const messages = await graphClient.fetchMessagesSince(sinceIso);

    let ingested = 0;
    for (const raw of messages) {
      const id = await repo.ingestEmail(raw);
      if (id) ingested += 1;
    }

    const flagSync = await syncFlagStatuses();
    const replySync = await syncReplyStatuses();
    const resolvedAtBackfill = await backfillResolvedAt();

    lastPollAt = new Date().toISOString();
    return {
      isBackfill,
      fetched: messages.length,
      ingested,
      flagsChecked: flagSync.checked,
      flagsUpdated: flagSync.updated,
      repliesChecked: replySync.checked,
      repliesUpdated: replySync.updated,
      resolvedAtChecked: resolvedAtBackfill.checked,
      resolvedAtBackfilled: resolvedAtBackfill.updated,
      polledAt: lastPollAt,
    };
  })().finally(() => {
    pollInFlight = null;
  });

  return pollInFlight;
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
      const label = result.isBackfill ? 'Backfill' : 'Polled';
      console.log(
        `[graph-poller] ${label}: fetched=${result.fetched} ingested=${result.ingested} flagsChecked=${result.flagsChecked} flagsUpdated=${result.flagsUpdated} repliesChecked=${result.repliesChecked} repliesUpdated=${result.repliesUpdated}`
      );
    } catch (err) {
      console.error('[graph-poller] Poll failed:', err.message);
    }
  });
  console.log(`[graph-poller] Scheduled polling started (${cronExpression}).`);
  return task;
}

module.exports = { isGraphConfigured, runPollOnce, syncFlagStatuses, syncReplyStatuses, startScheduledPolling };
