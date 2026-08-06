const db = require('./index');
const { classifyEmail } = require('../triage');
const { CATEGORIES } = require('../triage/classify');

function nowIso() {
  return new Date().toISOString();
}

// Shared by listEnquiries/the CSV export's lowConfidence filter, the
// Overview "needs review" tile, and statusForConfirmedSpam below — one
// place so none of them can drift apart from each other.
const LOW_CONFIDENCE_THRESHOLD = 0.5;

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
// data") means it's gone from the mailbox entirely — its Graph ID no longer
// resolves anywhere. Originally treated as a separate, unconfirmed signal
// (REMOVED) distinct from an explicit "done" — but confirmed directly with
// staff that in this mailbox, archiving a resolved message is exactly what
// makes it stop resolving via this lookup (see statusForFolderMove below for
// the far more common case, a plain in-mailbox folder move that still
// resolves fine). A message that's gone entirely is the same signal, just a
// step further along, so it resolves the same way rather than needing its
// own status.
function statusForMissingMessage(confirmedMissing) {
  return confirmedMissing ? 'RESOLVED' : null;
}

// Confirmed directly with staff: their actual "I'm done with this" habit is
// filing the message into a folder (see the folder tree they shared — PO
// folders by state, CUST SERVICE EMAILS, etc.), not flagging it or tagging a
// category. Any move out of Inbox counts as resolved, no exceptions per
// folder — including a manual delete (Inbox -> Deleted Items also trips
// this, and that's fine, staff confirmed the simple rule over carving out
// per-folder meaning). Takes priority over the flag heuristic since this is
// the confirmed-real habit, not a maybe-used one — but stays below an
// explicit category tag: e.g. "No Action Needed" applied before archiving
// should still resolve to IGNORED, not get overwritten to RESOLVED just
// because the message also left the Inbox.
function statusForFolderMove(movedOutOfInbox) {
  return movedOutOfInbox ? 'RESOLVED' : null;
}

// Confirmed spam/notification noise shouldn't count as backlog (sitting
// open forever, nobody's ever going to reply to it) or, once it eventually
// leaves the Inbox, as a genuine RESOLVED — resolving a real enquiry is a
// different thing from an email that was never one. IGNORED already means
// exactly "no action needed," so it's reused rather than adding a new
// status.
//
// Gated on confidence: a rules-based (or rules-fallback, or manual) call is
// always trusted, since those are deterministic/explicit, not a guess. An
// AI call below LOW_CONFIDENCE_THRESHOLD is deliberately NOT auto-ignored —
// a real customer enquiry the AI misreads as spam at low confidence needs
// to stay visible (as NEW, in the existing "needs review" list) rather than
// being silently hidden with nothing ever flagging it for a second look.
function statusForConfirmedSpam(category, classifiedBy, confidence) {
  if (category !== 'SPAM_NOTIFICATION') return null;
  const isConfident = classifiedBy !== 'ai' || (confidence != null && confidence >= LOW_CONFIDENCE_THRESHOLD);
  return isConfident ? 'IGNORED' : null;
}

// Status "rank" so reply-detection (and anything similar) can only ever
// advance an enquiry forward, never undo a status staff already set
// themselves — e.g. a stale/old reply shouldn't demote a RESOLVED enquiry
// back to WAITING_ON_CUSTOMER.
const STATUS_RANK = { NEW: 0, IN_PROGRESS: 1, WAITING_ON_CUSTOMER: 2, RESOLVED: 3, IGNORED: 3, DISMISSED: 3 };

// Terminal statuses — excluded from every "open enquiries" query below.
//
// DISMISSED is the odd one out here: RESOLVED/IGNORED are both inferred
// from something observed in Outlook (a flag, a category tag, a folder
// move) — never set directly by this app. DISMISSED is the opposite: it's
// ONLY ever set by staff clicking "Delete" on the Detail page (see
// routes/enquiries.js), a dashboard-native "hide this from my queue" with
// no Outlook-side signal behind it at all. Kept as its own status rather
// than reusing IGNORED so that one keeps meaning exactly what its sync
// logic says it means.
const CLOSED_STATUSES = ['RESOLVED', 'IGNORED', 'DISMISSED'];
const CLOSED_STATUS_SQL = CLOSED_STATUSES.map((s) => `'${s}'`).join(', ');

