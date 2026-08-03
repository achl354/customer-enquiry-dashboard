const { ConfidentialClientApplication } = require('@azure/msal-node');

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_BATCH_URL = `${GRAPH_BASE}/$batch`;
const BATCH_CHUNK_SIZE = 20; // Graph's max sub-requests per $batch call
const PAGE_SIZE = 50;
// Bounds a single poll's total fetch regardless of window size or how many
// pages Graph has to offer — each message triggers classification (AI, if
// configured), so an unbounded backfill on a mailbox with a big backlog
// would mean an unbounded first API bill. Messages are fetched newest-first,
// so hitting this cap means the *oldest* messages inside the backfill
// window are the ones left uningested this cycle — lastPollAt still
// advances to "now" afterwards (see poller.js), so they are NOT
// automatically retried later. If this cap gets hit in practice, lower
// BACKFILL_DAYS or raise MAX_MESSAGES_PER_POLL rather than relying on a
// future poll.
const MAX_MESSAGES_PER_POLL = Number(process.env.MAX_MESSAGES_PER_POLL) || 500;
// Independent of MAX_MESSAGES_PER_POLL on purpose: that cap only stops the
// loop once `messages` actually grows, so a degenerate Graph response
// (an empty `value` page that still carries a non-null @odata.nextLink)
// would otherwise loop forever, since neither exit condition is ever met.
const MAX_PAGES = Math.ceil(MAX_MESSAGES_PER_POLL / PAGE_SIZE) + 10;

function isConfigured() {
  return !!(process.env.TENANT_ID && process.env.CLIENT_ID && process.env.CLIENT_SECRET && process.env.MAILBOX);
}

function getMsalClient() {
  return new ConfidentialClientApplication({
    auth: {
      clientId: process.env.CLIENT_ID,
      authority: `https://login.microsoftonline.com/${process.env.TENANT_ID}`,
      clientSecret: process.env.CLIENT_SECRET,
    },
  });
}

async function getAccessToken() {
  const client = getMsalClient();
  const result = await client.acquireTokenByClientCredential({ scopes: [GRAPH_SCOPE] });
  return result.accessToken;
}

