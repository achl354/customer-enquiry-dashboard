const COMPANY_DOMAIN = 'jdhealthcare.com.au';

const CATEGORIES = [
  'EQUIPMENT_FAULT',
  'BACKORDER_NOTICE',
  'PO_ETA_REQUEST',
  'INVOICE_BILLING',
  'QUOTE_PRICING',
  'PRODUCT_ENQUIRY',
  'SUPPLIER_VENDOR',
  'INTERNAL',
  'SPAM_NOTIFICATION',
  'UNCLASSIFIED',
];

const PRIORITIES = ['URGENT', 'HIGH', 'NORMAL', 'LOW'];

// Known health-department / institutional buyer domains -> friendly org name.
const KNOWN_ORG_DOMAINS = {
  'health.nsw.gov.au': 'NSW Health',
  'health.sa.gov.au': 'SA Health',
  'sa.gov.au': 'SA Health',
  'healthsharevic.org.au': 'HealthShare Victoria',
  'ths.tas.gov.au': 'Tasmania Health (DoH)',
  'health.wa.gov.au': 'WA Health',
  'thewomens.org.au': "The Royal Women's Hospital",
  'healthecare.com.au': 'Healthecare (Maitland Private)',
};

const KNOWN_SUPPLIER_DOMAINS = [
  'aneticaid.com',
  'activtec.com.au',
  'servicemed.com.au',
];

const KNOWN_NOISE_SENDERS = [
  'quarantine@messaging.microsoft.com',
  'learntocare.com.au',
];

// A customer who already fixed the problem themselves and is sharing feedback
// reads very differently from an active fault report, even when both mention
// the same physical issue — confirmed by real replies in Sent Items (the
// "Push Ortho Thumb Brace" thread got a warm feedback-style reply, not an
// escalation).
const SELF_RESOLVED_SIGNALS = [
  'i have sorted',
  "i've sorted",
  'sorted it out',
  'i fixed',
  'we fixed',
  'resolved it myself',
  'managed to fix',
  'great product',
  'wonderful feedback',
];

function domainOf(email) {
  if (!email) return '';
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).toLowerCase();
}

function orgNameForDomain(domain) {
  if (KNOWN_ORG_DOMAINS[domain]) return KNOWN_ORG_DOMAINS[domain];
  const parts = domain.split('.');
  if (parts.length === 0) return domain;
  return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
}