// One-time reclassification, not a schema change — same confidence gate as
// statusForConfirmedSpam above, backfilled for anything ingested before
// that existed (or ingested since, if the Outlook flag/category sync ran
// first and left it open under some other signal). Runs on every boot; a
// no-op once nothing open matches this.
db.prepare(
  `UPDATE enquiries SET status = 'IGNORED', updated_at = @updatedAt
   WHERE category = 'SPAM_NOTIFICATION'
     AND status IN ('NEW', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER')
     AND (classified_by != 'ai' OR confidence >= @lowConfidenceThreshold)`
).run({ updatedAt: nowIso(), lowConfidenceThreshold: LOW_CONFIDENCE_THRESHOLD });

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
    status, resolved_at, created_at, updated_at
  ) VALUES (
    @id, @graphMessageId, @internetMessageId, @receivedAt, @senderName, @senderEmail,
    @recipients, @subject, @bodyPreview, @hasAttachments, @importance, @webLink,
    @category, @priority, @poNumber, @quoteNumber, @facility, @senderDomain, @cityTag,
    @conversationId, @suggestedAction, @draftReply, @confidence, @classifiedBy,
    @status, @resolvedAt, @createdAt, @updatedAt
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

  // movedOutOfInbox/lastModifiedDateTime are only present when raw came
  // from fetchAllMailboxMessagesSince (the all-folder historical backfill,
  // see graph/poller.js) — undefined for the normal Inbox-only poll, where
  // statusForFolderMove(undefined) is just another no-signal null, same as
  // before this existed. Setting resolved_at here for already-archived
  // historical mail avoids waiting a full extra poll cycle for
  // syncFlagStatuses to notice it, or for backfillResolvedAt to recover it.
  const initialStatus =
    statusForCategories(raw.categories) ||
    statusForFolderMove(raw.movedOutOfInbox) ||
    statusForFlag(raw.flagStatus) ||
    statusForConfirmedSpam(result.category, result.classifiedBy, result.confidence) ||
    'NEW';

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
    status: initialStatus,
    resolvedAt: initialStatus === 'RESOLVED' && raw.lastModifiedDateTime ? raw.lastModifiedDateTime : null,
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
    statusNote: row.status_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Built from STATUS_RANK (defined above, for status-advancement logic) —
// same underlying "how far along" ordering (NEW < IN_PROGRESS <
// WAITING_ON_CUSTOMER < closed) happens to be exactly what sorting by
// status should show too, so this reuses it rather than hand-maintaining
// a second, easily-drifting copy of the same ranking.
const STATUS_SORT_CASE = `CASE status ${Object.entries(STATUS_RANK).map(([status, rank]) => `WHEN '${status}' THEN ${rank}`).join(' ')} ELSE 99 END`;

const SORT_COLUMNS = {
  receivedAt: 'received_at',
  // Alphabetical order on the raw text ('HIGH', 'LOW', 'NORMAL', 'URGENT')
  // doesn't match severity, so rank by actual urgency instead.
  priority: "CASE priority WHEN 'URGENT' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'NORMAL' THEN 2 WHEN 'LOW' THEN 1 ELSE 0 END",
  category: 'category',
  // Alphabetical here put DISMISSED/IGNORED first and NEW/IN_PROGRESS in
  // the middle — meaningless for "what still needs work." See
  // STATUS_SORT_CASE above.
  status: STATUS_SORT_CASE,
};

// Shared by listEnquiries and the CSV export — both filter the same way,
// the export just skips LIMIT/OFFSET to return every matching row.
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
  statusNote: 'status_note',
  draftReply: 'draft_reply',
  category: 'category',
  classifiedBy: 'classified_by',
  confidence: 'confidence',
  resolvedAt: 'resolved_at',
  firstRepliedAt: 'first_replied_at',
  // Added for reclassifyEnquiry below — a bulk re-categorization needs to
  // update everything classifyEmail() produces, not just category itself.
  priority: 'priority',
  poNumber: 'po_number',
  quoteNumber: 'quote_number',
  facility: 'facility',
  senderDomain: 'sender_domain',
  cityTag: 'city_tag',
  suggestedAction: 'suggested_action',
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
      `SELECT id, graph_message_id, conversation_id, status, sender_domain, first_replied_at FROM enquiries WHERE status NOT IN (${CLOSED_STATUS_SQL}) AND graph_message_id IS NOT NULL AND conversation_id IS NOT NULL`
    )
    .all()
    .map((r) => ({
      id: r.id,
      graphMessageId: r.graph_message_id,
      conversationId: r.conversation_id,
      status: r.status,
      senderDomain: r.sender_domain,
      firstRepliedAt: r.first_replied_at,
    }));
}

// RESOLVED rows that predate resolved_at existing, or that resolved_at
// backfill hasn't successfully reached yet — see backfillResolvedAt in
// poller.js, which re-queries Graph for each one's lastModifiedDateTime.
// Bounded, not growing: once resolved_at is set going forward (on the same
// sync that resolves an enquiry), only this historical backlog remains,
// and it only shrinks as backfill succeeds.
function listResolvedEnquiriesMissingResolvedAt() {
  return db
    .prepare(
      `SELECT id, graph_message_id FROM enquiries WHERE status = 'RESOLVED' AND resolved_at IS NULL AND graph_message_id IS NOT NULL`
    )
    .all()
    .map((r) => ({ id: r.id, graphMessageId: r.graph_message_id }));
}

// For the /backfill-all-folders reassess pass (see graph/poller.js) — every
// enquiry received on/after a given date, regardless of current category or
// classifiedBy. Returns full rows (not a projection) since reclassifyEnquiry
// needs everything classifyEmail() looks at. `untilIso` is an optional,
// exclusive upper bound for reassessing a specific bounded window rather
// than everything since `sinceIso` through today.
function listEnquiriesReceivedSince(sinceIso, untilIso) {
  if (untilIso) {
    return db.prepare('SELECT * FROM enquiries WHERE received_at >= ? AND received_at < ?').all(sinceIso, untilIso);
  }
  return db.prepare('SELECT * FROM enquiries WHERE received_at >= ?').all(sinceIso);
}

// Same idea, scoped to one facility instead of a date window — backs the
// "reclassify all from this facility" action on the Top facilities panel
// (see reclassifyByFacility in graph/poller.js). Every enquiry currently
// attributed to that facility name gets reassessed, regardless of current
// category/classifiedBy, same as the date-scoped version above.
function listEnquiriesByFacility(facility) {
  return db.prepare('SELECT * FROM enquiries WHERE facility = ?').all(facility);
}

// Reconstructs the flat "raw email" shape classifyEmail()/classify() expect
// (see triage/classify.js's jsdoc) directly from an already-stored row —
// reclassification never needs a fresh Graph call, since everything the
// classifier looks at was already captured at ingestion time.
function rawShapeForReclassify(row) {
  return {
    graphMessageId: row.graph_message_id,
    receivedAt: row.received_at,
    senderName: row.sender_name,
    senderEmail: row.sender_email,
    recipients: JSON.parse(row.recipients || '[]'),
    subject: row.subject,
    bodyPreview: row.body_preview,
    hasAttachments: !!row.has_attachments,
    importance: row.importance,
    conversationId: row.conversation_id,
  };
}

