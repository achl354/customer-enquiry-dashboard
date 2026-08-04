const express = require('express');
const repo = require('../db/repository');
const aiClassifier = require('../ai/classifier');
const graphClient = require('../graph/client');
const { CATEGORIES } = require('../triage/classify');
const { toCsv } = require('../utils/csv');

const router = express.Router();

// A non-numeric but non-empty query value (e.g. ?limit=abc) previously
// passed straight through as NaN, which better-sqlite3 rejects with a raw
// "datatype mismatch" — an uncaught 500 for a simple malformed query
// string. Falls back to undefined (repo.listEnquiries' own default) for
// anything that isn't a genuine non-negative integer.
function parseNonNegativeInt(value) {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

router.get('/', (req, res) => {
  const { category, priority, status, search, lowConfidence, sort, order, limit, offset } = req.query;
  const result = repo.listEnquiries({
    category: category || undefined,
    priority: priority || undefined,
    status: status || undefined,
    search: search || undefined,
    lowConfidence: lowConfidence === 'true' || lowConfidence === '1',
    sort: sort || undefined,
    order: order || undefined,
    limit: parseNonNegativeInt(limit),
    offset: parseNonNegativeInt(offset),
  });
  res.json(result);
});

const CSV_COLUMNS = [
  ['Received', (e) => e.receivedAt],
  ['Sender name', (e) => e.sender.name || ''],
  ['Sender email', (e) => e.sender.email || ''],
  ['Subject', (e) => e.subject || ''],
  ['Category', (e) => e.category],
  ['Priority', (e) => e.priority],
  ['Status', (e) => e.status],
  ['Facility / org', (e) => e.extractedFields.facility || ''],
  ['PO number', (e) => e.extractedFields.poNumber || ''],
  ['Quote number', (e) => e.extractedFields.quoteNumber || ''],
  ['Classified by', (e) => e.classifiedBy || ''],
];

// Same filters as the queue view, no pagination — for management/board
// reporting rather than working the queue itself, so drafts/body content
// are deliberately left out in favour of a lean, reportable column set.
router.get('/export', (req, res) => {
  const { category, priority, status, search, lowConfidence, sort, order } = req.query;
  const items = repo.listEnquiriesForExport({
    category: category || undefined,
    priority: priority || undefined,
    status: status || undefined,
    search: search || undefined,
    lowConfidence: lowConfidence === 'true' || lowConfidence === '1',
    sort: sort || undefined,
    order: order || undefined,
  });

  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="enquiries-export-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(toCsv(CSV_COLUMNS, items));
});

router.get('/:id', (req, res) => {
  const enquiry = repo.getEnquiry(req.params.id);
  if (!enquiry) return res.status(404).json({ error: 'Enquiry not found' });
  res.json(enquiry);
});

// Generate a draft reply/handoff note on demand — split out from
// classification (see ai/classifier.js) specifically so staff only pay for
// drafting when they're actually acting on an enquiry, not on every single
// one that gets classified. Free-template drafts from the rule-based
// classifier already come populated (no cost), so this only ever fires for
// AI-classified enquiries missing one.
//
// Available for every category, including ones the classifier expects
// won't need a draft (INTERNAL/SPAM_NOTIFICATION/UNCLASSIFIED) — rather
// than the backend pre-filtering those out, staff can just click the
// button and see for themselves; the drafting prompt itself already
// returns null for genuinely draft-less cases (see DRAFT_SYSTEM_PROMPT).
router.post('/:id/draft', async (req, res) => {
  const existing = repo.getEnquiry(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Enquiry not found' });

  if (existing.draftReply) return res.json(existing);

  if (!aiClassifier.isConfigured()) {
    return res.status(400).json({ error: 'AI classifier is not configured (ANTHROPIC_API_KEY missing)' });
  }

  // Best-effort thread history — a Graph failure here shouldn't block
  // drafting, just means the draft is written without that context.
  let threadHistory = [];
  if (existing.conversationId && graphClient.isConfigured()) {
    try {
      threadHistory = await graphClient.fetchConversationMessages(existing.conversationId);
    } catch (err) {
      console.error('[draft] Failed to fetch thread history, drafting without it:', err.message);
    }
  }

  try {
    const draftReply = await aiClassifier.generateDraft(
      {
        subject: existing.subject,
        bodyPreview: existing.bodyPreview,
        senderName: existing.sender.name,
        senderEmail: existing.sender.email,
        recipients: existing.recipients,
      },
      { category: existing.category, extractedFields: existing.extractedFields },
      threadHistory
    );
    const updated = repo.updateEnquiry(req.params.id, { draftReply });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Thread history for display on the detail page — on-demand (like drafting)
// rather than fetched automatically on every page load, since most
// enquiries have no reply yet and this would otherwise be a wasted Graph
// call each time someone opens one. This is a Graph API call, not Claude,
// so it doesn't affect AI spend either way.
router.get('/:id/thread', async (req, res) => {
  const existing = repo.getEnquiry(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Enquiry not found' });

  if (!existing.conversationId) {
    return res.status(400).json({ error: 'No thread history available for this enquiry (no conversation ID stored — likely seed/demo data, not live-ingested mail)' });
  }
  if (!graphClient.isConfigured()) {
    return res.status(400).json({ error: 'Live mail sync is not configured (TENANT_ID/CLIENT_ID/CLIENT_SECRET/MAILBOX missing)' });
  }

  try {
    const messages = await graphClient.fetchConversationMessages(existing.conversationId);
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full email body, on demand — bodyPreview (stored at ingest time) is
// Graph's own truncated preview, not the whole message. Same on-demand
// pattern as /thread: fetched only when staff click to expand it, not
// stored for every enquiry up front.
router.get('/:id/body', async (req, res) => {
  const existing = repo.getEnquiry(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Enquiry not found' });

  // No conversationId is the same "this is seed/demo data" signal /thread
  // uses — seed records never set one, real Graph-ingested mail always does.
  if (!existing.conversationId) {
    return res.status(400).json({ error: 'No full body available for this enquiry (seed/demo data — the preview shown is already the full text)' });
  }
  if (!graphClient.isConfigured()) {
    return res.status(400).json({ error: 'Live mail sync is not configured (TENANT_ID/CLIENT_ID/CLIENT_SECRET/MAILBOX missing)' });
  }

  try {
    const body = await graphClient.fetchFullBody(existing.graphMessageId);
    res.json({ body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual recategorization — the classifier (AI or rules) got it wrong.
// Marked classifiedBy: 'manual' with confidence cleared so the Detail page
// doesn't keep showing a stale "Classified by Claude — 92% confidence"
// line for a category a human actually chose.
router.patch('/:id/category', (req, res) => {
  const existing = repo.getEnquiry(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Enquiry not found' });

  const { category } = req.body;
  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Invalid category: ${category}` });
  }

  const patch = { category, classifiedBy: 'manual', confidence: null };
  // Recategorizing to spam is an explicit staff call, always trusted (same
  // as statusForConfirmedSpam's non-AI branch) — shouldn't keep counting as
  // backlog (NEW/IN_PROGRESS/WAITING_ON_CUSTOMER) or as a genuine RESOLVED.
  // Left alone if staff already DISMISSED it — that's a more deliberate
  // override this shouldn't second-guess.
  if (category === 'SPAM_NOTIFICATION' && existing.status !== 'DISMISSED') {
    patch.status = 'IGNORED';
  }

  const updated = repo.updateEnquiry(req.params.id, patch);
  res.json(updated);
});

// "Delete" from the dashboard's perspective — see the DISMISSED comment in
// db/repository.js for why this sets a dedicated status rather than
// reusing RESOLVED/IGNORED (both are Outlook-sync-only elsewhere in this
// app). Not a real DELETE FROM — these are real customer emails, so
// nothing here touches the row itself or the actual mailbox.
router.delete('/:id', (req, res) => {
  const existing = repo.getEnquiry(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Enquiry not found' });

  const updated = repo.updateEnquiry(req.params.id, { status: 'DISMISSED' });
  res.json(updated);
});

module.exports = router;