// On the very first poll, there's no lastPollAt to resume from — instead of
// the old behaviour (just the 50 most recent messages, full stop), backfill
// this many days of history instead. Configurable since mailboxes vary a
// lot in volume; only applies when sinceIso is null/undefined.
function backfillWindowStart() {
  const days = Number(process.env.BACKFILL_DAYS) || 30;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Fetch messages from the configured mailbox's Inbox received after
 * `sinceIso`, newest first, paginating through Graph's @odata.nextLink
 * until exhausted or MAX_MESSAGES_PER_POLL is hit. Requires application
 * permission Mail.Read (admin-consented), ideally scoped to this mailbox
 * via an Application Access Policy.
 */
async function fetchMessagesSince(sinceIso) {
  const token = await getAccessToken();
  const mailbox = encodeURIComponent(process.env.MAILBOX);
  const effectiveSince = sinceIso || backfillWindowStart();
  const select = '$select=id,internetMessageId,subject,bodyPreview,receivedDateTime,from,toRecipients,hasAttachments,importance,webLink,flag,conversationId,categories';
  let url = `${GRAPH_BASE}/users/${mailbox}/mailFolders/inbox/messages?${select}&$filter=receivedDateTime ge ${effectiveSince}&$orderby=receivedDateTime desc&$top=${PAGE_SIZE}`;

  const messages = [];
  let pageCount = 0;
  while (url && messages.length < MAX_MESSAGES_PER_POLL && pageCount < MAX_PAGES) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Graph API error ${res.status}: ${body}`);
    }
    const data = await res.json();
    messages.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
    pageCount += 1;
  }

  if (pageCount >= MAX_PAGES && url) {
    console.warn(
      `[graph-client] Hit MAX_PAGES (${MAX_PAGES}) with more pages still available and only ${messages.length} ` +
      `messages collected — Graph may be returning sparse/empty pages. Stopping this cycle rather than looping indefinitely.`
    );
  } else if (url) {
    console.warn(
      `[graph-client] Hit MAX_MESSAGES_PER_POLL (${MAX_MESSAGES_PER_POLL}) with more pages still available — ` +
      `the oldest messages in this window were left out this cycle. Lower BACKFILL_DAYS or raise ` +
      `MAX_MESSAGES_PER_POLL if this recurs.`
    );
  }

  return messages.slice(0, MAX_MESSAGES_PER_POLL).map(toRawEmail);
}

function toRawEmail(msg) {
  return {
    graphMessageId: msg.id,
    internetMessageId: msg.internetMessageId,
    receivedAt: msg.receivedDateTime,
    senderName: msg.from?.emailAddress?.name || null,
    senderEmail: msg.from?.emailAddress?.address || null,
    recipients: (msg.toRecipients || []).map((r) => r.emailAddress?.address).filter(Boolean),
    subject: msg.subject || '',
    bodyPreview: msg.bodyPreview || '',
    hasAttachments: !!msg.hasAttachments,
    importance: msg.importance || 'normal',
    webLink: msg.webLink || null,
    flagStatus: msg.flag?.flagStatus || null,
    categories: msg.categories || [],
    conversationId: msg.conversationId || null,
  };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// A literal single quote inside an OData string literal must be doubled
// (O'Brien -> 'O''Brien'), same idea as SQL string escaping — encodeURIComponent
// alone doesn't touch "'" at all, so a conversationId containing one would
// silently break/mis-filter this query instead of erroring loudly.
function escapeODataString(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * Fetch the current Outlook follow-up flag AND category tags for a set of
 * messages (by Graph message id), via the $batch endpoint. The follow-up
 * flag was the original plan for detecting "done", but checking real Sent
 * Items showed it's barely used in practice — genuinely-handled threads
 * routinely have no flag, or one left at 'flagged' rather than 'complete'.
 * Categories are a separate, currently-unused Outlook feature in this
 * mailbox, so they're a cleaner channel for an explicit "Resolved"/"No
 * Action Needed" tag without depending on a habit the team doesn't have.
 * Returns a Map of messageId -> { flagStatus, categories } on success, or
 * { missing: true } for a confirmed 404 (message deleted, or moved
 * somewhere its ID no longer resolves — observed cause in this mailbox:
 * storage-quota cleanup deleting mail after it's been acted on, not before).
 * Any OTHER non-200 (rate limit, transient 5xx, etc.) is skipped entirely
 * rather than treated as missing — those aren't evidence the message is
 * actually gone, just that this one lookup failed.
 *
 * A failed $batch call for one chunk doesn't abort the rest — with dozens
 * of open enquiries split across several chunks, losing one chunk to a
 * transient error shouldn't throw away the sync data already fetched for
 * everything else. That chunk's messages are simply absent from the
 * returned Map this cycle (same as an individual 404 vs. any other
 * failure — no signal either way, not evidence of anything).
 */
async function fetchMessageFlags(messageIds) {
  if (messageIds.length === 0) return new Map();
  const token = await getAccessToken();
  const mailbox = encodeURIComponent(process.env.MAILBOX);
  const results = new Map();

  for (const batch of chunk(messageIds, BATCH_CHUNK_SIZE)) {
    try {
      const body = {
        requests: batch.map((id, i) => ({
          id: String(i),
          method: 'GET',
          url: `/users/${mailbox}/messages/${encodeURIComponent(id)}?$select=flag,categories`,
        })),
      };
      const res = await fetch(GRAPH_BATCH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Graph batch API error ${res.status}: ${errBody}`);
      }
      const data = await res.json();
      for (const r of data.responses || []) {
        const originalId = batch[Number(r.id)];
        if (r.status === 200) {
          results.set(originalId, {
            flagStatus: r.body?.flag?.flagStatus || null,
            categories: r.body?.categories || [],
          });
        } else if (r.status === 404) {
          results.set(originalId, { missing: true });
        }
        // Any other non-200 (rate limit, transient 5xx, etc.) is skipped
        // silently — not confirmation the message is gone, just a failed check.
      }
    } catch (err) {
      console.error(`[graph-client] fetchMessageFlags: chunk of ${batch.length} failed, skipping it this cycle:`, err.message);
    }
  }

  return results;
}

/**
 * For each { graphMessageId, conversationId } pair, check Sent Items for any
 * message in the same conversation — i.e. "has staff already replied to or
 * forwarded this enquiry?" — via the $batch endpoint. Returns a Map of
 * graphMessageId -> { hasReply, recipients } where `recipients` is every
 * to/cc address across matching Sent Items messages (used by the caller to
 * tell a customer-facing reply from a purely internal forward). A
 * conversationId that no longer resolves (e.g. very old/purged mail) is
 * skipped silently rather than failing the whole batch — and, same as
 * fetchMessageFlags, a failed $batch call for one chunk doesn't lose the
 * sync data already fetched for every other chunk.
 */