// Re-runs classification against an already-ingested enquiry and overwrites
// its categorization — used by the /backfill-all-folders reassess pass.
// Deliberately narrow about what it touches:
//   - draft_reply is left alone entirely. A bulk reassessment shouldn't
//     destroy a draft staff may have already reviewed or copied out.
//   - status only changes via the same confirmed-spam rule the manual
//     category-PATCH endpoint uses (recategorized to spam -> IGNORED,
//     unless already DISMISSED). Everything else about an enquiry's
//     workflow state (RESOLVED, IN_PROGRESS, WAITING_ON_CUSTOMER, etc.) is
//     the Outlook-sync's job, not this one's — reassessing what category
//     something belongs to shouldn't reset progress already made on it.
async function reclassifyEnquiry(row) {
  const raw = rawShapeForReclassify(row);
  const result = await classifyEmail(raw);

  const patch = {
    category: result.category,
    priority: result.priority,
    poNumber: result.extractedFields.poNumber,
    quoteNumber: result.extractedFields.quoteNumber,
    facility: result.extractedFields.facility,
    senderDomain: result.extractedFields.senderDomain,
    cityTag: result.extractedFields.cityTag || null,
    suggestedAction: result.suggestedAction,
    confidence: result.confidence == null ? null : result.confidence,
    classifiedBy: result.classifiedBy || 'rules',
  };

  if (statusForConfirmedSpam(result.category, patch.classifiedBy, patch.confidence) === 'IGNORED' && row.status !== 'DISMISSED') {
    patch.status = 'IGNORED';
  }

  return updateEnquiry(row.id, patch);
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
// "Total enquiries" deliberately doesn't count from the very first row —
// everything before this date is seed/backfill data from before the
// mailbox was tracked for real, not a genuine enquiry volume figure.
// Change this one constant to move the reporting start date. Declared here
// (ahead of byCategoryStmt etc. below) since they're scoped to it too.
const TOTAL_SINCE = '2026-07-01T00:00:00.000Z';
// Scoped to TOTAL_SINCE, same as "Total enquiries" — these three used to
// query all-time, which silently mixed in pre-tracking seed/backfill data
// and meant their bars could never sum to the total shown next to them
// (same bug as byFacilityStmt, fixed the same way here).
const byCategoryStmt = db.prepare(`SELECT category, COUNT(*) as count FROM enquiries WHERE received_at >= '${TOTAL_SINCE}' GROUP BY category`);
const byStatusStmt = db.prepare(`SELECT status, COUNT(*) as count FROM enquiries WHERE received_at >= '${TOTAL_SINCE}' GROUP BY status`);
const byPriorityStmt = db.prepare(`SELECT priority, COUNT(*) as count FROM enquiries WHERE received_at >= '${TOTAL_SINCE}' GROUP BY priority`);
// Open/urgent/aging deliberately stay all-time, unlike the three above —
// backlog from before TOTAL_SINCE is still real backlog worth surfacing,
// not a historical volume figure to exclude. Different question, different
// scope, on purpose.
const openCountStmt = db.prepare(`SELECT COUNT(*) as c FROM enquiries WHERE status NOT IN (${CLOSED_STATUS_SQL})`);
// Action queue on Overview — the 5 longest-waiting still-open enquiries,
// not just the single oldest. "Owner" isn't part of this: assigned_to is
// an unused schema column today (nothing reads or writes it), so there's
// no real assignment data to show yet.
const OLDEST_OPEN_QUEUE_SIZE = 5;
const oldestOpenQueueStmt = db.prepare(
  `SELECT * FROM enquiries WHERE status NOT IN (${CLOSED_STATUS_SQL}) ORDER BY received_at ASC LIMIT ${OLDEST_OPEN_QUEUE_SIZE}`
);
// Second Action queue group — a just-arrived Urgent enquiry has no way to
// show up in oldestOpenQueue above (it's never one of the oldest-open by
// definition), so without this it could sit unnoticed until it aged into
// that list. "Recent" means actually recent — 24h — not just "whatever's
// newest," so this shows nothing rather than reaching back further to
// force a full 5 rows. Fetches a few extra past RECENT_URGENT_QUEUE_SIZE
// so overviewStats() can drop any overlap with oldestOpenQueue (only
// possible when there are very few open enquiries total) and still have
// enough left to fill the real limit.
const RECENT_URGENT_QUEUE_SIZE = 5;
const RECENT_URGENT_WINDOW_HOURS = 24;
const recentUrgentQueueStmt = db.prepare(
  `SELECT * FROM enquiries
   WHERE priority = 'URGENT' AND status NOT IN (${CLOSED_STATUS_SQL})
     AND received_at >= datetime('now', '-${RECENT_URGENT_WINDOW_HOURS} hours')
   ORDER BY received_at DESC LIMIT ${RECENT_URGENT_QUEUE_SIZE + OLDEST_OPEN_QUEUE_SIZE}`
);
const urgentOpenStmt = db.prepare(
  `SELECT COUNT(*) as c FROM enquiries WHERE priority = 'URGENT' AND status NOT IN (${CLOSED_STATUS_SQL})`
);
// All-time count of status='RESOLVED' regardless of received_at — used
// only to detect "are there any resolved enquiries at all" for the Overview
// resolution-time hint, which pairs with resolutionStatsStmt below (also
// all-time by design). byStatus.RESOLVED can't be reused for this now that
// it's scoped to TOTAL_SINCE — it would wrongly say "no resolved enquiries
// yet" if every resolved one happened to predate TOTAL_SINCE.
const totalResolvedAllTimeStmt = db.prepare("SELECT COUNT(*) as c FROM enquiries WHERE status = 'RESOLVED'");
const totalStmt = db.prepare(`SELECT COUNT(*) as c FROM enquiries WHERE received_at >= '${TOTAL_SINCE}'`);
const lowConfidenceCountStmt = db.prepare(
  `SELECT COUNT(*) as c FROM enquiries WHERE classified_by = 'ai' AND confidence < ${LOW_CONFIDENCE_THRESHOLD}`
);
// AVG()/COUNT() in SQL instead of pulling every RESOLVED row into Node just
// to reduce it to two numbers — this cost was growing unbounded as RESOLVED
// enquiries accumulate over the dashboard's lifetime.
//
// resolved_at, not updated_at — updated_at bumps on ANY field change (a
// draft regenerated, a manual category fix long after the fact), so it
// can't be trusted as "when did this actually become resolved." resolved_at
// is set once, from Graph's own lastModifiedDateTime at the moment the
// folder-move/category/flag sync resolves it (see poller.js) — a real
// historical timestamp. Rows without one yet (not resolved via this path,
// or the source message is confirmed gone with nothing left to ask Graph
// about) are excluded rather than guessed at — see backfillResolvedAt in
// poller.js for the active repair pass on existing RESOLVED rows.
const resolutionStatsStmt = db.prepare(
  "SELECT AVG((julianday(resolved_at) - julianday(received_at)) * 24) as avgHours, COUNT(*) as count FROM enquiries WHERE status = 'RESOLVED' AND resolved_at IS NOT NULL"
);

// Fiscal year starting 1 July (the AU financial year, not the calendar
// year) — FQ1 = Jul-Sep, FQ2 = Oct-Dec, FQ3 = Jan-Mar, FQ4 = Apr-Jun.
// Parameterized by column since this same fiscal-period grouping is used
// on both resolved_at (resolution-time trend) and first_replied_at
// (first-response-time trend) below. The "start year" is the calendar
// year the fiscal year *begins* in (e.g. 2026 for the FY running 1 Jul
// 2026 - 30 Jun 2027) — Jan-Jun dates belong to the fiscal year that
// started the previous calendar year, hence the -1. The quarter number
// shifts the month by 5 before the /3 divide so July (month 7) lands in
// bucket 1 instead of calendar-quarter 3.
function fiscalYearStartExpr(column) {
  return `(CASE WHEN CAST(strftime('%m', ${column}) AS INTEGER) >= 7 THEN CAST(strftime('%Y', ${column}) AS INTEGER) ELSE CAST(strftime('%Y', ${column}) AS INTEGER) - 1 END)`;
}
function fiscalQuarterExpr(column) {
  return `(((CAST(strftime('%m', ${column}) AS INTEGER) + 5) % 12) / 3 + 1)`;
}
// Calendar month, not fiscal — a month label ("Jul 2026") is unambiguous
// either way, so there's nothing for the fiscal-year framing to change here.
function periodExprFor(column, granularity) {
  if (granularity === 'month') return `strftime('%Y-%m', ${column})`;
  if (granularity === 'quarter') return `CAST(${fiscalYearStartExpr(column)} AS TEXT) || '-FQ' || ${fiscalQuarterExpr(column)}`;
  if (granularity === 'year') return `CAST(${fiscalYearStartExpr(column)} AS TEXT)`;
  throw new Error(`Invalid granularity: ${granularity}. Use month, quarter, or year.`);
}

// KPI rollup for the resolution-time trend panel — one prepared statement
// per granularity. All-time, same as resolutionStatsStmt above and for the
// same reason: this is a process metric (how fast are we resolving
// things), not a volume figure, so it isn't scoped to TOTAL_SINCE —
// resolved_at IS NOT NULL already excludes rows with no reliable timing
// data (pre-resolved_at, or confirmed-missing messages with nothing left
// to ask Graph about).
//
// slaCompliantCount/slaComplianceRate is bound to a caller-supplied
// threshold (hours) at query time, not baked into the SQL text, so the
// same prepared statement serves any SLA target without re-preparing.
const RESOLUTION_TREND_STMTS = ['month', 'quarter', 'year'].reduce((stmts, granularity) => {
  stmts[granularity] = db.prepare(
    `SELECT ${periodExprFor('resolved_at', granularity)} as period,
            AVG((julianday(resolved_at) - julianday(received_at)) * 24) as avgHours,
            COUNT(*) as count,
            SUM(CASE WHEN (julianday(resolved_at) - julianday(received_at)) * 24 <= @slaHours THEN 1 ELSE 0 END) as slaCompliantCount
     FROM enquiries WHERE status = 'RESOLVED' AND resolved_at IS NOT NULL
     GROUP BY period ORDER BY period ASC`
  );
  return stmts;
}, {});

const DEFAULT_SLA_HOURS = 48;

function resolutionTimeTrend(granularity, slaHours = DEFAULT_SLA_HOURS) {
  const stmt = RESOLUTION_TREND_STMTS[granularity];
  if (!stmt) throw new Error(`Invalid granularity: ${granularity}. Use month, quarter, or year.`);
  return stmt.all({ slaHours }).map((row) => ({
    ...row,
    slaComplianceRate: row.count > 0 ? row.slaCompliantCount / row.count : null,
  }));
}

// Same idea as resolutionTimeTrend but grouped by first_replied_at instead
// of resolved_at, and deliberately not gated on status = 'RESOLVED' — "how
// fast did someone touch this" applies to any enquiry that's ever gotten a
// reply, closed or not. No SLA column here; that wasn't asked for on this
// metric, only on full resolution time.
const FIRST_RESPONSE_TREND_STMTS = ['month', 'quarter', 'year'].reduce((stmts, granularity) => {
  stmts[granularity] = db.prepare(
    `SELECT ${periodExprFor('first_replied_at', granularity)} as period,
            AVG((julianday(first_replied_at) - julianday(received_at)) * 24) as avgHours,
            COUNT(*) as count
     FROM enquiries WHERE first_replied_at IS NOT NULL
     GROUP BY period ORDER BY period ASC`
  );
  return stmts;
}, {});

function firstResponseTimeTrend(granularity) {
  const stmt = FIRST_RESPONSE_TREND_STMTS[granularity];
  if (!stmt) throw new Error(`Invalid granularity: ${granularity}. Use month, quarter, or year.`);
  return stmt.all();
}

// All-time, all-resolved breakdown by priority — a simple snapshot (like
// byFacility/byCategory), not a period trend: "is URGENT actually
// resolved faster than NORMAL?" is a comparison across priority tiers, not
// across time, so there's no granularity toggle here.
//
// slaCompliantCount/slaComplianceRate bound at query time like
// resolutionTimeTrend's — default 24h matches Urgent's "max acceptable
// resolution time" target (see Overview.jsx's RAG thresholds), applied
// uniformly across all four priorities here since this is one shared
// snapshot query; only Urgent currently has a target defined to actually
// compare it against.
const resolutionTimeByPriorityStmt = db.prepare(
  `SELECT priority,
          AVG((julianday(resolved_at) - julianday(received_at)) * 24) as avgHours,
          COUNT(*) as count,
          SUM(CASE WHEN (julianday(resolved_at) - julianday(received_at)) * 24 <= @slaHours THEN 1 ELSE 0 END) as slaCompliantCount
   FROM enquiries WHERE status = 'RESOLVED' AND resolved_at IS NOT NULL
   GROUP BY priority`
);

const DEFAULT_PRIORITY_SLA_HOURS = 24;

function resolutionTimeByPriority(slaHours = DEFAULT_PRIORITY_SLA_HOURS) {
  return resolutionTimeByPriorityStmt.all({ slaHours }).map((row) => ({
    ...row,
    slaComplianceRate: row.count > 0 ? row.slaCompliantCount / row.count : null,
  }));
}

// Same idea as firstResponseTimeTrend but grouped by priority instead of
// period, mirroring resolutionTimeByPriority above — "how fast did someone
// touch this" broken out by tier rather than over time. Same forward-
// looking-only caveat as firstResponseTimeTrend (see first_replied_at in
// db/index.js): sparse/empty for a while after deploy, not backfillable.
const firstResponseTimeByPriorityStmt = db.prepare(
  `SELECT priority,
          AVG((julianday(first_replied_at) - julianday(received_at)) * 24) as avgHours,
          COUNT(*) as count
   FROM enquiries WHERE first_replied_at IS NOT NULL
   GROUP BY priority`
);

function firstResponseTimeByPriority() {
  return firstResponseTimeByPriorityStmt.all();
}

// "Open at end of period" — enquiries received on/before that moment whose
// resolved_at is either unset or still in the future relative to it.
// Deliberately unscoped by TOTAL_SINCE, same as the Open/Urgent stat tiles
// this extends into a trend — backlog from before tracking began is still
// real backlog, not a historical volume figure to exclude.
//
// Approximation, not exact: this over-counts "still open" for any closed
// enquiry with no resolved_at at all — that's IGNORED/DISMISSED (no
// equivalent timestamp exists for those paths at all — see the DISMISSED
// comment on the delete route, and statusForConfirmedSpam) but also any
// RESOLVED row resolved before the resolved_at column existed, or whose
// source message is confirmed gone with nothing left to ask Graph about
// (see backfillResolvedAt in poller.js, the active repair pass that
// shrinks this gap for RESOLVED rows over time). Accepted given the
// volume this affects is small, rather than adding a second closure
// timestamp column for a KPI this workflow-adjacent.
const backlogAtStmt = db.prepare(
  "SELECT COUNT(*) as c FROM enquiries WHERE received_at <= @asOf AND (resolved_at IS NULL OR resolved_at > @asOf)"
);

// Period-end boundaries from TOTAL_SINCE through now, labeled the same way
// resolutionTimeTrend's periods are (so Overview.jsx's formatTrendPeriod
// can render both) — computed in JS rather than SQL since there's no
// per-row data to GROUP BY here, just a sequence of "as-of" instants to
// query backlogAtStmt against. TOTAL_SINCE (1 Jul) is deliberately already
// a simultaneous month/fiscal-quarter/fiscal-year boundary, so every
// granularity can anchor to the same start date with no separate
// snapping logic.
function enumeratePeriodEnds(granularity) {
  const stepMonths = { month: 1, quarter: 3, year: 12 }[granularity];
  if (!stepMonths) throw new Error(`Invalid granularity: ${granularity}. Use month, quarter, or year.`);
  const anchor = new Date(TOTAL_SINCE);
  const nowMs = Date.now();
  const ends = [];
  let cursorStart = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()));
  while (cursorStart.getTime() <= nowMs) {
    const cursorEnd = new Date(Date.UTC(cursorStart.getUTCFullYear(), cursorStart.getUTCMonth() + stepMonths, cursorStart.getUTCDate()));
    ends.push({ periodStart: cursorStart, endExclusiveIso: cursorEnd.toISOString() });
    cursorStart = cursorEnd;
  }
  return ends;
}

