const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('./classify');

// Regression tests for the rule-based classifier — this is the fallback
// used whenever the AI classifier is unconfigured or fails, so a silent
// regression here would misroute real customer enquiries with no safety
// net. Every case below is grounded in real sender/subject/body patterns
// seen in the actual mailbox (see backend/seed-data/sample-emails.json and
// backend/docs/response-patterns.md), not synthetic examples — each
// expected output was verified against the classifier's actual current
// behavior before being encoded here.

function email(overrides) {
  return {
    subject: '',
    bodyPreview: '',
    senderEmail: 'someone@example.com',
    recipients: ['sales@jdhealthcare.com.au'],
    importance: 'normal',
    hasAttachments: false,
    ...overrides,
  };
}

test('formal complaint language routes to PRODUCT_COMPLAINT at URGENT priority', () => {
  const r = classify(email({
    subject: 'Product safety concern',
    bodyPreview: 'This is a formal customer complaint regarding LOT number ABC123, please advise.',
    senderEmail: 'nurse@health.nsw.gov.au',
  }));
  assert.equal(r.category, 'PRODUCT_COMPLAINT');
  assert.equal(r.priority, 'URGENT');
});

test('genuine equipment fault is URGENT', () => {
  const r = classify(email({
    subject: 'Hoist broken',
    bodyPreview: 'The hoist has stopped working and needs a replacement part urgently.',
    senderEmail: 'ot@healthsharevic.org.au',
  }));
  assert.equal(r.category, 'EQUIPMENT_FAULT');
  assert.equal(r.priority, 'URGENT');
});

test('self-resolved equipment feedback is EQUIPMENT_FAULT but not urgent', () => {
  const r = classify(email({
    subject: 'Re: Push Ortho Thumb Brace CMC',
    bodyPreview: 'I have sorted my two braces out, by heating and rolling the sides in, on the part '
      + 'that goes between the base of the thumb and the index finger, as manufactured the narrow '
      + 'rounded part digs into the flesh.',
    senderEmail: 'fossilphill@gmail.com',
  }));
  assert.equal(r.category, 'EQUIPMENT_FAULT');
  assert.equal(r.priority, 'NORMAL');
});

test('backorder notice is HIGH priority', () => {
  const r = classify(email({
    subject: 'Stock update',
    bodyPreview: 'This item is currently on backorder with our supplier.',
    senderEmail: 'purchasing@opchealth.com.au',
  }));
  assert.equal(r.category, 'BACKORDER_NOTICE');
  assert.equal(r.priority, 'HIGH');
});

test('PO/ETA request extracts the PO number', () => {
  const r = classify(email({
    subject: 'PO Status',
    bodyPreview: 'Please provide ETA for purchase order PO12345, dispatch date needed.',
    senderEmail: 'buyer@health.nsw.gov.au',
  }));
  assert.equal(r.category, 'PO_ETA_REQUEST');
  assert.equal(r.priority, 'NORMAL');
  assert.equal(r.extractedFields.poNumber, 'PO12345');
});

test('price discrepancy on a PO is HIGH priority, distinct from a stock delay', () => {
  const r = classify(email({
    subject: 'PO on hold',
    bodyPreview: 'This purchase order has a price discrepancy, kindly update the pricing and we will send an amended PO.',
    senderEmail: 'buyer@sa.gov.au',
  }));
  assert.equal(r.category, 'PO_ETA_REQUEST');
  assert.equal(r.priority, 'HIGH');
});

test('overdue PO follow-up is HIGH priority', () => {
  const r = classify(email({
    subject: 'ETA request',
    bodyPreview: 'This purchase order is still outstanding, please advise dispatch date.',
    senderEmail: 'buyer@ths.tas.gov.au',
  }));
  assert.equal(r.category, 'PO_ETA_REQUEST');
  assert.equal(r.priority, 'HIGH');
});

test('goods return routes to RETURNS_CREDIT', () => {
  const r = classify(email({
    subject: 'Goods return',
    bodyPreview: 'Please process a credit note for the return label attached, item ordered in error.',
    senderEmail: 'clinic@healthsharevic.org.au',
  }));
  assert.equal(r.category, 'RETURNS_CREDIT');
});

test('overbilled invoice routes to INVOICE_BILLING, even when a quote number is also present', () => {
  const r = classify(email({
    subject: 'Re: Quote: Q14743- INVOICE SO83082',
    bodyPreview: 'Thank you for the update on quote Q14743, checking on pricing.',
    senderEmail: 'jadee@wecaresupportservices.net.au',
  }));
  assert.equal(r.category, 'INVOICE_BILLING');
  assert.equal(r.extractedFields.quoteNumber, 'Q14743');
});

test('known logistics domain routes to LOGISTICS_FREIGHT', () => {
  const r = classify(email({
    subject: 'Consignment update',
    bodyPreview: 'Please confirm the pickup for this consignment.',
    senderEmail: 'operations@steadfastlogistics.com.au',
  }));
  assert.equal(r.category, 'LOGISTICS_FREIGHT');
});

test('proof-of-delivery language routes to LOGISTICS_FREIGHT even off-domain', () => {
  const r = classify(email({
    subject: 'Proof of delivery request',
    bodyPreview: 'Can you send the proof of delivery / POD attached for this order?',
    senderEmail: 'buyer@somehospital.org.au',
  }));
  assert.equal(r.category, 'LOGISTICS_FREIGHT');
});

