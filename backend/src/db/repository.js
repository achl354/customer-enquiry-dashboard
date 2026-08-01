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

// Status "rank" so reply-detection (and anything similar) can only ever
// advance an enquiry forward, never undo a status staff already set
// themselves — e.g. a stale/old reply shouldn't demote a RESOLVED enquiry
// back to WAITING_ON_CUSTOMER.
const STATUS_RANK = { NEW: 0, IN_PROGRESS: 1, WAITING_ON_CUSTOMER: 2, RESOLVED: 3, IGNORED: 3 };

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
    status, assigned_to, created_at, updated_at
  ) VALUES (
    @id, @graphMessageId, @internetMessageId, @receivedAt, @senderName, @senderEmail,
    @recipients, @subject, @bodyPreview, @hasAttachments, @importance, @webLink,
    @category, @priority, @poNumber, @quoteNumber, @facility, @senderDomain, @cityTag,
    @conversationId, @suggestedAction, @draftReply, @confidence, @classifiedBy,
    @status, @assignedTo, @createdAt, @updatedAt
  )
  ON CONFLICT(graph_message_id) DO NOTHING
`);

/**
 * Classify a raw email (AI when configured, rules otherwise/on failure) and
 * persist it as an enquiry. Idempotent on graph_message_id.
 * Returns the inserted row id, or null if it already existed.
 */
async function ingestEmail(raw) {
  const result = await classifyEmail(raw);
  const timestamp = nowIso();
  const id = raw.graphMessageId || raw.internetMessageId || `${raw.senderEmail}-${raw.receivedAt}`;

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
    assignedTo: null,
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
    assignedTo: row.assigned_to,
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
function buildWhereClause({ category, priority, status, search }) {
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
  if (search) {
    clauses.push(
      '(subject LIKE @search OR body_preview LIKE @search OR sender_email LIKE @search OR po_number LIKE @search OR facility LIKE @search OR assigned_to LIKE @search)'
    );
    params.search = `%${search}%`;
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function listEnquiries({ category, priority, status, search, sort = 'receivedAt', order = 'desc', limit = 100, offset = 0 } = {}) {
  const { where, params } = buildWhereClause({ category, priority, status, search });
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
function listEnquiriesForExport({ category, priority, status, search, sort = 'receivedAt', order = 'desc' } = {}) {
  const { where, params } = buildWhereClause({ category, priority, status, search });
  const sortCol = SORT_COLUMNS[sort] || 'received_at';
  const dir = order === 'asc' ? 'ASC' : 'DESC';

  const rows = db.prepare(`SELECT * FROM enquiries ${where} ORDER BY ${sortCol} ${dir}`).all(params);
  return rows.map(rowToEnquiry);
}

function getEnquiry(id) {
  const row = db.prepare('SELECT * FROM enquiries WHERE id = ?').get(id);
  return rowToEnquiry(row);
}

const UPDATE_COLUMNS = { status: 'status', assignedTo: 'assigned_to', draftReply: 'draft_reply' };

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
      "SELECT id, graph_message_id, status FROM enquiries WHERE status NOT IN ('RESOLVED', 'IGNORED') AND graph_message_id IS NOT NULL"
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
      "SELECT id, graph_message_id, conversation_id, status, sender_domain FROM enquiries WHERE status NOT IN ('RESOLVED', 'IGNORED') AND graph_message_id IS NOT NULL AND conversation_id IS NOT NULL"
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

function overviewStats() {
  // Real week-over-week volume comparison (by received_at), not a fabricated
  // trend — used for the "Total enquiries" delta indicator on Overview.
  const last7Days = db
    .prepare("SELECT COUNT(*) as c FROM enquiries WHERE received_at >= datetime('now', '-7 days')")
    .get().c;
  const prev7Days = db
    .prepare(
      "SELECT COUNT(*) as c FROM enquiries WHERE received_at >= datetime('now', '-14 days') AND received_at < datetime('now', '-7 days')"
    )
    .get().c;

  const byCategory = db.prepare('SELECT category, COUNT(*) as count FROM enquiries GROUP BY category').all();
  const byStatus = db.prepare('SELECT status, COUNT(*) as count FROM enquiries GROUP BY status').all();
  const byPriority = db.prepare('SELECT priority, COUNT(*) as count FROM enquiries GROUP BY priority').all();

  const openCount = db
    .prepare("SELECT COUNT(*) as c FROM enquiries WHERE status NOT IN ('RESOLVED', 'IGNORED')")
    .get().c;

  const oldestOpen = db
    .prepare(
      "SELECT * FROM enquiries WHERE status NOT IN ('RESOLVED', 'IGNORED') ORDER BY received_at ASC LIMIT 1"
    )
    .get();

  const urgentOpen = db
    .prepare(
      "SELECT COUNT(*) as c FROM enquiries WHERE priority = 'URGENT' AND status NOT IN ('RESOLVED', 'IGNORED')"
    )
    .get().c;

  const total = db.prepare('SELECT COUNT(*) as c FROM enquiries').get().c;

  const byClassifiedBy = db.prepare('SELECT classified_by, COUNT(*) as count FROM enquiries GROUP BY classified_by').all();

  const lowConfidenceCount = db
    .prepare("SELECT COUNT(*) as c FROM enquiries WHERE classified_by = 'ai' AND confidence < 0.5")
    .get().c;

  const resolvedWithDuration = db
    .prepare(
      "SELECT (julianday(updated_at) - julianday(received_at)) * 24 as hours FROM enquiries WHERE status = 'RESOLVED'"
    )
    .all();
  const avgResolutionHours = resolvedWithDuration.length
    ? resolvedWithDuration.reduce((sum, r) => sum + r.hours, 0) / resolvedWithDuration.length
    : null;

  // Top facilities/organisations by volume — nothing in the UI previously
  // surfaced which customers actually generate the most enquiries.
  const byFacility = db
    .prepare(
      "SELECT facility, COUNT(*) as count FROM enquiries WHERE facility IS NOT NULL AND facility != '' GROUP BY facility ORDER BY count DESC LIMIT 10"
    )
    .all();

  // Aging distribution of open enquiries. A single "oldest open" item
  // doesn't show how many are piling up — this does, in the same buckets
  // a team lead would think in (still fresh / due for a check-in / overdue).
  const agingRows = db
    .prepare(
      `SELECT
         CASE
           WHEN (julianday('now') - julianday(received_at)) * 24 < 24 THEN '0-24h'
           WHEN (julianday('now') - julianday(received_at)) < 3 THEN '1-3d'
           WHEN (julianday('now') - julianday(received_at)) < 7 THEN '3-7d'
           ELSE '7d+'
         END as bucket,
         COUNT(*) as count
       FROM enquiries
       WHERE status NOT IN ('RESOLVED', 'IGNORED')
       GROUP BY bucket`
    )
    .all();
  const agingByBucket = Object.fromEntries(agingRows.map((r) => [r.bucket, r.count]));
  const agingBuckets = ['0-24h', '1-3d', '3-7d', '7d+'].map((bucket) => ({
    bucket,
    count: agingByBucket[bucket] || 0,
  }));

  // Open workload per assignee — "Team overview" previously showed nothing
  // about the team itself. Unassigned is reported separately since it's not
  // a person.
  const byAssignee = db
    .prepare(
      "SELECT assigned_to, COUNT(*) as count FROM enquiries WHERE status NOT IN ('RESOLVED', 'IGNORED') AND assigned_to IS NOT NULL AND assigned_to != '' GROUP BY assigned_to ORDER BY count DESC"
    )
    .all();
  const unassignedOpen = db
    .prepare(
      "SELECT COUNT(*) as c FROM enquiries WHERE status NOT IN ('RESOLVED', 'IGNORED') AND (assigned_to IS NULL OR assigned_to = '')"
    )
    .get().c;

  // Daily volume for the last 30 days, zero-filled — a single week-over-week
  // delta hides spikes/seasonality (e.g. a burst of PO notices on one day).
  const dailyRows = db
    .prepare(
      "SELECT date(received_at) as day, COUNT(*) as count FROM enquiries WHERE received_at >= datetime('now', '-30 days') GROUP BY day"
    )
    .all();
  const dailyByDate = Object.fromEntries(dailyRows.map((r) => [r.day, r.count]));
  const dailyVolume = [];
  for (let i = 29; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    dailyVolume.push({ date: key, count: dailyByDate[key] || 0 });
  }

  return {
    total,
    openCount,
    urgentOpen,
    byCategory: Object.fromEntries(byCategory.map((r) => [r.category, r.count])),
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
    byPriority: Object.fromEntries(byPriority.map((r) => [r.priority, r.count])),
    byFacility: byFacility.map((r) => ({ facility: r.facility, count: r.count })),
    agingBuckets,
    byAssignee: byAssignee.map((r) => ({ assignedTo: r.assigned_to, count: r.count })),
    unassignedOpen,
    dailyVolume,
    oldestOpen: rowToEnquiry(oldestOpen),
    avgResolutionHours,
    resolvedCount: resolvedWithDuration.length,
    byClassifiedBy: Object.fromEntries(byClassifiedBy.map((r) => [r.classified_by, r.count])),
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
};
