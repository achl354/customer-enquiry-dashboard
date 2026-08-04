const db = require('./index');
const { classifyEmail } = require('../triage');

function nowIso() {
  return new Date().toISOString();
}

// Maps an Outlook follow-up flag (staff already use this in Outlook itself)
// to a dashboard status. Returns null for 'notFlagged'/unknown — that's not
// a signal either way, not evidence the enquiry is still new.
function statusForFlag(flagStatus) {
  if (flagStatus === 'complete') return 'RESOLVED';
  if (flagStatus === 'flagged') return 'IN_PROGRESS';
  return null;
}

// Checking real Sent Items showed the follow-up flag above is barely used in
// practice — genuinely-handled threads routinely have no flag, or one left
// at 'flagged' rather than 'complete'. These two Outlook categories are a
// currently-unused feature in the mailbox (every message checked came back
// with an empty category list), so they're a cleaner, explicit "I'm done
// with this" signal that doesn't depend on a habit the team doesn't have.
// Staff apply one via Outlook's own Categorize menu — same low-friction
// motion as flagging, just a channel nothing else is already using.
const RESOLVED_CATEGORY = 'resolved';
const IGNORED_CATEGORY = 'no action needed';

// Case-insensitive on purpose — these categories don't exist in Outlook yet
// (the mailbox currently only has the default color names, e.g. "Red
// Category"), so whoever creates them is typing the name freehand. No
// reason to make that exact-case or risk a silent miss over "resolved" vs
// "Resolved".
function statusForCategories(categories) {
  if (!categories || categories.length === 0) return null;
  const normalized = categories.map((c) => (c || '').trim().toLowerCase());
  if (normalized.includes(RESOLVED_CATEGORY)) return 'RESOLVED';
  if (normalized.includes(IGNORED_CATEGORY)) return 'IGNORED';
  return null;
}

// A confirmed 404 looking up the message itself (not just "no flag/category
// data") means it's gone from the mailbox entirely — moved somewhere its ID
// no longer resolves, or deleted. Distinct from RESOLVED (see CLOSED_STATUSES
// above): this is an inference from disappearance, not an explicit "done"
// from staff, so it stays visually and functionally separate.
function statusForMissingMessage(confirmedMissing) {
  return confirmedMissing ? 'REMOVED' : null;
}

// Confirmed directly with staff: their actual "I'm done with this" habit is
// filing the message into a folder (see the folder tree they shared — PO
// folders by state, CUST SERVICE EMAILS, etc.), not flagging it or tagging a
// category. Any move out of Inbox counts as resolved, no exceptions per
// folder — including a manual delete (Inbox -> Deleted Items also trips
// this, and that's fine, staff confirmed the simple rule over carving out
// per-folder meaning). Takes priority over the flag heuristic since this is
// the confirmed-real habit, not a maybe-used one — but stays below an
// explicit category tag, which is a deliberate staff action either way.
function statusForFolderMove(movedOutOfInbox) {
  return movedOutOfInbox ? 'RESOLVED' : null;
}

// Status "rank" so reply-detection (and anything similar) can only ever
// advance an enquiry forward, never undo a status staff already set
// themselves — e.g. a stale/old reply shouldn't demote a RESOLVED enquiry
// back to WAITING_ON_CUSTOMER.
const STATUS_RANK = { NEW: 0, IN_PROGRESS: 1, WAITING_ON_CUSTOMER: 2, RESOLVED: 3, IGNORED: 3, REMOVED: 3, DISMISSED: 3 };

// Terminal statuses — excluded from every "open enquiries" query below.
// REMOVED means the message was deleted/purged from the mailbox (observed
// cause: storage quota cleanup) before ever getting an explicit Resolved/No
// Action Needed category — see statusForMissingMessage below. It's kept
// distinct from RESOLVED rather than folded into it, since deletion doesn't
// confirm the enquiry was actually handled, just that nothing further will
// ever be seen for it.
//
// DISMISSED is the odd one out here: RESOLVED/IGNORED/REMOVED are all
// inferred from something observed in Outlook (a flag, a category tag, the
// message disappearing) — never set directly by this app. DISMISSED is the
// opposite: it's ONLY ever set by staff clicking "Delete" on the Detail
// page (see routes/enquiries.js), a dashboard-native "hide this from my
// queue" with no Outlook-side signal behind it at all. Kept as its own
// status rather than reusing IGNORED/REMOVED specifically so those two
// keep meaning exactly what their sync logic says they mean.
const CLOSED_STATUSES = ['RESOLVED', 'IGNORED', 'REMOVED', 'DISMISSED'];
const CLOSED_STATUS_SQL = CLOSED_STATUSES.map((s) => `'${s}'`).join(', ');

