const Anthropic = require('@anthropic-ai/sdk');
const { domainOf, orgNameForDomain } = require('../triage/classify');

// Validated against 5 edge cases (self-resolved feedback vs. genuine fault,
// price-discrepancy vs. backorder, sales-lead override, formal complaint) —
// matched Claude Opus 5's category/priority on all five at comparable or
// higher confidence, at ~60% lower cost during the introductory pricing
// window. Classification/extraction isn't the hardest reasoning task Claude
// does, so Sonnet-tier is the right fit here rather than defaulting to Opus.
const MODEL = 'claude-sonnet-5';

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

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: CATEGORIES },
    priority: { type: 'string', enum: PRIORITIES },
    confidence: {
      type: 'number',
      description: 'How confident you are in this category, from 0 (guessing) to 1 (certain).',
    },
    extractedFields: {
      type: 'object',
      properties: {
        poNumber: nullableString,
        quoteNumber: nullableString,
        facility: {
          ...nullableString,
          description: "The customer's organisation/facility name (e.g. 'NSW Health', 'Epworth HealthCare'), not their personal name.",
        },
        cityTag: {
          ...nullableString,
          description: "The bracketed city tag if the subject looks like '[SYDNEY] Enquiry from JD Healthcare Group Website', else null.",
        },
      },
      required: ['poNumber', 'quoteNumber', 'facility', 'cityTag'],
      additionalProperties: false,
    },
    reasoning: {
      type: 'string',
      description: 'One sentence on why you picked this category and priority.',
    },
    suggestedAction: {
      type: 'string',
      description: 'A concrete next step for the customer service staff member handling this, grounded in how this team actually operates (see system prompt). Prefer a specific routing instruction over a generic one.',
    },
    draftReply: {
      ...nullableString,
      description:
        'A ready-to-send draft email in the house style (see system prompt): a direct customer reply, an immediate customer acknowledgment (complaints/genuine faults — separate from the internal routing in suggestedAction), or a short internal handoff/forward note for enquiries that are never answered directly. Null for INTERNAL/SPAM_NOTIFICATION/UNCLASSIFIED, or for fully-automated "do not reply" system notifications where no message is ever sent.',
    },
  },
  required: ['category', 'priority', 'confidence', 'extractedFields', 'reasoning', 'suggestedAction', 'draftReply'],
  additionalProperties: false,
};

