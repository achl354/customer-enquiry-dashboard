// Regression tests for internal-forward priority inheritance — see
// findOriginalForInternalForward/ingestEmail in repository.js.
//
// Before this fix, an internal-only forward/reply of a customer enquiry
// (category=INTERNAL) always got a flat LOW priority, no matter how urgent
// the original enquiry was, because there was no mechanism correlating it
// back to the original row already in the enquiries table. These tests
// exercise ingestEmail end-to-end (not just the pure classifier) since the
// fix lives in how ingestion looks up and inherits from an existing row.
//
// Uses a throwaway on-disk DB (DB_PATH) rather than the dev seed DB — must
// be set before repository.js (and the db/index.js singleton it requires)
// is first loaded. `node --test` runs each test file in its own process,
// so this doesn't affect other test files. ANTHROPIC_API_KEY is also
// cleared so classifyEmail never takes the AI path here — every case below
// needs deterministic rule-based classification to assert against.
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDbPath = path.join(os.tmpdir(), `enquiries-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
process.env.DB_PATH = tmpDbPath;
delete process.env.ANTHROPIC_API_KEY;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { ingestEmail, getEnquiry, normalizeSubjectForMatch } = require('./repository');

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${tmpDbPath}${suffix}`, { force: true });
  }
});

function email(overrides) {
  return {
    graphMessageId: `msg-${Math.random().toString(36).slice(2)}`,
    receivedAt: '2026-08-01T09:00:00.000Z',
    senderEmail: 'someone@example.com',
    recipients: ['sales@jdhealthcare.com.au'],
    subject: '',
    bodyPreview: '',
    importance: 'normal',
    hasAttachments: false,
    ...overrides,
  };
}

test('normalizeSubjectForMatch strips repeated FW:/RE:/Fwd:/AW: prefixes and lowercases', () => {
  assert.equal(normalizeSubjectForMatch('Bed dimensions issue'), 'bed dimensions issue');
  assert.equal(normalizeSubjectForMatch('FW: Bed dimensions issue'), 'bed dimensions issue');
  assert.equal(normalizeSubjectForMatch('Re: Fw: Bed dimensions issue'), 'bed dimensions issue');
  assert.equal(normalizeSubjectForMatch('FW:Bed dimensions issue'), 'bed dimensions issue');
  assert.equal(normalizeSubjectForMatch(''), '');
  assert.equal(normalizeSubjectForMatch(undefined), '');
});

test('internal forward within the same conversation inherits the original enquiry\'s priority', async () => {
  const originalId = await ingestEmail(email({
    subject: 'Product safety concern',
    bodyPreview: 'This is a formal customer complaint regarding LOT number ABC123, please advise.',
    senderEmail: 'nurse@health.nsw.gov.au',
    conversationId: 'conv-urgent-1',
  }));
  const original = getEnquiry(originalId);
  assert.equal(original.category, 'PRODUCT_COMPLAINT');
  assert.equal(original.priority, 'URGENT');

  const forwardId = await ingestEmail(email({
    subject: 'FW: Product safety concern',
    bodyPreview: 'Please action this internally.',
    senderEmail: 'lauren.langley@jdhealthcare.com.au',
    recipients: ['paul.mckay@jdhealthcare.com.au'],
    conversationId: 'conv-urgent-1',
  }));
  const forward = getEnquiry(forwardId);
  assert.equal(forward.category, 'INTERNAL');
  assert.equal(forward.priority, 'URGENT');
  assert.equal(forward.relatedEnquiryId, originalId);
});

test('internal forward with a new conversationId (typical Outlook forward) falls back to subject matching', async () => {
  const originalId = await ingestEmail(email({
    subject: 'Bed dimensions issue',
    bodyPreview: 'The hoist has stopped working and needs a replacement part urgently.',
    senderEmail: 'ot@healthsharevic.org.au',
    conversationId: 'conv-a',
  }));
  const original = getEnquiry(originalId);
  assert.equal(original.priority, 'URGENT');

  const forwardId = await ingestEmail(email({
    subject: 'FW: Bed dimensions issue',
    bodyPreview: 'Can someone action this?',
    senderEmail: 'lauren.langley@jdhealthcare.com.au',
    recipients: ['paul.mckay@jdhealthcare.com.au'],
    conversationId: 'conv-b', // Outlook forwards commonly start a new thread
  }));
  const forward = getEnquiry(forwardId);
  assert.equal(forward.category, 'INTERNAL');
  assert.equal(forward.priority, 'URGENT');
  assert.equal(forward.relatedEnquiryId, originalId);
});

test('a genuinely new internal-only thread with no correlated enquiry keeps the flat LOW default', async () => {
  const id = await ingestEmail(email({
    subject: 'FYI pricing sheet',
    bodyPreview: 'Just sharing this internally, no action needed.',
    senderEmail: 'lauren.langley@jdhealthcare.com.au',
    recipients: ['paul.mckay@jdhealthcare.com.au'],
    conversationId: 'conv-fyi',
  }));
  const enquiry = getEnquiry(id);
  assert.equal(enquiry.category, 'INTERNAL');
  assert.equal(enquiry.priority, 'LOW');
  assert.equal(enquiry.relatedEnquiryId, null);
});

test('a matching subject outside the correlation window is not treated as the same enquiry', async () => {
  const originalId = await ingestEmail(email({
    subject: 'Historical product safety concern',
    bodyPreview: 'This is a formal customer complaint regarding LOT number XYZ789, please advise.',
    senderEmail: 'nurse@health.nsw.gov.au',
    receivedAt: '2026-01-01T09:00:00.000Z',
    conversationId: 'conv-old',
  }));
  assert.equal(getEnquiry(originalId).priority, 'URGENT');

  const forwardId = await ingestEmail(email({
    subject: 'FW: Historical product safety concern',
    bodyPreview: 'Please action.',
    senderEmail: 'lauren.langley@jdhealthcare.com.au',
    recipients: ['paul.mckay@jdhealthcare.com.au'],
    receivedAt: '2026-08-01T09:00:00.000Z', // ~7 months later, outside the 30-day window
    conversationId: 'conv-new',
  }));
  const forward = getEnquiry(forwardId);
  assert.equal(forward.category, 'INTERNAL');
  assert.equal(forward.priority, 'LOW');
  assert.equal(forward.relatedEnquiryId, null);
});