// A reply/forward was found in Sent Items for this enquiry's conversation.
// Customer-facing (recipients overlap the original external sender's domain)
// -> WAITING_ON_CUSTOMER (we replied, now waiting on them). Internal-only
// recipients -> IN_PROGRESS (staff started working it, e.g. forwarded to a
// colleague). Only applied if it's a genuine advance over the current status.
function statusForReply(isCustomerFacing, currentStatus) {
  const candidate = isCustomerFacing ? 'WAITING_ON_CUSTOMER' : 'IN_PROGRESS';
  if (STATUS_RANK[candidate] > (STATUS_RANK[currentStatus] ?? 0)) return candidate;
  return null;
}

const insertStmt = db.prepare(`
  INSERT INTO enquiries (
    id, graph_message_id, internet_message_id, received_at, sender_name, sender_email,
    recipients, subject, body_preview, has_attachments, importance, web_link,
    category, priority, po_number, quote_number, facility, sender_domain, city_tag,
    conversation_id, suggested_action, draft_reply, confidence, classified_by,
    status, created_at, updated_at
  ) VALUES (
    @id, @graphMessageId, @internetMessageId, @receivedAt, @senderName, @senderEmail,
    @recipients, @subject, @bodyPreview, @hasAttachments, @importance, @webLink,
    @category, @priority, @poNumber, @quoteNumber, @facility, @senderDomain, @cityTag,
    @conversationId, @suggestedAction, @draftReply, @confidence, @classifiedBy,
    @status, @createdAt, @updatedAt
  )
  ON CONFLICT(graph_message_id) DO NOTHING
`);

const existsStmt = db.prepare('SELECT 1 FROM enquiries WHERE graph_message_id = ?');

/**
 * Classify a raw email (AI when configured, rules otherwise/on failure) and
 * persist it as an enquiry. Idempotent on graph_message_id.
 * Returns the inserted row id, or null if it already existed.
 */
