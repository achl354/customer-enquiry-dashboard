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
 *
 * Also captures first_replied_at the first time any reply is detected
 * (customer-facing or internal forward — "how fast did someone touch this
 * at all" doesn't care which kind) — set once, from Graph's own
 * sentDateTime, and never overwritten on later polls even as more replies
 * accumulate. Forward-looking only: an enquiry that already had a reply
 * before this column existed has no way to recover when that first reply
 * actually happened.
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

    const patch = {};
    if (!enquiry.firstRepliedAt && reply.firstReplyAt) {
      patch.firstRepliedAt = reply.firstReplyAt;
    }

    const isCustomerFacing = reply.recipients.some((addr) => domainOf(addr) === enquiry.senderDomain);
    const nextStatus = repo.statusForReply(isCustomerFacing, enquiry.status);
    if (nextStatus) patch.status = nextStatus;

    if (Object.keys(patch).length > 0) {
      repo.updateEnquiry(enquiry.id, patch);
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

    // syncReplyStatuses before syncFlagStatuses, not the reverse — both only
    // look at currently-open enquiries, and staff's real workflow is often
    // "reply, then immediately file the email into a folder" (the folder
    // move signal syncFlagStatuses acts on) within the same poll interval.
    // Flag-sync running first would close the enquiry out before reply-sync
    // ever got a chance to see it as open, permanently losing first_replied_at
    // for that enquiry — listOpenEnquiriesForReplySync() would never surface
    // it again once closed. Checking replies first means first_replied_at is
    // already captured by the time (if any) this same tick's flag-sync closes it.
    const replySync = await syncReplyStatuses();
    const flagSync = await syncFlagStatuses();
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

let backfillInFlight = null;
// Surfaced via getBackfillStatus() below so a caller can fire the job and
// poll for completion instead of holding one HTTP connection open for the
// whole run — a run over hundreds/thousands of messages can easily outlast
// what a proxy in front of this app will keep an idle connection alive for,
// which previously showed up client-side as a bare "failed to fetch" even
// though the job itself ran to completion on the server regardless.
let lastBackfillResult = null;
let lastBackfillFinishedAt = null;

/**
 * One-time historical catch-up, NOT part of regular polling — pulls mail
 * from every folder (not just Inbox — see fetchAllMailboxMessagesSince)
 * received since `sinceIso`, ingests anything not already in the database,
 * then reassesses (reclassifies) every enquiry received since that date
 * regardless of its current category or classifiedBy, including ones
 * staff already manually corrected. See routes/ingest.js's
 * /backfill-all-folders, the only thing that calls this.
 *
 * Deliberately not automatic: unlike the per-minute poll, every
 * reclassification is a real classification call (AI cost when
 * configured), and re-running it against mail already correctly
 * categorized has no benefit — this should only run when someone actually
 * has a reason to (see the readme section on this).
 *
 * `untilIso` is an optional, exclusive upper bound — pass it to re-check a
 * specific bounded window (e.g. a date range an earlier run is suspected
 * to have missed) instead of re-pulling everything since `sinceIso` all
 * the way through today. Note the in-flight guard below is a single slot
 * keyed on nothing, not per-args — a second call with a different
 * sinceIso/untilIso while one's already running gets back the *first*
 * call's promise/result, not its own. Fine for this app's actual usage
 * (one operator manually triggering one backfill at a time), but worth
 * knowing if that ever stops being true.
 */
async function backfillAllFoldersAndReassess(sinceIso, untilIso) {
  if (backfillInFlight) return backfillInFlight;

  backfillInFlight = (async () => {
    const messages = await graphClient.fetchAllMailboxMessagesSince(sinceIso, untilIso);

    // Per-message try/catch, same as the reclassify loop below — one bad
    // message (a transient Graph hiccup, an unexpected shape) previously
    // threw straight out of this whole function and silently skipped every
    // message after it, including the entire reclassify pass beneath it.
    let ingested = 0;
    let failedIngest = 0;
    for (const raw of messages) {
      try {
        const id = await repo.ingestEmail(raw);
        if (id) ingested += 1;
      } catch (err) {
        failedIngest += 1;
        console.error('[graph-poller] backfillAllFoldersAndReassess: ingest failed for a message:', err.message);
      }
    }
    console.log(`[graph-poller] backfillAllFoldersAndReassess: ingested ${ingested}/${messages.length} new (rest already existed, ${failedIngest} failed)`);

    const candidates = repo.listEnquiriesReceivedSince(sinceIso, untilIso);
    let reclassified = 0;
    let failed = 0;
    for (const row of candidates) {
      try {
        await repo.reclassifyEnquiry(row);
        reclassified += 1;
      } catch (err) {
        failed += 1;
        console.error(`[graph-poller] backfillAllFoldersAndReassess: reclassify failed for ${row.id}:`, err.message);
      }
      if (reclassified % 25 === 0) {
        console.log(`[graph-poller] backfillAllFoldersAndReassess: reclassified ${reclassified}/${candidates.length}`);
      }
    }

    return { fetched: messages.length, ingested, failedIngest, reassessed: candidates.length, reclassified, failed };
  })()
    .then((result) => {
      lastBackfillResult = { ...result, error: null };
      return result;
    })
    .catch((err) => {
      lastBackfillResult = { error: err.message };
      throw err;
    })
    .finally(() => {
      lastBackfillFinishedAt = new Date().toISOString();
      backfillInFlight = null;
    });

  return backfillInFlight;
}

/** Polled by GET /api/ingest/backfill-status — see the comment above backfillInFlight. */
function getBackfillStatus() {
  return {
    running: backfillInFlight !== null,
    lastResult: lastBackfillResult,
    lastFinishedAt: lastBackfillFinishedAt,
  };
}

// Own in-flight slot, separate from backfillInFlight above — this is a much
// smaller, targeted job (one facility's enquiries, no Graph fetch at all,
// since it only reassesses rows already in the database) rather than a
// mailbox-wide catch-up, so it doesn't need to share a lock with it. Same
// "one operator, one job at a time" assumption as the backfill guard,
// though: triggering this at the same time as a full backfill could still
// double-call the classifier on any row both happen to cover.
let facilityReclassifyInFlight = null;
let lastFacilityReclassifyResult = null;
let lastFacilityReclassifyFinishedAt = null;

/**
 * Re-run classification against every enquiry currently attributed to one
 * facility — the "Reclassify" action on the Top facilities panel, for when
 * staff notice one customer's mail keeps landing in the wrong category.
 * Purely a DB operation, no Graph call: facility is extracted at ingestion
 * time and already stored, so there's nothing to re-fetch, just
 * reclassifyEnquiry() re-run over the matching rows (see
 * backfillAllFoldersAndReassess above for the same reassess step at
 * mailbox scope). Same fire-and-poll shape as that job, for the same
 * reason — a facility with enough history can still be dozens of real AI
 * calls, easily enough to outlast a proxy's idle-connection timeout.
 */
async function reclassifyByFacility(facility) {
  if (facilityReclassifyInFlight) return facilityReclassifyInFlight;

  facilityReclassifyInFlight = (async () => {
    const candidates = repo.listEnquiriesByFacility(facility);
    let reclassified = 0;
    let failed = 0;
    for (const row of candidates) {
      try {
        await repo.reclassifyEnquiry(row);
        reclassified += 1;
      } catch (err) {
        failed += 1;
        console.error(`[graph-poller] reclassifyByFacility(${facility}): reclassify failed for ${row.id}:`, err.message);
      }
    }
    return { facility, reassessed: candidates.length, reclassified, failed };
  })()
    .then((result) => {
      lastFacilityReclassifyResult = { ...result, error: null };
      return result;
    })
    .catch((err) => {
      lastFacilityReclassifyResult = { facility, error: err.message };
      throw err;
    })
    .finally(() => {
      lastFacilityReclassifyFinishedAt = new Date().toISOString();
      facilityReclassifyInFlight = null;
    });

  return facilityReclassifyInFlight;
}

/** Polled by GET /api/ingest/reclassify-by-facility-status — see the comment above facilityReclassifyInFlight. */
function getFacilityReclassifyStatus() {
  return {
    running: facilityReclassifyInFlight !== null,
    lastResult: lastFacilityReclassifyResult,
    lastFinishedAt: lastFacilityReclassifyFinishedAt,
  };
}

// Own in-flight slot — same "one operator, one job at a time" assumption as
// the other one-off jobs above, not shared with any of them.
let firstRepliedAtBackfillInFlight = null;
let lastFirstRepliedAtBackfillResult = null;
let lastFirstRepliedAtBackfillFinishedAt = null;

/**
 * One-off repair pass for closed enquiries missing first_replied_at — see
 * listClosedEnquiriesMissingFirstRepliedAt in db/repository.js for exactly
 * which rows this targets and why they exist (the poll-ordering race fixed
 * in runPollOnce above). Re-checks Sent Items for each one's
 * conversationId via the same fetchReplyStatus call syncReplyStatuses uses,
 * and sets first_replied_at where a reply is found. Status is never
 * touched here — these enquiries are already closed, this only recovers
 * the one timestamp that got missed.
 *
 * Same fire-and-poll shape as backfillAllFoldersAndReassess — a mailbox
 * with a lot of affected history could mean many Graph batch calls, easily
 * enough to outlast a proxy's idle-connection timeout. See
 * routes/ingest.js's /backfill-first-replied-at, the only thing that calls
 * this. Deliberately not automatic/scheduled — this is a one-time repair
 * for a bug that's now fixed going forward, not an ongoing job.
 */
async function backfillFirstRepliedAt() {
  if (firstRepliedAtBackfillInFlight) return firstRepliedAtBackfillInFlight;

  firstRepliedAtBackfillInFlight = (async () => {
    const candidates = repo.listClosedEnquiriesMissingFirstRepliedAt();
    if (candidates.length === 0) return { checked: 0, updated: 0 };

    const replies = await graphClient.fetchReplyStatus(
      candidates.map((e) => ({ graphMessageId: e.graphMessageId, conversationId: e.conversationId }))
    );

    let updated = 0;
    for (const enquiry of candidates) {
      const reply = replies.get(enquiry.graphMessageId);
      if (reply?.firstReplyAt) {
        repo.updateEnquiry(enquiry.id, { firstRepliedAt: reply.firstReplyAt });
        updated += 1;
      }
    }

    return { checked: candidates.length, updated };
  })()
    .then((result) => {
      lastFirstRepliedAtBackfillResult = { ...result, error: null };
      return result;
    })
    .catch((err) => {
      lastFirstRepliedAtBackfillResult = { error: err.message };
      throw err;
    })
    .finally(() => {
      lastFirstRepliedAtBackfillFinishedAt = new Date().toISOString();
      firstRepliedAtBackfillInFlight = null;
    });

  return firstRepliedAtBackfillInFlight;
}

/** Polled by GET /api/ingest/backfill-first-replied-at-status — see the comment above firstRepliedAtBackfillInFlight. */
function getFirstRepliedAtBackfillStatus() {
  return {
    running: firstRepliedAtBackfillInFlight !== null,
    lastResult: lastFirstRepliedAtBackfillResult,
    lastFinishedAt: lastFirstRepliedAtBackfillFinishedAt,
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

module.exports = {
  isGraphConfigured,
  runPollOnce,
  syncFlagStatuses,
  syncReplyStatuses,
  backfillAllFoldersAndReassess,
  getBackfillStatus,
  reclassifyByFacility,
  getFacilityReclassifyStatus,
  backfillFirstRepliedAt,
  getFirstRepliedAtBackfillStatus,
  startScheduledPolling,
};