function extractPoNumber(text) {
  const patterns = [
    /purchase order\s*(?:number)?\s*[:#]?\s*([A-Z0-9-]{5,20})/i,
    /\bPO\s*(?:#|number|no\.?)?\s*[:#]?\s*([A-Z0-9-]{5,20})/i,
    /\bPO[#:\s]([A-Z0-9-]{5,20})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1] && !/^(BOX|THE|FOR)$/i.test(m[1])) return m[1].toUpperCase();
  }
  return null;
}

function extractQuoteNumber(text) {
  const m = text.match(/\bQ\s?(\d{4,6})\b/i);
  return m ? `Q${m[1]}` : null;
}

function includesAny(haystack, needles) {
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n));
}

/**
 * Classify a single enquiry email into category, priority, extracted fields,
 * and a suggested next action for customer service staff.
 *
 * @param {object} email
 * @param {string} email.subject
 * @param {string} email.bodyPreview
 * @param {string} email.senderEmail
 * @param {string[]} email.recipients
 * @param {string} email.importance - 'low' | 'normal' | 'high'
 * @param {boolean} email.hasAttachments
 */
function classify(email) {
  const subject = email.subject || '';
  const body = email.bodyPreview || '';
  const text = `${subject}\n${body}`;
  const senderDomain = domainOf(email.senderEmail);
  const recipients = email.recipients || [];

  const isInternalSender = senderDomain === COMPANY_DOMAIN;
  const hasExternalRecipient = recipients.some((r) => domainOf(r) !== COMPANY_DOMAIN);

  let category = 'UNCLASSIFIED';

  if (includesAny(email.senderEmail || '', KNOWN_NOISE_SENDERS) || includesAny(senderDomain, KNOWN_NOISE_SENDERS)) {
    category = 'SPAM_NOTIFICATION';
  } else if (isInternalSender && !hasExternalRecipient) {
    category = 'INTERNAL';
  } else if (
    includesAny(text, ['not inflating', 'not turning', 'malfunction', 'not working', 'stopped working', 'fault', 'broken', 'digs into', 'does not fit', "doesn't fit"])
  ) {
    category = 'EQUIPMENT_FAULT';
  } else if (includesAny(text, ['backorder'])) {
    category = 'BACKORDER_NOTICE';
  } else if (includesAny(text, ['overbilled', 'overbilling', 'invoice', 'payment req', 'inv#', 'inv ', 'invoice#'])) {
    category = 'INVOICE_BILLING';
  } else if (
    includesAny(text, ['purchase order', 'po#', 'eta', 'dispatch', 'despatch', 'consignment', 'delivery date', 'need by date']) ||
    Object.keys(KNOWN_ORG_DOMAINS).some((d) => senderDomain === d || senderDomain.endsWith(`.${d}`))
  ) {
    category = 'PO_ETA_REQUEST';
  } else if (includesAny(text, ['quote', 'pricing', 'special pricing', 'price list', 'quotation'])) {
    category = 'QUOTE_PRICING';
  } else if (KNOWN_SUPPLIER_DOMAINS.some((d) => senderDomain === d)) {
    category = 'SUPPLIER_VENDOR';
  } else if (!isInternalSender) {
    category = 'PRODUCT_ENQUIRY';
  }

  // --- Priority ---
  const isSelfResolvedFeedback = category === 'EQUIPMENT_FAULT' && includesAny(text, SELF_RESOLVED_SIGNALS);

  let priority = 'NORMAL';
  const urgentSignals =
    email.importance === 'high' ||
    includesAny(subject, ['urgent', 'asap']) ||
    (category === 'EQUIPMENT_FAULT' && !isSelfResolvedFeedback);
  const lowSignals = category === 'INTERNAL' || category === 'SPAM_NOTIFICATION' || category === 'SUPPLIER_VENDOR';

  if (urgentSignals) {
    priority = 'URGENT';
  } else if (category === 'BACKORDER_NOTICE' || (category === 'PO_ETA_REQUEST' && includesAny(text, ['resend', 'again', 'still outstanding', 'overdue']))) {
    priority = 'HIGH';
  } else if (lowSignals) {
    priority = 'LOW';
  }

  // --- Extracted fields ---
  const poNumber = extractPoNumber(text);
  const quoteNumber = extractQuoteNumber(text);
  const facility = isInternalSender ? null : orgNameForDomain(senderDomain);

  // --- Suggested action ---
  const suggestedAction = suggestedActionFor(category, { poNumber, quoteNumber, facility, isSelfResolvedFeedback });

  return {
    category,
    priority,
    extractedFields: {
      poNumber,
      quoteNumber,
      facility,
      senderDomain,
    },
    suggestedAction,
  };
}

// Suggested actions below are grounded in real Sent Items replies from
// sales@jdhealthcare.com.au (see backend/docs/response-patterns.md), not
// generic guesses — e.g. PO/ETA and equipment-fault replies both route
// through an internal check before anything goes back to the customer.
function suggestedActionFor(category, { poNumber, quoteNumber, facility, isSelfResolvedFeedback }) {
  switch (category) {
    case 'EQUIPMENT_FAULT':
      if (isSelfResolvedFeedback) {
        return 'Customer already resolved this themselves and is sharing feedback — reply warmly, thank them, and address any specific detail they raised (e.g. sizing). No escalation needed unless they request a replacement part.';
      }
      return 'Forward internally to Purchasing (cc the manufacturer if needed) with a short structured summary — what broke, suspected cause, and a request to confirm replacement part availability & price — rather than replying to the customer directly yet.';
    case 'BACKORDER_NOTICE':
      return `Check container/stock status for ${facility || 'this account'}${poNumber ? ` (PO ${poNumber})` : ''} with Purchasing, then reply with a specific revised delivery window and an apology for the delay.`;
    case 'PO_ETA_REQUEST':
      return `Confirm ${poNumber ? `PO ${poNumber}'s` : "the referenced PO's"} dispatch/container status with Purchasing before replying. If delivered, attach Proof of Delivery; if not, give a specific revised delivery window with an apology for any delay.`;
    case 'INVOICE_BILLING':
      return 'Check tracking/dispatch records for Proof of Delivery, or loop in Accounts (accounts@jdhealthcare.com.au) for billing corrections; reply with the specific resolution (POD attached, credit note, etc.).';
    case 'QUOTE_PRICING':
      return `Confirm current stock and pricing with the sales rep${quoteNumber ? ` for quote ${quoteNumber}` : ''} before replying — send the quote if in stock, or a specific backorder ETA with an apology if not.`;
    case 'PRODUCT_ENQUIRY':
      return "If it's a simple factual/compatibility question, answer directly using the spec sheet (match the customer's exact figures). If it's a sales lead, trial request, or needs product expertise, forward internally to the relevant specialist with a short intro note.";
    case 'SUPPLIER_VENDOR':
      return 'Route to purchasing/procurement contact for parts sourcing follow-up.';
    case 'INTERNAL':
      return 'Internal thread — no customer-facing action needed.';
    case 'SPAM_NOTIFICATION':
      return 'No action needed; review security quarantine only if relevant.';
    default:
      return 'Review manually — could not confidently classify this enquiry.';
  }
}

module.exports = { classify, CATEGORIES, PRIORITIES, domainOf, orgNameForDomain };