async function ingestEmail(raw) {
  const id = raw.graphMessageId || raw.internetMessageId || `${raw.senderEmail}-${raw.receivedAt}`;
  // Checked before classifying, not just at insert time — a wider backfill
  // window means poll cycles (and every restart, since lastPollAt resets)
  // can re-fetch messages already ingested. Classification is the expensive
  // part (a real API call when AI is configured), so this skips it entirely
  // for anything already in the DB instead of only deduping at the INSERT.
  if (existsStmt.get(id)) return null;

  const result = await classifyEmail(raw);
  const timestamp = nowIso();

  const info = insertStmt.run({
    id,
    graphMessageId: raw.graphMessageId || id,
    internetMessageId: raw.internetMessageId || null,
    receivedAt: raw.receivedAt,
    senderName: raw.senderName || null,
    senderEmail: raw.senderEmail || null,
    recipients: JSON.stringify(raw.recipients || []),
    subject: raw.subject || '',
    bodyPreview: raw.bodyPreview || '',
    hasAttachments: raw.hasAttachments ? 1 : 0,
    importance: raw.importance || 'normal',
    webLink: raw.webLink || null,
    category: result.category,
    priority: result.priority,
    poNumber: result.extractedFields.poNumber,
    quoteNumber: result.extractedFields.quoteNumber,
    facility: result.extractedFields.facility,
    senderDomain: result.extractedFields.senderDomain,
    cityTag: result.extractedFields.cityTag || null,
    conversationId: raw.conversationId || null,
    suggestedAction: result.suggestedAction,
    draftReply: result.draftReply || null,
    confidence: result.confidence == null ? null : result.confidence,
    classifiedBy: result.classifiedBy || 'rules',
    status: statusForCategories(raw.categories) || statusForFlag(raw.flagStatus) || 'NEW',
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  return info.changes > 0 ? id : null;
}

function rowToEnquiry(row) {
  if (!row) return null;
  return {
    id: row.id,
    graphMessageId: row.graph_message_id,
    internetMessageId: row.internet_message_id,
    receivedAt: row.received_at,
    sender: { name: row.sender_name, email: row.sender_email },
    recipients: JSON.parse(row.recipients || '[]'),
    subject: row.subject,
    bodyPreview: row.body_preview,
    hasAttachments: !!row.has_attachments,
    importance: row.importance,
    webLink: row.web_link,
    category: row.category,
    priority: row.priority,
    extractedFields: {
      poNumber: row.po_number,
      quoteNumber: row.quote_number,
      facility: row.facility,
      senderDomain: row.sender_domain,
      cityTag: row.city_tag,
    },
    conversationId: row.conversation_id,
    suggestedAction: row.suggested_action,
    draftReply: row.draft_reply,
    confidence: row.confidence,
    classifiedBy: row.classified_by,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SORT_COLUMNS = {
  receivedAt: 'received_at',
  // Alphabetical order on the raw text ('HIGH', 'LOW', 'NORMAL', 'URGENT')
  // doesn't match severity, so rank by actual urgency instead.
  priority: "CASE priority WHEN 'URGENT' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'NORMAL' THEN 2 WHEN 'LOW' THEN 1 ELSE 0 END",
  category: 'category',
  status: 'status',
};

// Shared by listEnquiries and the CSV export — both filter the same way,
// the export just skips LIMIT/OFFSET to return every matching row.
// Same 0.5 threshold the Detail page uses to flag a classification as
// "low confidence — worth a second look", kept in one place so the Overview
// tile's count and this filter can never drift apart.
const LOW_CONFIDENCE_THRESHOLD = 0.5;

function buildWhereClause({ category, priority, status, search, lowConfidence }) {
  const clauses = [];
  const params = {};

  if (category) {
    clauses.push('category = @category');
    params.category = category;
  }
  if (priority) {
    clauses.push('priority = @priority');
    params.priority = priority;
  }
  if (status) {
    clauses.push('status = @status');
    params.status = status;
  }
  if (lowConfidence) {
    clauses.push("classified_by = 'ai' AND confidence < @lowConfidenceThreshold");
    params.lowConfidenceThreshold = LOW_CONFIDENCE_THRESHOLD;
  }
  if (search) {
    clauses.push(
      '(subject LIKE @search OR body_preview LIKE @search OR sender_email LIKE @search OR po_number LIKE @search OR facility LIKE @search)'
    );
    params.search = `%${search}%`;
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function listEnquiries({ category, priority, status, search, lowConfidence, sort = 'receivedAt', order = 'desc', limit = 100, offset = 0 } = {}) {
  const { where, params } = buildWhereClause({ category, priority, status, search, lowConfidence });
  const sortCol = SORT_COLUMNS[sort] || 'received_at';
  const dir = order === 'asc' ? 'ASC' : 'DESC';

  const rows = db
    .prepare(`SELECT * FROM enquiries ${where} ORDER BY ${sortCol} ${dir} LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset });

  const total = db.prepare(`SELECT COUNT(*) as c FROM enquiries ${where}`).get(params).c;

  return { items: rows.map(rowToEnquiry), total };
}

// Same filters as listEnquiries, no pagination — used by CSV export, which
// needs every matching row rather than one page of results.
function listEnquiriesForExport({ category, priority, status, search, lowConfidence, sort = 'receivedAt', order = 'desc' } = {}) {
  const { where, params } = buildWhereClause({ category, priority, status, search, lowConfidence });
  const sortCol = SORT_COLUMNS[sort] || 'received_at';
  const dir = order === 'asc' ? 'ASC' : 'DESC';

  const rows = db.prepare(`SELECT * FROM enquiries ${where} ORDER BY ${sortCol} ${dir}`).all(params);
  return rows.map(rowToEnquiry);
}

function getEnquiry(id) {
  const row = db.prepare('SELECT * FROM enquiries WHERE id = ?').get(id);
  return rowToEnquiry(row);
}

const UPDATE_COLUMNS = {
  status: 'status',
  draftReply: 'draft_reply',
  category: 'category',
  classifiedBy: 'classified_by',
  confidence: 'confidence',
};

function updateEnquiry(id, updates) {
  const sets = [];
  const params = { id, updatedAt: nowIso() };

  for (const key of Object.keys(UPDATE_COLUMNS)) {
    if (updates[key] !== undefined) {
      sets.push(`${UPDATE_COLUMNS[key]} = @${key}`);
      params[key] = updates[key];
    }
  }
  if (sets.length === 0) return getEnquiry(id);

  sets.push('updated_at = @updatedAt');
  db.prepare(`UPDATE enquiries SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getEnquiry(id);
}

// Enquiries worth re-checking against their Outlook flag on each poll — no
// point checking ones already resolved/ignored, and no graph_message_id
// means it's a seed record with nothing real to check in Outlook.
function listOpenEnquiriesForFlagSync() {
  return db
    .prepare(
      `SELECT id, graph_message_id, status FROM enquiries WHERE status NOT IN (${CLOSED_STATUS_SQL}) AND graph_message_id IS NOT NULL`
    )
    .all()
    .map((r) => ({ id: r.id, graphMessageId: r.graph_message_id, status: r.status }));
}

// Same idea, for reply-detection — also needs conversation_id (absent on
// seed records and any message ingested before this feature existed) and
// the original sender's domain, to tell a customer-facing reply apart from
// a purely internal forward.
function listOpenEnquiriesForReplySync() {
  return db
    .prepare(
      `SELECT id, graph_message_id, conversation_id, status, sender_domain FROM enquiries WHERE status NOT IN (${CLOSED_STATUS_SQL}) AND graph_message_id IS NOT NULL AND conversation_id IS NOT NULL`
    )
    .all()
    .map((r) => ({
      id: r.id,
      graphMessageId: r.graph_message_id,
      conversationId: r.conversation_id,
      status: r.status,
      senderDomain: r.sender_domain,
    }));
}

// overviewStats() runs on every dashboard load/poll of /api/stats/overview,
// so — unlike one-off calls elsewhere — its statements are worth preparing
// once at module load rather than re-parsing the same SQL text on every
// call, same as insertStmt/existsStmt above. All static text (CLOSED_STATUS_SQL
// is a hardcoded constant, the date math is SQLite's own datetime()/julianday(),
// not JS-interpolated), so none of these need parameters.
const last7DaysStmt = db.prepare("SELECT COUNT(*) as c FROM enquiries WHERE received_at >= datetime('now', '-7 days')");
const prev7DaysStmt = db.prepare(
  "SELECT COUNT(*) as c FROM enquiries WHERE received_at >= datetime('now', '-14 days') AND received_at < datetime('now', '-7 days')"
);
const byCategoryStmt = db.prepare('SELECT category, COUNT(*) as count FROM enquiries GROUP BY category');
const byStatusStmt = db.prepare('SELECT status, COUNT(*) as count FROM enquiries GROUP BY status');
const byPriorityStmt = db.prepare('SELECT priority, COUNT(*) as count FROM enquiries GROUP BY priority');
const openCountStmt = db.prepare(`SELECT COUNT(*) as c FROM enquiries WHERE status NOT IN (${CLOSED_STATUS_SQL})`);
const oldestOpenStmt = db.prepare(
  `SELECT * FROM enquiries WHERE status NOT IN (${CLOSED_STATUS_SQL}) ORDER BY received_at ASC LIMIT 1`
);
const urgentOpenStmt = db.prepare(
  `SELECT COUNT(*) as c FROM enquiries WHERE priority = 'URGENT' AND status NOT IN (${CLOSED_STATUS_SQL})`
);
// "Total enquiries" deliberately doesn't count from the very first row —
// everything before this date is seed/backfill data from before the
// mailbox was tracked for real, not a genuine enquiry volume figure.
// Change this one constant to move the reporting start date.
const TOTAL_SINCE = '2026-07-01T00:00:00.000Z';
const totalStmt = db.prepare(`SELECT COUNT(*) as c FROM enquiries WHERE received_at >= '${TOTAL_SINCE}'`);
const lowConfidenceCountStmt = db.prepare(
  `SELECT COUNT(*) as c FROM enquiries WHERE classified_by = 'ai' AND confidence < ${LOW_CONFIDENCE_THRESHOLD}`
);
// AVG()/COUNT() in SQL instead of pulling every RESOLVED row into Node just
// to reduce it to two numbers — this cost was growing unbounded as RESOLVED
// enquiries accumulate over the dashboard's lifetime.
const resolutionStatsStmt = db.prepare(
  "SELECT AVG((julianday(updated_at) - julianday(received_at)) * 24) as avgHours, COUNT(*) as count FROM enquiries WHERE status = 'RESOLVED'"
);
const byFacilityStmt = db.prepare(
  "SELECT facility, COUNT(*) as count FROM enquiries WHERE facility IS NOT NULL AND facility != '' GROUP BY facility ORDER BY count DESC LIMIT 10"
);
const agingRowsStmt = db.prepare(
  `SELECT
     CASE
       WHEN (julianday('now') - julianday(received_at)) * 24 < 24 THEN '0-24h'
       WHEN (julianday('now') - julianday(received_at)) < 3 THEN '1-3d'
       WHEN (julianday('now') - julianday(received_at)) < 7 THEN '3-7d'
       ELSE '7d+'
     END as bucket,
     COUNT(*) as count
   FROM enquiries
   WHERE status NOT IN (${CLOSED_STATUS_SQL})
   GROUP BY bucket`
);
const dailyReceivedRowsStmt = db.prepare(
  "SELECT date(received_at) as day, COUNT(*) as count FROM enquiries WHERE received_at >= datetime('now', '-30 days') GROUP BY day"
);
// updated_at doubles as "when it became resolved" — same proxy the avg
// resolution-time stat above already uses, so a day is counted as
// "resolved" here on whichever day the status last changed to RESOLVED.
const dailyResolvedRowsStmt = db.prepare(
  "SELECT date(updated_at) as day, COUNT(*) as count FROM enquiries WHERE status = 'RESOLVED' AND updated_at >= datetime('now', '-30 days') GROUP BY day"
);

// Trailing-7-day buckets (not calendar weeks) so "this week" always means
// "the last 7 days," regardless of what day it is today.
const WEEKLY_BUCKET_COUNT = 12;
const WEEKLY_WINDOW_DAYS = WEEKLY_BUCKET_COUNT * 7;
const receivedInWindowStmt = db.prepare(
  `SELECT received_at FROM enquiries WHERE received_at >= datetime('now', '-${WEEKLY_WINDOW_DAYS} days')`
);
const resolvedInWindowStmt = db.prepare(
  `SELECT updated_at FROM enquiries WHERE status = 'RESOLVED' AND updated_at >= datetime('now', '-${WEEKLY_WINDOW_DAYS} days')`
);

// Cumulative received vs. cumulative resolved over the trailing 12 weeks,
// both restarting from 0 at the window start — the gap between the two
// lines shows whether *this window's* intake is outpacing resolution, not
// the mailbox's all-time backlog (that's what the Open stat tile is for).
function weeklyAccumulated() {
  const receivedPerWeek = new Array(WEEKLY_BUCKET_COUNT).fill(0);
  const resolvedPerWeek = new Array(WEEKLY_BUCKET_COUNT).fill(0);
  const nowMs = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  // Bucket 0 = oldest week in the window, last bucket = the most recent
  // (current, possibly partial) 7 days.
  const bucketIndexFor = (isoString) => {
    const daysAgo = Math.floor((nowMs - new Date(isoString).getTime()) / dayMs);
    const weeksAgo = Math.floor(daysAgo / 7);
    return WEEKLY_BUCKET_COUNT - 1 - weeksAgo;
  };

  for (const row of receivedInWindowStmt.all()) {
    const idx = bucketIndexFor(row.received_at);
    if (idx >= 0 && idx < WEEKLY_BUCKET_COUNT) receivedPerWeek[idx] += 1;
  }
  for (const row of resolvedInWindowStmt.all()) {
    const idx = bucketIndexFor(row.updated_at);
    if (idx >= 0 && idx < WEEKLY_BUCKET_COUNT) resolvedPerWeek[idx] += 1;
  }

  let cumReceived = 0;
  let cumResolved = 0;
  return receivedPerWeek.map((_, i) => {
    cumReceived += receivedPerWeek[i];
    cumResolved += resolvedPerWeek[i];
    const weekStart = new Date(nowMs - (WEEKLY_BUCKET_COUNT - i) * 7 * dayMs);
    return {
      weekStart: weekStart.toISOString().slice(0, 10),
      receivedCumulative: cumReceived,
      resolvedCumulative: cumResolved,
    };
  });
}

function overviewStats() {
  // Real week-over-week volume comparison (by received_at), not a fabricated
  // trend — used for the "Total enquiries" delta indicator on Overview.
  const last7Days = last7DaysStmt.get().c;
  const prev7Days = prev7DaysStmt.get().c;

  const byCategory = byCategoryStmt.all();
  const byStatus = byStatusStmt.all();
  const byPriority = byPriorityStmt.all();

  const openCount = openCountStmt.get().c;
  const oldestOpen = oldestOpenStmt.get();
  const urgentOpen = urgentOpenStmt.get().c;
  const total = totalStmt.get().c;
  const lowConfidenceCount = lowConfidenceCountStmt.get().c;

  const resolutionStats = resolutionStatsStmt.get();
  const avgResolutionHours = resolutionStats.count > 0 ? resolutionStats.avgHours : null;

  // Top facilities/organisations by volume — nothing in the UI previously
  // surfaced which customers actually generate the most enquiries.
  const byFacility = byFacilityStmt.all();

  // Aging distribution of open enquiries. A single "oldest open" item
  // doesn't show how many are piling up — this does, in the same buckets
  // a team lead would think in (still fresh / due for a check-in / overdue).
  const agingRows = agingRowsStmt.all();
  const agingByBucket = Object.fromEntries(agingRows.map((r) => [r.bucket, r.count]));
  const agingBuckets = ['0-24h', '1-3d', '3-7d', '7d+'].map((bucket) => ({
    bucket,
    count: agingByBucket[bucket] || 0,
  }));

  // Daily received vs. resolved for the last 30 days, zero-filled — raw
  // intake alone doesn't say whether it's being kept up with; this pairs
  // it against the day things actually got resolved.
  const dailyReceivedByDate = Object.fromEntries(dailyReceivedRowsStmt.all().map((r) => [r.day, r.count]));
  const dailyResolvedByDate = Object.fromEntries(dailyResolvedRowsStmt.all().map((r) => [r.day, r.count]));
  const dailyFlow = [];
  for (let i = 29; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    dailyFlow.push({
      date: key,
      received: dailyReceivedByDate[key] || 0,
      resolved: dailyResolvedByDate[key] || 0,
    });
  }

  const weeklyFlow = weeklyAccumulated();

  return {
    total,
    totalSinceDate: TOTAL_SINCE,
    openCount,
    urgentOpen,
    byCategory: Object.fromEntries(byCategory.map((r) => [r.category, r.count])),
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
    byPriority: Object.fromEntries(byPriority.map((r) => [r.priority, r.count])),
    byFacility: byFacility.map((r) => ({ facility: r.facility, count: r.count })),
    agingBuckets,
    dailyFlow,
    weeklyFlow,
    oldestOpen: rowToEnquiry(oldestOpen),
    avgResolutionHours,
    resolvedCount: resolutionStats.count,
    lowConfidenceCount,
    last7Days,
    prev7Days,
  };
}

module.exports = {
  ingestEmail,
  listEnquiries,
  listEnquiriesForExport,
  getEnquiry,
  updateEnquiry,
  overviewStats,
  listOpenEnquiriesForFlagSync,
  listOpenEnquiriesForReplySync,
  statusForFlag,
  statusForCategories,
  statusForReply,
  statusForMissingMessage,
  statusForFolderMove,
};