function labelForPeriodStart(granularity, date) {
  if (granularity === 'month') {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const month = date.getUTCMonth() + 1;
  const fiscalYearStart = month >= 7 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  if (granularity === 'year') return String(fiscalYearStart);
  const fq = Math.floor(((month + 5) % 12) / 3) + 1;
  return `${fiscalYearStart}-FQ${fq}`;
}

function backlogTrend(granularity) {
  return enumeratePeriodEnds(granularity).map(({ periodStart, endExclusiveIso }) => ({
    period: labelForPeriodStart(granularity, periodStart),
    openAtEnd: backlogAtStmt.get({ asOf: endExclusiveIso }).c,
  }));
}

// Start of the current (possibly still in-progress) day/month/fiscal-
// quarter/fiscal-year — reuses enumeratePeriodEnds' own period-stepping
// for month/quarter/year (its last entry, by construction, is whichever
// period `now` currently falls in) rather than duplicating that
// fiscal-boundary math a third time. Day isn't one of enumeratePeriodEnds'
// granularities (it steps in months), so that case is handled directly
// here instead — kept even though nothing routes to it anymore (see
// statusByPeriod below), since it costs nothing to leave available.
function currentPeriodStart(granularity) {
  if (granularity === 'day') {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  }
  if (granularity === 'month' || granularity === 'quarter' || granularity === 'year') {
    const ends = enumeratePeriodEnds(granularity);
    return ends[ends.length - 1].periodStart.toISOString();
  }
  throw new Error(`Invalid granularity: ${granularity}. Use day, month, quarter, or year.`);
}

// Status mix of enquiries *received* in the current month/fiscal-quarter/
// fiscal-year — narrower than the by-status breakdown overviewStats()
// already returns (that one is since TOTAL_SINCE, all of it). Powers the
// Overview status panel's granularity — now the same shared global
// month/quarter/year control the other period-toggle panels use, rather
// than its own separate day/month/quarter toggle (see Overview.jsx) —
// "today" was dropped in that consolidation.
function statusByPeriod(granularity) {
  const sinceIso = currentPeriodStart(granularity);
  const rows = db.prepare('SELECT status, COUNT(*) as count FROM enquiries WHERE received_at >= ? GROUP BY status').all(sinceIso);
  return { since: sinceIso, byStatus: Object.fromEntries(rows.map((r) => [r.status, r.count])) };
}
// Scoped to TOTAL_SINCE, same as the "Total enquiries" stat this chart sits
// next to — querying all-time here (as this used to) mixes in pre-tracking
// seed/backfill data "Total enquiries" deliberately excludes, so the two
// numbers were counting different things and could never have added up.
const byFacilityStmt = db.prepare(
  `SELECT facility, COUNT(*) as count FROM enquiries WHERE facility IS NOT NULL AND facility != '' AND received_at >= '${TOTAL_SINCE}' GROUP BY facility ORDER BY count DESC LIMIT 10`
);
// Also scoped to TOTAL_SINCE — pairs with byFacilityStmt (top 10 only) so
// overviewStats can add "Other facilities" / "Not attributed" rows below,
// making the bars sum to the same total the stat tile shows instead of
// silently dropping anything past #10 or with no facility extracted at all.
const facilityAttributedCountStmt = db.prepare(
  `SELECT COUNT(*) as c FROM enquiries WHERE facility IS NOT NULL AND facility != '' AND received_at >= '${TOTAL_SINCE}'`
);

// Diagnostic for recalibrating KNOWN_ORG_DOMAINS/GENERIC_DOMAINS in
// classify.js — the "Not attributed" bucket on Overview is a single
// number with nothing to act on directly. This breaks it down by the
// actual sender domain behind it, so expanding those lists can be done
// against real, ranked volume instead of guessing. Same TOTAL_SINCE scope
// as byFacilityStmt/facilityAttributedCountStmt above, so this sums to
// the same "Not attributed" count shown in the UI. No LIMIT — the whole
// point is completeness for recalibration, not a chart-sized top-N.
const unattributedDomainsStmt = db.prepare(
  `SELECT sender_domain, COUNT(*) as count FROM enquiries
   WHERE (facility IS NULL OR facility = '') AND received_at >= '${TOTAL_SINCE}'
   GROUP BY sender_domain ORDER BY count DESC`
);

function unattributedDomains() {
  return unattributedDomainsStmt.all();
}

// Category split within a single unattributed sender domain — built to
// answer one question: is COMPANY_DOMAIN's chunk of "Not attributed"
// genuinely internal mail (facility doesn't apply, by design — see
// isInternalSender in classify.js) or customer-facing categories with an
// internal sender (a staff member forwarding/handling a real customer
// thread, where facility extraction is actually missing something)? Same
// TOTAL_SINCE + unattributed scope as unattributedDomainsStmt above, just
// narrowed to one domain and split by category instead of summed.
const unattributedDomainCategoriesStmt = db.prepare(
  `SELECT category, COUNT(*) as count FROM enquiries
   WHERE (facility IS NULL OR facility = '') AND received_at >= '${TOTAL_SINCE}' AND sender_domain = @domain
   GROUP BY category ORDER BY count DESC`
);

function unattributedDomainCategories(domain) {
  return unattributedDomainCategoriesStmt.all({ domain });
}
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
// Anchored at TOTAL_SINCE (the same reporting-start date "Total enquiries"
// uses) rather than a rolling last-30-days window — a rolling window drifts
// out of sync with that date as time passes (today, it would already be
// clipping off the first few days of July), and this chart exists
// specifically to show volume since tracking began, not an arbitrary
// trailing period.
const dailyReceivedRowsStmt = db.prepare(
  `SELECT date(received_at) as day, COUNT(*) as count FROM enquiries WHERE received_at >= '${TOTAL_SINCE}' GROUP BY day`
);
// resolved_at, not updated_at — see resolutionStatsStmt's comment above for
// why updated_at can't be trusted as "when this was actually resolved."
// Rows resolved before resolved_at existed (or whose message is confirmed
// gone) are excluded here the same way, rather than guessed at.
const dailyResolvedRowsStmt = db.prepare(
  `SELECT date(resolved_at) as day, COUNT(*) as count FROM enquiries WHERE status = 'RESOLVED' AND resolved_at IS NOT NULL AND resolved_at >= '${TOTAL_SINCE}' GROUP BY day`
);

const receivedInWindowStmt = db.prepare(`SELECT received_at FROM enquiries WHERE received_at >= '${TOTAL_SINCE}'`);
const resolvedInWindowStmt = db.prepare(
  `SELECT resolved_at FROM enquiries WHERE status = 'RESOLVED' AND resolved_at IS NOT NULL AND resolved_at >= '${TOTAL_SINCE}'`
);

// Unified volume KPI (received vs. resolved counts) behind the Overview
// Day/Week/Month/Quarter toggle — replaced two previously-separate,
// fixed-granularity charts (a daily one and a cumulative-weekly one).
// Non-cumulative at every granularity, all zero-filled from TOTAL_SINCE
// through now, so switching granularity doesn't change what kind of thing
// is being shown, only the bucket size.
function dailyVolumeTrend() {
  const receivedByDay = Object.fromEntries(dailyReceivedRowsStmt.all().map((r) => [r.day, r.count]));
  const resolvedByDay = Object.fromEntries(dailyResolvedRowsStmt.all().map((r) => [r.day, r.count]));
  const dayCount = Math.max(1, Math.floor((Date.now() - new Date(TOTAL_SINCE).getTime()) / (24 * 60 * 60 * 1000)) + 1);
  const out = [];
  for (let i = dayCount - 1; i >= 0; i -= 1) {
    const period = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    out.push({ period, received: receivedByDay[period] || 0, resolved: resolvedByDay[period] || 0 });
  }
  return out;
}

// Trailing-7-day buckets anchored at TOTAL_SINCE, growing by one bucket
// every 7 days rather than a fixed count — same anchoring reasoning as
// enumeratePeriodEnds below, just on a 7-day step instead of month-based.
function weeklyVolumeTrend() {
  const startMs = new Date(TOTAL_SINCE).getTime();
  const nowMs = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const weekCount = Math.max(1, Math.ceil((nowMs - startMs) / (7 * dayMs)));

  const receivedPerWeek = new Array(weekCount).fill(0);
  const resolvedPerWeek = new Array(weekCount).fill(0);
  const bucketIndexFor = (isoString) => Math.floor((new Date(isoString).getTime() - startMs) / (7 * dayMs));

  for (const row of receivedInWindowStmt.all()) {
    const idx = bucketIndexFor(row.received_at);
    if (idx >= 0 && idx < weekCount) receivedPerWeek[idx] += 1;
  }
  for (const row of resolvedInWindowStmt.all()) {
    const idx = bucketIndexFor(row.resolved_at);
    if (idx >= 0 && idx < weekCount) resolvedPerWeek[idx] += 1;
  }

  return receivedPerWeek.map((_, i) => ({
    period: new Date(startMs + i * 7 * dayMs).toISOString().slice(0, 10),
    received: receivedPerWeek[i],
    resolved: resolvedPerWeek[i],
  }));
}

const VOLUME_RECEIVED_STMTS = ['month', 'quarter'].reduce((stmts, g) => {
  stmts[g] = db.prepare(
    `SELECT ${periodExprFor('received_at', g)} as period, COUNT(*) as count FROM enquiries WHERE received_at >= '${TOTAL_SINCE}' GROUP BY period`
  );
  return stmts;
}, {});
const VOLUME_RESOLVED_STMTS = ['month', 'quarter'].reduce((stmts, g) => {
  stmts[g] = db.prepare(
    `SELECT ${periodExprFor('resolved_at', g)} as period, COUNT(*) as count FROM enquiries WHERE status = 'RESOLVED' AND resolved_at IS NOT NULL AND resolved_at >= '${TOTAL_SINCE}' GROUP BY period`
  );
  return stmts;
}, {});

function periodVolumeTrend(granularity) {
  const receivedByPeriod = Object.fromEntries(VOLUME_RECEIVED_STMTS[granularity].all().map((r) => [r.period, r.count]));
  const resolvedByPeriod = Object.fromEntries(VOLUME_RESOLVED_STMTS[granularity].all().map((r) => [r.period, r.count]));
  return enumeratePeriodEnds(granularity).map(({ periodStart }) => {
    const period = labelForPeriodStart(granularity, periodStart);
    return { period, received: receivedByPeriod[period] || 0, resolved: resolvedByPeriod[period] || 0 };
  });
}

function volumeTrend(granularity) {
  if (granularity === 'day') return dailyVolumeTrend();
  if (granularity === 'week') return weeklyVolumeTrend();
  if (granularity === 'month' || granularity === 'quarter') return periodVolumeTrend(granularity);
  throw new Error(`Invalid granularity: ${granularity}. Use day, week, month, or quarter.`);
}

// Same received-by-day/week/month shape as volumeTrend above, but broken
// out by category instead of collapsed to one count — lets the Overview
// "Enquiries by category" trend chart show *which* categories a given
// day's volume was actually made of (e.g. a spam/notification burst),
// not just that a spike happened. Every row is zero-filled across every
// category in CATEGORIES (not just the ones with a nonzero count that
// period), so the frontend never has to guess whether a missing key means
// zero or means "not fetched yet."
function zeroFilledCategories(counts) {
  const categories = {};
  for (const cat of CATEGORIES) categories[cat] = counts[cat] || 0;
  return categories;
}

const dailyCategoryRowsStmt = db.prepare(
  `SELECT date(received_at) as day, category, COUNT(*) as count FROM enquiries WHERE received_at >= '${TOTAL_SINCE}' GROUP BY day, category`
);

function dailyCategoryTrend() {
  const byDay = {};
  for (const r of dailyCategoryRowsStmt.all()) {
    if (!byDay[r.day]) byDay[r.day] = {};
    byDay[r.day][r.category] = r.count;
  }
  // Same day-enumeration approach as dailyVolumeTrend above.
  const dayCount = Math.max(1, Math.floor((Date.now() - new Date(TOTAL_SINCE).getTime()) / (24 * 60 * 60 * 1000)) + 1);
  const out = [];
  for (let i = dayCount - 1; i >= 0; i -= 1) {
    const period = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    out.push({ period, categories: zeroFilledCategories(byDay[period] || {}) });
  }
  return out;
}

const receivedWithCategoryInWindowStmt = db.prepare(
  `SELECT received_at, category FROM enquiries WHERE received_at >= '${TOTAL_SINCE}'`
);

function weeklyCategoryTrend() {
  // Same trailing-7-day-bucket-from-TOTAL_SINCE approach as weeklyVolumeTrend.
  const startMs = new Date(TOTAL_SINCE).getTime();
  const nowMs = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const weekCount = Math.max(1, Math.ceil((nowMs - startMs) / (7 * dayMs)));

  const perWeek = Array.from({ length: weekCount }, () => ({}));
  for (const row of receivedWithCategoryInWindowStmt.all()) {
    const idx = Math.floor((new Date(row.received_at).getTime() - startMs) / (7 * dayMs));
    if (idx >= 0 && idx < weekCount) {
      perWeek[idx][row.category] = (perWeek[idx][row.category] || 0) + 1;
    }
  }

  return perWeek.map((counts, i) => ({
    period: new Date(startMs + i * 7 * dayMs).toISOString().slice(0, 10),
    categories: zeroFilledCategories(counts),
  }));
}

const CATEGORY_TREND_MONTH_STMT = db.prepare(
  `SELECT ${periodExprFor('received_at', 'month')} as period, category, COUNT(*) as count
   FROM enquiries WHERE received_at >= '${TOTAL_SINCE}' GROUP BY period, category`
);

function monthlyCategoryTrend() {
  const byPeriod = {};
  for (const r of CATEGORY_TREND_MONTH_STMT.all()) {
    if (!byPeriod[r.period]) byPeriod[r.period] = {};
    byPeriod[r.period][r.category] = r.count;
  }
  return enumeratePeriodEnds('month').map(({ periodStart }) => {
    const period = labelForPeriodStart('month', periodStart);
    return { period, categories: zeroFilledCategories(byPeriod[period] || {}) };
  });
}

function categoryTrend(granularity) {
  if (granularity === 'day') return dailyCategoryTrend();
  if (granularity === 'week') return weeklyCategoryTrend();
  if (granularity === 'month') return monthlyCategoryTrend();
  throw new Error(`Invalid granularity: ${granularity}. Use day, week, or month.`);
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
  const oldestOpenQueue = oldestOpenQueueStmt.all();
  // See recentUrgentQueueStmt above re: the overlap/extra-fetch — drop
  // anything already in oldestOpenQueue, then cap at the real limit.
  const oldestOpenQueueIds = new Set(oldestOpenQueue.map((r) => r.id));
  const recentUrgentQueue = recentUrgentQueueStmt
    .all()
    .filter((r) => !oldestOpenQueueIds.has(r.id))
    .slice(0, RECENT_URGENT_QUEUE_SIZE);
  const urgentOpen = urgentOpenStmt.get().c;
  const total = totalStmt.get().c;
  const totalResolvedAllTime = totalResolvedAllTimeStmt.get().c;
  const lowConfidenceCount = lowConfidenceCountStmt.get().c;

  const resolutionStats = resolutionStatsStmt.get();
  const avgResolutionHours = resolutionStats.count > 0 ? resolutionStats.avgHours : null;

  // Top facilities/organisations by volume — nothing in the UI previously
  // surfaced which customers actually generate the most enquiries.
  // Top 10 by name, plus "Other facilities" (past #10, still attributed)
  // and "Not attributed" (no facility extracted at all) so the bars always
  // sum to `total` — otherwise both groups just vanish from the chart with
  // no indication anything was left out.
  const byFacilityTop = byFacilityStmt.all();
  const facilityAttributedCount = facilityAttributedCountStmt.get().c;
  const byFacility = byFacilityTop.map((r) => ({ facility: r.facility, count: r.count }));
  const otherFacilityCount = facilityAttributedCount - byFacilityTop.reduce((sum, r) => sum + r.count, 0);
  if (otherFacilityCount > 0) byFacility.push({ facility: 'Other facilities', count: otherFacilityCount });
  const notAttributedCount = total - facilityAttributedCount;
  if (notAttributedCount > 0) byFacility.push({ facility: 'Not attributed', count: notAttributedCount });

  // Aging distribution of open enquiries. A single "oldest open" item
  // doesn't show how many are piling up — this does, in the same buckets
  // a team lead would think in (still fresh / due for a check-in / overdue).
  const agingRows = agingRowsStmt.all();
  const agingByBucket = Object.fromEntries(agingRows.map((r) => [r.bucket, r.count]));
  const agingBuckets = ['0-24h', '1-3d', '3-7d', '7d+'].map((bucket) => ({
    bucket,
    count: agingByBucket[bucket] || 0,
  }));

  return {
    total,
    totalSinceDate: TOTAL_SINCE,
    openCount,
    urgentOpen,
    byCategory: Object.fromEntries(byCategory.map((r) => [r.category, r.count])),
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
    byPriority: Object.fromEntries(byPriority.map((r) => [r.priority, r.count])),
    byFacility: byFacility.map((r) => ({ facility: r.facility, count: r.count })),
    // What fraction of enquiries (since TOTAL_SINCE, same scope as
    // byFacility) got a real facility name rather than falling into
    // "Not attributed" — tracks whether expanding KNOWN_ORG_DOMAINS/
    // GENERIC_DOMAINS in classify.js is actually moving the needle over
    // time, rather than eyeballing the "Not attributed" bar's size.
    facilityAttributionRate: total > 0 ? facilityAttributedCount / total : null,
    agingBuckets,
    oldestOpenQueue: oldestOpenQueue.map(rowToEnquiry),
    recentUrgentQueue: recentUrgentQueue.map(rowToEnquiry),
    avgResolutionHours,
    resolvedCount: resolutionStats.count,
    totalResolvedAllTime,
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
  listResolvedEnquiriesMissingResolvedAt,
  listEnquiriesReceivedSince,
  listEnquiriesByFacility,
  reclassifyEnquiry,
  statusForFlag,
  statusForCategories,
  statusForReply,
  statusForMissingMessage,
  statusForFolderMove,
  statusForConfirmedSpam,
  resolutionTimeTrend,
  firstResponseTimeTrend,
  resolutionTimeByPriority,
  firstResponseTimeByPriority,
  backlogTrend,
  volumeTrend,
  categoryTrend,
  statusByPeriod,
  unattributedDomains,
  unattributedDomainCategories,
};