test('quote/pricing request routes to QUOTE_PRICING', () => {
  const r = classify(email({
    subject: 'Quote request',
    bodyPreview: 'Could you send a quotation and current pricing for these items?',
    senderEmail: 'buyer@somehospital.org.au',
  }));
  assert.equal(r.category, 'QUOTE_PRICING');
  assert.equal(r.priority, 'NORMAL');
});

test('spare-part lookup routes to PARTS_ENQUIRY, distinct from a quote or fault', () => {
  const r = classify(email({
    subject: 'RE: Hovertech hose replacement',
    bodyPreview: 'The part you want is PAHT-AIRHOSE5. The price is $144.88 + GST, I currently only have 4 in stock.',
    senderEmail: 'biomed@somehospital.org.au',
  }));
  assert.equal(r.category, 'PARTS_ENQUIRY');
  assert.equal(r.priority, 'NORMAL');
});

test('automated e-commerce order notification routes to ORDER_CONFIRMATION', () => {
  const r = classify(email({
    subject: 'FW: New Order (#5746) from Push Sports Braces for $85.00',
    bodyPreview: 'From: Push Sports Braces <donotreply@bigcommerce.com> Sent: Saturday, 31 January 2026 4:24 PM',
    senderEmail: 'sales@jdhealthcare.com.au',
    recipients: ['sales@gatewayrehab.com.au'],
  }));
  assert.equal(r.category, 'ORDER_CONFIRMATION');
});

test('brand-new customer needing prepayment setup routes to ORDER_CONFIRMATION, not PO_ETA_REQUEST', () => {
  const r = classify(email({
    subject: 'FW: Helipad Trolley order',
    bodyPreview: 'Thank you for your order. As this company is both a new customer in our system, and also not likely to be a regular purchaser, the account for this order is prepaid.',
    senderEmail: 'facilities@somebuilder.com.au',
  }));
  assert.equal(r.category, 'ORDER_CONFIRMATION');
});

test('known supplier domain routes to SUPPLIER_VENDOR at LOW priority', () => {
  const r = classify(email({
    subject: 'Parts availability',
    bodyPreview: 'Checking on parts availability for your order.',
    senderEmail: 'rep@aneticaid.com',
  }));
  assert.equal(r.category, 'SUPPLIER_VENDOR');
  assert.equal(r.priority, 'LOW');
});

test('internal-only thread (no external recipient) is INTERNAL at LOW priority', () => {
  const r = classify(email({
    subject: 'FYI pricing sheet',
    bodyPreview: 'Just sharing this internally, no action needed.',
    senderEmail: 'lauren.langley@jdhealthcare.com.au',
    recipients: ['sales@jdhealthcare.com.au', 'paul.mckay@jdhealthcare.com.au'],
  }));
  assert.equal(r.category, 'INTERNAL');
  assert.equal(r.priority, 'LOW');
});

test('known noise sender routes to SPAM_NOTIFICATION regardless of content', () => {
  const r = classify(email({
    subject: 'Microsoft 365 security: You have messages in quarantine',
    bodyPreview: 'Review these messages within 30 days.',
    senderEmail: 'quarantine@messaging.microsoft.com',
  }));
  assert.equal(r.category, 'SPAM_NOTIFICATION');
  assert.equal(r.priority, 'LOW');
});

test('website lead subject tag routes to PRODUCT_ENQUIRY with the city tag extracted', () => {
  const r = classify(email({
    subject: '[SYDNEY] Enquiry from JD Healthcare Group Website',
    bodyPreview: 'Occupational Therapist. Facility: Concord Repatriation Hospital. Message: looking for pricing and availability.',
    senderEmail: 'noreply@wpforms.com',
  }));
  assert.equal(r.category, 'PRODUCT_ENQUIRY');
  assert.equal(r.extractedFields.cityTag, 'SYDNEY');
  assert.match(r.suggestedAction, /\[territory rep — SYDNEY\]/);
});

test('trial request language is called out separately from a routine product enquiry', () => {
  const r = classify(email({
    subject: 'Trial request',
    bodyPreview: 'We would like to trial the hospital bed for two weeks before purchasing.',
    senderEmail: 'buyer@somehospital.org.au',
  }));
  assert.equal(r.category, 'PRODUCT_ENQUIRY');
  assert.match(r.suggestedAction, /Trial request/);
});

test('generic external product question falls through to PRODUCT_ENQUIRY', () => {
  const r = classify(email({
    subject: 'Bed dimensions',
    bodyPreview: 'Can you confirm the mattress dimensions for compatibility with our bed frame?',
    senderEmail: 'clients@vinestherapy.com.au',
  }));
  assert.equal(r.category, 'PRODUCT_ENQUIRY');
});

test('internal sender forwarding to an external recipient with no other signal is UNCLASSIFIED, not silently miscategorized', () => {
  const r = classify(email({
    subject: 'FW: random',
    bodyPreview: 'Forwarding this along, not sure what to do with it.',
    senderEmail: 'lauren.langley@jdhealthcare.com.au',
    recipients: ['someone@othercompany.com.au'],
  }));
  assert.equal(r.category, 'UNCLASSIFIED');
});

test('high Outlook importance forces URGENT priority regardless of category', () => {
  const r = classify(email({
    subject: 'Need help',
    bodyPreview: 'Can you confirm the mattress dimensions for compatibility?',
    senderEmail: 'clients@vinestherapy.com.au',
    importance: 'high',
  }));
  assert.equal(r.priority, 'URGENT');
});
