const COMPANY_DOMAIN = 'jdhealthcare.com.au';

const CATEGORIES = [
  'PRODUCT_COMPLAINT',
  'EQUIPMENT_FAULT',
  'BACKORDER_NOTICE',
  'PO_ETA_REQUEST',
  'RETURNS_CREDIT',
  'INVOICE_BILLING',
  'LOGISTICS_FREIGHT',
  'QUOTE_PRICING',
  'PRODUCT_ENQUIRY',
  'SUPPLIER_VENDOR',
  'INTERNAL',
  'SPAM_NOTIFICATION',
  'UNCLASSIFIED',
];

const PRIORITIES = ['URGENT', 'HIGH', 'NORMAL', 'LOW'];

// Known health-department / institutional buyer domains -> friendly org name.
// Kept to the highest-volume senders seen across a 350+ email sample — the
// domain-derived title-case fallback in orgNameForDomain() handles the long
// tail reasonably, so this list is deliberately not exhaustive.
const KNOWN_ORG_DOMAINS = {
  'health.nsw.gov.au': 'NSW Health',
  'health.sa.gov.au': 'SA Health',
  'sa.gov.au': 'SA Health',
  'healthsharevic.org.au': 'HealthShare Victoria',
  'ths.tas.gov.au': 'Tasmania Health (DoH)',
  'health.wa.gov.au': 'WA Health',
  'thewomens.org.au': "The Royal Women's Hospital",
  'healthecare.com.au': 'Healthecare (Maitland Private)',
  'svha.org.au': "St Vincent's Health Australia",
  'epworth.org.au': 'Epworth HealthCare',
  'calvarycare.org.au': 'Calvary Health Care',
  'healthscope.com.au': 'Healthscope',
  'ramsayhealth.com.au': 'Ramsay Health Care',
  'monashhealth.org': 'Monash Health',
  'bendigohealth.org.au': 'Bendigo Health',
  'act.gov.au': 'ACT Health',
  'ambulance.qld.gov.au': 'Queensland Ambulance',
  'ambulance.vic.gov.au': 'Ambulance Victoria',
  'novita.org.au': 'Novita',
  'easternhealth.org.au': 'Eastern Health',
  'petermac.org': 'Peter Mac',
  'sjog.org.au': "St John of God Health Care",
};

const KNOWN_SUPPLIER_DOMAINS = ['aneticaid.com', 'activtec.com.au', 'servicemed.com.au'];

const KNOWN_LOGISTICS_DOMAINS = ['steadfastlogistics.com.au', 'packsend.com.au', 'tnt.com.au', 'fedex.com'];

const KNOWN_NOISE_SENDERS = ['quarantine@messaging.microsoft.com', 'learntocare.com.au'];

// City tag in "[CITY] Enquiry from JD Healthcare Group Website" subjects ->
// the territory rep it gets forwarded to. Corrected directly by the business
// owner (2026-07-31) — this is the authoritative table, not inferred from
// email samples.
const CITY_ROUTING = {
  SYDNEY: 'Simon White',
  MELBOURNE: 'Allan Baker / Paul',
  ADELAIDE: 'Miffy Boden',
  PERTH: 'Edan Hanley', // WA
  HOBART: 'Atul Gupta', // Tas
  NEWCASTLE: 'Minh-Thu Cao Xuan',
  AUCKLAND: 'Medix21 (external distributor)',
};

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

// Adverse-event / formal complaint language rarely overlaps with generic
// "broken"/"fault" wording, so it needs its own check ahead of EQUIPMENT_FAULT
// or it gets misread as a routine spare-parts request.
const COMPLAINT_SIGNALS = ['customer complaint', 'discontinue use', 'lot number', 'adverse event'];

const RETURNS_SIGNALS = ['goods return', 'credit note', 'return label', 'item order in error', 'returned items'];

// Distinct from a genuine stock backorder: the order is held because the
// customer's PO doesn't match current pricing, not because of a supply delay.
const PRICE_DISCREPANCY_SIGNALS = ['price discrepancy', 'amended po', 'kindly update the pricing'];