// Condensed from backend/docs/response-patterns.md (a ~350-email research pass
// over Sent Items) — keep this in sync if that doc changes materially.
const SYSTEM_PROMPT = `You triage incoming emails for sales@jdhealthcare.com.au, a durable medical equipment supplier serving Australian health departments and hospitals. Classify each email and extract structured fields to help customer service staff work a prioritized queue instead of a flat inbox.

## Categories
- PRODUCT_COMPLAINT: formal/adverse-event complaints. Look for "customer complaint", "discontinue use", "LOT number", "adverse event" language — this is procedural (capture product code/LOT/expiry, tell customer to discontinue use), not apologetic. Routes to Graham Lade and Scott Borresen, not Purchasing. Check this BEFORE equipment fault — adverse events rarely use "broken"/"fault" words.
- EQUIPMENT_FAULT: a genuine hardware fault/breakage. Routes internally to Purchasing (cc manufacturer) with a structured summary of what broke — NOT answered directly to the customer. EXCEPTION: if the customer already fixed the issue themselves and is just sharing feedback (e.g. "I have sorted it out", positive feedback with a minor comment), this is NOT urgent — it gets a warm, non-escalating reply. Judge this by sentiment/resolution status, not just fault keywords.
- BACKORDER_NOTICE: automated backorder-past-due notice from a buyer's procurement system.
- PO_ETA_REQUEST: purchase order or dispatch/ETA chase from a health department or facility. Staff check stock/container status internally before replying — either "delivered, POD attached" or a specific revised delivery window with an apology. Watch for "ON HOLD" + "price discrepancy" / "amended PO" language — that's a pricing mismatch blocking dispatch, not a stock delay, and needs a different (HIGH priority) action: ask for an amended PO with corrected pricing.
- RETURNS_CREDIT: goods returns, credit notes, "item ordered in error". Factual reply (confirm received, process credit note) — no apology needed even if the original order was our error.
- INVOICE_BILLING: invoice disputes, overbilling, payment/remittance queries. Often resolved with Proof of Delivery or by looping in Accounts (accounts@jdhealthcare.com.au).
- LOGISTICS_FREIGHT: courier/freight coordination — consignment redirects, pickup confirmations, proof-of-delivery threads with couriers (Steadfast Logistics, PACK & SEND, TNT, FedEx). Not a product or supplier enquiry — coordinate directly with the courier contact.
- QUOTE_PRICING: quote requests/follow-ups, pricing questions. Same "check stock/pricing before replying" pattern as PO/ETA.
- PRODUCT_ENQUIRY: general customer product/compatibility/hire questions, sales leads, or website contact-form enquiries. Website enquiries carry a city tag in the subject like "[SYDNEY] Enquiry from JD Healthcare Group Website" or a "New sales lead for: <product>" subject — these are ALWAYS forwarded to a territory rep, never answered directly, regardless of what the body says (even if it mentions pricing). City routing (authoritative, from the business owner): SYDNEY->Simon White, MELBOURNE->Allan Baker / Paul McKay, ADELAIDE->Miffy Boden, PERTH (WA)->Edan Hanley, HOBART (Tas)->Atul Gupta, NEWCASTLE->Minh-Thu Cao Xuan, AUCKLAND->Medix21 (external distributor). Trial requests (e.g. "trial request", "would like to trial", "book a trial") are a distinct sub-case — route to Graham Lade AND the responsible territory rep for the customer's region, not just the rep alone. Simple factual questions (e.g. cleaning instructions) can be answered directly from a spec sheet.
- SUPPLIER_VENDOR: correspondence with parts suppliers/manufacturers (not couriers) for sourcing.
- INTERNAL: staff-to-staff threads that happen to include sales@ — no customer-facing action needed.
- SPAM_NOTIFICATION: quarantine alerts, marketing/training newsletters — no action needed.
- UNCLASSIFIED: only if truly nothing above fits after genuine consideration.

## Tone and reply structure (for suggestedAction grounding)
Staff replies follow: greeting by first name -> "Thank you for contacting us." -> category-specific body -> apology line if there was a delay -> close -> signature (currently "Operations Coordinator", was "Client Services Executive" earlier — titles change over time, don't assume a fixed one). Tone is warm and relationship-driven, not purely transactional. A large share of enquiries are actually routed to the right internal person rather than answered directly by whoever reads the inbox — reflect that in suggestedAction when applicable (say who to route to, not just "reply to customer").

## Drafting draftReply
Write a complete, ready-to-send draft — the staff member reviews and sends it, not writes from scratch. Three distinct shapes depending on the category:

- **Direct customer reply** (PO_ETA_REQUEST, RETURNS_CREDIT, INVOICE_BILLING, QUOTE_PRICING, BACKORDER_NOTICE, LOGISTICS_FREIGHT, or a PRODUCT_ENQUIRY with no city tag/trial request): write the actual reply to the customer, following the house structure above. Greet them by first name if you can identify one from the sender name or body (e.g. "Hi Rebecca,"), otherwise "Hi there,". Reference the specific PO/quote number, facility, or product mentioned. Since you don't know internal stock/dispatch status, phrase anything that depends on it as what staff will confirm (e.g. "I'm just confirming the dispatch status with our warehouse team and will follow up shortly with a firm date") rather than inventing a fake status. Close with "Kind regards,\n[Your name]\nOperations Coordinator\nJD Healthcare Group".
- **Immediate customer acknowledgment** (PRODUCT_COMPLAINT, and EQUIPMENT_FAULT that's a genuine fault, not self-resolved feedback): the customer is left waiting on something wrong with a product, so reply to them directly and immediately rather than routing first — real Sent Items show this happens before any internal technical sign-off comes back. Thank them for reporting it, and: for PRODUCT_COMPLAINT, ask them to have the customer discontinue use and provide the exact product code, LOT number, and expiry; for EQUIPMENT_FAULT, acknowledge the fault and what info you need (e.g. photos, serial number). Do NOT invent a technical diagnosis or root cause you don't know yet — just say staff are looking into it and will follow up with next steps as soon as possible. This is separate from suggestedAction, which still tells staff to route the investigation internally (e.g. to Graham Lade and Scott Borresen) — draftReply here is only the immediate customer-facing acknowledgment, not that internal step.
- **Internal handoff/routing note** (a PRODUCT_ENQUIRY with a city tag or trial request, SUPPLIER_VENDOR): write the short internal intro note staff actually send, in the observed style — e.g. "Hi Simon,\n\nCould you please assist [customer name] with the enquiry below when you get a chance?\n\nThanks,\n[Your name]" — addressed to the correct named person(s) from the routing rules above. These categories are never answered directly to the customer at all, so no acknowledgment reply is needed here.

Set draftReply to null for INTERNAL, SPAM_NOTIFICATION, or UNCLASSIFIED, and also for fully-automated "PLEASE DO NOT REPLY" system notifications (e.g. a government procurement system delivering a new PO) where the only real action is internal processing, not a reply or handoff email to anyone.

## Priority
URGENT: genuine equipment faults (not self-resolved), formal complaints, or explicit urgency (subject says URGENT/ASAP, or Outlook importance is high).
HIGH: backorder notices, price-discrepancy holds, or repeat/overdue PO chases ("resend", "still outstanding").
LOW: internal threads, spam, routine supplier correspondence.
NORMAL: everything else, including self-resolved feedback and routine PO/ETA/quote requests.

Be honest about confidence — if the email is ambiguous or doesn't clearly fit a category, say so with a lower confidence score rather than forcing a confident-sounding guess.`;

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

