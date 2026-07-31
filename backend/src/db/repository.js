const db = require('./index');
const { classifyEmail } = require('../triage');

function nowIso() {
  return new Date().toISOString();
}

const insertStmt = db.prepare(`
  INSERT INTO enquiries (
    id, graph_message_id, internet_message_id, received_at, sender_name, sender_email,
    recipients, subject, body_preview, has_attachments, importance, web_link,
    category, priority, po_number, quote_number, facility, sender_domain, city_tag,
    suggested_action, confidence, classified_by,
    status, assigned_to, created_at, updated_at
  ) VALUES (
    @id, @graphMessageId, @internetMessageId, @receivedAt, @senderName, @senderEmail,
    @recipients, @subject, @bodyPreview, @hasAttachments, @importance, @webLink,
    @category, @priority, @poNumber, @quoteNumber, @facility, @senderDomain, @cityTag,
    @suggestedAction, @confidence, @classifiedBy,
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
    suggestedAction: result.suggestedAction,
    confidence: result.confidence == null ? null : result.confidence,
    classifiedBy: result.classifiedBy || 'rules',
    status: 'NEW',
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
    suggestedAction: row.suggested_action,
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
  priority: 'priority',
  category: 'category',
  status: 'status',
};

function listEnquiries({ category, priority, status, search, sort = 'receivedAt', order = 'desc', limit = 100, offset = 0 } = {}) {
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
    clauses.push('(subject LIKE @search OR body_preview LIKE @search OR sender_email LIKE @search OR po_number LIKE @search)');
    params.search = `%${search}%`;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sortCol = SORT_COLUMNS[sort] || 'received_at';
  const dir = order === 'asc' ? 'ASC' : 'DESC';

  const rows = db
    .prepare(`SELECT * FROM enquiries ${where} ORDER BY ${sortCol} ${dir} LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset });

  const total = db.prepare(`SELECT COUNT(*) as c FROM enquiries ${where}`).get(params).c;

  return { items: rows.map(rowToEnquiry), total };
}

function getEnquiry(id) {
  const row = db.prepare('SELECT * FROM enquiries WHERE id = ?').get(id);
  return rowToEnquiry(row);
}

function updateEnquiry(id, updates) {
  const allowed = ['status', 'assignedTo'];
  const sets = [];
  const params = { id, updatedAt: nowIso() };

  for (const key of allowed) {
    if (updates[key] !== undefined) {
      const col = key === 'assignedTo' ? 'assigned_to' : key;
      sets.push(`${col} = @${key}`);
      params[key] = updates[key];
    }
  }
  if (sets.length === 0) return getEnquiry(id);

  sets.push('updated_at = @updatedAt');
  db.prepare(`UPDATE enquiries SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getEnquiry(id);
}

function overviewStats() {
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

  const resolvedWithDuration = db
    .prepare(
      "SELECT (julianday(updated_at) - julianday(received_at)) * 24 as hours FROM enquiries WHERE status = 'RESOLVED'"
    )
    .all();
  const avgResolutionHours = resolvedWithDuration.length
    ? resolvedWithDuration.reduce((sum, r) => sum + r.hours, 0) / resolvedWithDuration.length
    : null;

  return {
    total,
    openCount,
    urgentOpen,
    byCategory: Object.fromEntries(byCategory.map((r) => [r.category, r.count])),
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
    byPriority: Object.fromEntries(byPriority.map((r) => [r.priority, r.count])),
    oldestOpen: rowToEnquiry(oldestOpen),
    avgResolutionHours,
  };
}

module.exports = { ingestEmail, listEnquiries, getEnquiry, updateEnquiry, overviewStats };