const LOGISTICS_SIGNALS = ['consignment', 'proof of delivery', 'redirect', 'pickup confirmation', 'pod attached'];

const TRIAL_SIGNALS = ['trial request', 'trial of', 'would like to trial', 'request a trial', 'book a trial'];

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

function extractCityTag(subject) {
  const m = subject.match(/^\[([A-Z]+)\]/);
  return m ? m[1].toUpperCase() : null;
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
  const cityTag = extractCityTag(subject);

  let category = 'UNCLASSIFIED';

  if (includesAny(email.senderEmail || '', KNOWN_NOISE_SENDERS) || includesAny(senderDomain, KNOWN_NOISE_SENDERS)) {
    category = 'SPAM_NOTIFICATION';
  } else if (isInternalSender && !hasExternalRecipient) {
    category = 'INTERNAL';
  } else if (includesAny(text, COMPLAINT_SIGNALS)) {
    category = 'PRODUCT_COMPLAINT';
  } else if (includesAny(subject, ['enquiry from jd healthcare group website', 'new sales lead for'])) {
    // Unambiguous forward/routing pattern — takes precedence over generic
    // body keywords (e.g. a website enquiry that mentions "pricing" would
    // otherwise get swallowed by the QUOTE_PRICING check below).
    category = 'PRODUCT_ENQUIRY';
  } else if (
    includesAny(text, ['not inflating', 'not turning', 'malfunction', 'not working', 'stopped working', 'fault', 'broken', 'digs into', 'does not fit', "doesn't fit"])
  ) {
    category = 'EQUIPMENT_FAULT';
  } else if (includesAny(text, ['backorder'])) {
    category = 'BACKORDER_NOTICE';
  } else if (includesAny(text, RETURNS_SIGNALS)) {
    category = 'RETURNS_CREDIT';
  } else if (includesAny(text, ['overbilled', 'overbilling', 'invoice', 'payment req', 'inv#', 'inv ', 'invoice#'])) {
    category = 'INVOICE_BILLING';
  } else if (KNOWN_LOGISTICS_DOMAINS.some((d) => senderDomain === d) || includesAny(text, LOGISTICS_SIGNALS)) {
    category = 'LOGISTICS_FREIGHT';
  } else if (
    includesAny(text, ['purchase order', 'po#', 'eta', 'dispatch', 'despatch', 'delivery date', 'need by date']) ||
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
  const isPriceDiscrepancy = category === 'PO_ETA_REQUEST' && includesAny(text, PRICE_DISCREPANCY_SIGNALS);

  let priority = 'NORMAL';
  const urgentSignals =
    email.importance === 'high' ||
    includesAny(subject, ['urgent', 'asap']) ||
    category === 'PRODUCT_COMPLAINT' ||
    (category === 'EQUIPMENT_FAULT' && !isSelfResolvedFeedback);
  const lowSignals = category === 'INTERNAL' || category === 'SPAM_NOTIFICATION' || category === 'SUPPLIER_VENDOR';

  if (urgentSignals) {
    priority = 'URGENT';
  } else if (
    isPriceDiscrepancy ||
    category === 'BACKORDER_NOTICE' ||
    (category === 'PO_ETA_REQUEST' && includesAny(text, ['resend', 'again', 'still outstanding', 'overdue']))
  ) {
    priority = 'HIGH';
  } else if (lowSignals) {
    priority = 'LOW';
  }

  // --- Extracted fields ---
  const poNumber = extractPoNumber(text);
  const quoteNumber = extractQuoteNumber(text);
  const facility = isInternalSender ? null : orgNameForDomain(senderDomain);
  const isTrialRequest = category === 'PRODUCT_ENQUIRY' && includesAny(text, TRIAL_SIGNALS);

  // --- Suggested action ---
  const suggestedAction = suggestedActionFor(category, {
    poNumber,
    quoteNumber,
    facility,
    isSelfResolvedFeedback,
    isPriceDiscrepancy,
    cityTag,
    isTrialRequest,
  });

  return {
    category,
    priority,
    extractedFields: {
      poNumber,
      quoteNumber,
      facility,
      senderDomain,
      cityTag,
    },
    suggestedAction,
  };
}

// Suggested actions below are grounded in real Sent Items replies from
// sales@jdhealthcare.com.au (see backend/docs/response-patterns.md), not
// generic guesses — e.g. PO/ETA and equipment-fault replies both route
// through an internal check before anything goes back to the customer.
function suggestedActionFor(category, { poNumber, quoteNumber, facility, isSelfResolvedFeedback, isPriceDiscrepancy, cityTag, isTrialRequest }) {
  switch (category) {
    case 'PRODUCT_COMPLAINT':
      return 'Formal/adverse-event complaint — route to Graham Lade and Scott Borresen, ask the customer to discontinue use, and capture the product code, LOT number, and expiry before responding further.';
    case 'EQUIPMENT_FAULT':
      if (isSelfResolvedFeedback) {
        return 'Customer already resolved this themselves and is sharing feedback — reply warmly, thank them, and address any specific detail they raised (e.g. sizing). No escalation needed unless they request a replacement part.';
      }
      return 'Forward internally to Purchasing (cc the manufacturer if needed) with a short structured summary — what broke, suspected cause, and a request to confirm replacement part availability & price — rather than replying to the customer directly yet. If it looks like a genuine design/engineering fault (not just a spare part), it may need to go straight to the manufacturer\'s engineering team instead of Purchasing.';
    case 'BACKORDER_NOTICE':
      return `Check container/stock status for ${facility || 'this account'}${poNumber ? ` (PO ${poNumber})` : ''} with Purchasing, then reply with a specific revised delivery window and an apology for the delay.`;
    case 'PO_ETA_REQUEST':
      if (isPriceDiscrepancy) {
        return `This order is on hold due to a pricing mismatch, not a stock delay — reply with the corrected item price(s) and ask the customer to send an amended PO${poNumber ? ` for ${poNumber}` : ''} before it can be dispatched.`;
      }
      return `Confirm ${poNumber ? `PO ${poNumber}'s` : "the referenced PO's"} dispatch/container status with Purchasing before replying. If delivered, attach Proof of Delivery; if not, give a specific revised delivery window with an apology for any delay.`;
    case 'RETURNS_CREDIT':
      return 'Confirm the returned item(s) have been received, process/attach the credit note, and reply factually — no apology needed unless the return was our error.';
    case 'INVOICE_BILLING':
      return 'Check tracking/dispatch records for Proof of Delivery, or loop in Accounts (accounts@jdhealthcare.com.au) for billing corrections; reply with the specific resolution (POD attached, credit note, etc.).';
    case 'LOGISTICS_FREIGHT':
      return 'Coordinate directly with the courier/freight contact on the thread (consignment redirect, pickup, or proof of delivery) rather than treating this as a product enquiry.';
    case 'QUOTE_PRICING':
      return `Confirm current stock and pricing with the sales rep${quoteNumber ? ` for quote ${quoteNumber}` : ''} before replying — send the quote if in stock, or a specific backorder ETA with an apology if not.`;
    case 'PRODUCT_ENQUIRY': {
      const routedRep = cityTag && CITY_ROUTING[cityTag];
      if (isTrialRequest) {
        return `Trial request — route to Graham Lade and the responsible territory rep${routedRep ? ` (${routedRep})` : ''} rather than answering directly.`;
      }
      if (routedRep) {
        return `Website/sales-lead enquiry tagged [${cityTag}] — forward to ${routedRep} with a short intro note rather than answering directly.`;
      }
      return "If it's a simple factual/compatibility question, answer directly using the spec sheet (match the customer's exact figures). If it's a sales lead, trial request, or needs product expertise, forward internally to the relevant specialist with a short intro note.";
    }
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