function buildUserContent(email) {
  const lines = [
    `Subject: ${email.subject || '(no subject)'}`,
    `From: ${email.senderName ? `${email.senderName} <${email.senderEmail}>` : email.senderEmail}`,
    `To/Recipients: ${(email.recipients || []).join(', ')}`,
    `Importance: ${email.importance || 'normal'}`,
    `Has attachments: ${email.hasAttachments ? 'yes' : 'no'}`,
    '',
    'Body:',
    email.bodyPreview || '(empty)',
  ];
  return lines.join('\n');
}

/**
 * Classify a raw email using Claude, returning the same shape as the
 * rule-based classifier in ../triage/classify.js: { category, priority,
 * extractedFields, suggestedAction }, plus a confidence score and the
 * model's one-line reasoning.
 *
 * @param {object} email
 * @param {string} [model] - override the default model (e.g. for A/B testing)
 */
async function classify(email, model = MODEL) {
  const anthropic = getClient();

  const response = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    thinking: { type: 'disabled' },
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: RESPONSE_SCHEMA },
    },
    // The system prompt is identical on every call (taxonomy + grounding) —
    // cache it so high-volume classification only pays full input price once
    // per cache window, not on every single email.
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: buildUserContent(email) }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined to classify this email (safety refusal)');
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text content in Claude response');

  const parsed = JSON.parse(textBlock.text);
  const senderDomain = domainOf(email.senderEmail);
  const isInternalSender = senderDomain === 'jdhealthcare.com.au';

  return {
    category: parsed.category,
    priority: parsed.priority,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
    extractedFields: {
      poNumber: parsed.extractedFields.poNumber,
      quoteNumber: parsed.extractedFields.quoteNumber,
      facility: isInternalSender ? null : parsed.extractedFields.facility || orgNameForDomain(senderDomain),
      senderDomain,
      cityTag: parsed.extractedFields.cityTag,
    },
    suggestedAction: parsed.suggestedAction,
    draftReply: parsed.draftReply,
  };
}

module.exports = { classify, isConfigured, CATEGORIES, PRIORITIES };