async function fetchReplyStatus(items) {
  if (items.length === 0) return new Map();
  const token = await getAccessToken();
  const mailbox = encodeURIComponent(process.env.MAILBOX);
  const results = new Map();

  for (const batch of chunk(items, BATCH_CHUNK_SIZE)) {
    try {
      const body = {
        requests: batch.map((item, i) => ({
          id: String(i),
          method: 'GET',
          url: `/users/${mailbox}/mailFolders/sentitems/messages?$filter=conversationId eq '${encodeURIComponent(escapeODataString(item.conversationId))}'&$select=toRecipients,ccRecipients,sentDateTime&$orderby=sentDateTime desc&$top=3`,
        })),
      };
      const res = await fetch(GRAPH_BATCH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Graph batch API error ${res.status}: ${errBody}`);
      }
      const data = await res.json();
      for (const r of data.responses || []) {
        const item = batch[Number(r.id)];
        if (r.status !== 200) continue; // skip silently, e.g. conversationId no longer valid
        const sentMessages = r.body?.value || [];
        const recipients = sentMessages
          .flatMap((m) => [...(m.toRecipients || []), ...(m.ccRecipients || [])])
          .map((rec) => rec.emailAddress?.address)
          .filter(Boolean);
        results.set(item.graphMessageId, { hasReply: sentMessages.length > 0, recipients });
      }
    } catch (err) {
      console.error(`[graph-client] fetchReplyStatus: chunk of ${batch.length} failed, skipping it this cycle:`, err.message);
    }
  }

  return results;
}

/**
 * Fetch every message in a conversation, chronologically, across the whole
 * mailbox (not folder-scoped, since a conversation spans Inbox/Sent Items/
 * elsewhere) — used for on-demand draft generation so a follow-up draft can
 * account for what's already been said instead of drafting blind. Single
 * request, not batched — only called one enquiry at a time (when staff
 * click "Generate draft"), unlike the bulk per-poll flag/reply syncs.
 */
async function fetchConversationMessages(conversationId) {
  const token = await getAccessToken();
  const mailbox = encodeURIComponent(process.env.MAILBOX);
  const select = 'subject,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview';
  // No $orderby here on purpose — combining a mailbox-wide $filter with
  // $orderby on a different property is what Graph's "InefficientFilter"
  // (400, "restriction or sort order is too complex") rejects in practice,
  // even though each clause works fine alone. Sorting the (small, $top=25)
  // result client-side avoids the combination entirely.
  const url = `${GRAPH_BASE}/users/${mailbox}/messages?$filter=conversationId eq '${encodeURIComponent(escapeODataString(conversationId))}'&$select=${select}&$top=25`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph API error ${res.status}: ${body}`);
  }
  const data = await res.json();
  return (data.value || [])
    .map((msg) => ({
      senderName: msg.from?.emailAddress?.name || null,
      senderEmail: msg.from?.emailAddress?.address || null,
      recipients: (msg.toRecipients || []).map((r) => r.emailAddress?.address).filter(Boolean),
      sentAt: msg.sentDateTime || msg.receivedDateTime,
      bodyPreview: msg.bodyPreview || '',
    }))
    .sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));
}

/**
 * Fetch the full plain-text body of a single message, on demand — the
 * bodyPreview stored at ingest time is Graph's own ~255-character truncated
 * preview, not the full message, and fetching/storing the full body for
 * every ingested email upfront would be wasted storage/Graph calls for
 * enquiries nobody ever opens. Only called when staff click to expand one.
 */
async function fetchFullBody(graphMessageId) {
  const token = await getAccessToken();
  const mailbox = encodeURIComponent(process.env.MAILBOX);
  const url = `${GRAPH_BASE}/users/${mailbox}/messages/${encodeURIComponent(graphMessageId)}?$select=body`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      // Plain text instead of Graph's default HTML — this is only ever
      // displayed as plain text, so asking Graph to convert it up front
      // avoids needing to sanitize/render HTML on the frontend.
      Prefer: 'outlook.body-content-type="text"',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph API error ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.body?.content || '';
}

module.exports = {
  isConfigured,
  fetchMessagesSince,
  fetchMessageFlags,
  fetchReplyStatus,
  fetchConversationMessages,
  fetchFullBody,
  toRawEmail,
};
