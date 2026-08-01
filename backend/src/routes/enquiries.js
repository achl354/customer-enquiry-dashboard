const express = require('express');
const repo = require('../db/repository');
const aiClassifier = require('../ai/classifier');
const graphClient = require('../graph/client');

const router = express.Router();

router.get('/', (req, res) => {
  const { category, priority, status, search, sort, order, limit, offset } = req.query;
  const result = repo.listEnquiries({
    category: category || undefined,
    priority: priority || undefined,
    status: status || undefined,
    search: search || undefined,
    sort: sort || undefined,
    order: order || undefined,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });
  res.json(result);
});

router.get('/:id', (req, res) => {
  const enquiry = repo.getEnquiry(req.params.id);
  if (!enquiry) return res.status(404).json({ error: 'Enquiry not found' });
  res.json(enquiry);
});

// Status is intentionally not settable here. The dashboard is an add-on
// triage layer, not the system of record — staff take real actions (reply,
// resolve, flag) in Outlook, and status flows one-way from there via the
// poller's flag sync and reply/forward detection (see graph/poller.js).
// Letting staff also set it manually here would let the dashboard drift
// out of sync with what Outlook actually shows. Assigned-to has no Outlook
// equivalent (it's a dashboard-only team-coordination field), so it stays
// editable.
router.patch('/:id', (req, res) => {
  const { status, assignedTo } = req.body || {};
  if (status !== undefined) {
    return res.status(400).json({ error: 'Status can\'t be set manually — it syncs automatically from Outlook (flags and replies).' });
  }
  const existing = repo.getEnquiry(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Enquiry not found' });

  const updated = repo.updateEnquiry(req.params.id, { assignedTo });
  res.json(updated);
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

module.exports = router;
