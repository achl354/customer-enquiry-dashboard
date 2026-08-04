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
// Separate, much higher cap for fetchAllMailboxMessagesSince below — that's
// a deliberate one-off historical catch-up across the whole mailbox, not
// the recurring per-minute Inbox poll MAX_MESSAGES_PER_POLL is tuned for.
const MAX_BACKFILL_MESSAGES = Number(process.env.MAX_BACKFILL_MESSAGES) || 5000;
const MAX_BACKFILL_PAGES = Math.ceil(MAX_BACKFILL_MESSAGES / PAGE_SIZE) + 10;
// Deliberate small pause between folder-tree calls (see fetchFolderTree) —
// a wide, deeply-nested tree is many sequential requests even with nothing
// throttling yet, so this spaces them out rather than firing as fast as
// possible and inviting a 429.
const FOLDER_WALK_DELAY_MS = Number(process.env.FOLDER_WALK_DELAY_MS) || 300;
// Safety net against a cyclic/malformed parentFolderId chain — real
// mailboxes don't nest this deep, so hitting this means something's wrong
// rather than "just needs a higher limit."
const MAX_FOLDER_DEPTH = 20;
// Purely a runaway-loop guard for fetchAllFolderMessagesSince below, not a
// deliberate truncation — at $top=999 this is ~200k messages in one folder
// since the given date, far beyond anything a real per-folder query since a
// specific date should ever return. No global cap across folders: this is
// an explicit one-off audit run, not routine polling, so completeness
// matters more than a bound on total runtime.
const MAX_FOLDER_MESSAGE_PAGES = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wraps a Graph GET with 429 handling — honors Retry-After when Graph sends
// one (observed ~60s in this mailbox), falls back to capped exponential
// backoff otherwise. Any other non-OK status still throws immediately, same
// as every other fetch in this file — only 429 gets retried.
async function fetchWithBackoff(url, token, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status !== 429) {
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Graph API error ${res.status}: ${body}`);
      }
      return res;
    }
    const retryAfterHeader = res.headers.get('Retry-After');
    const waitSec = retryAfterHeader ? Number(retryAfterHeader) : Math.min(2 ** attempt, 60);
    console.warn(`[graph-client] 429 rate limited — waiting ${waitSec}s (attempt ${attempt + 1}/${maxRetries}) for ${url}`);
    await sleep(waitSec * 1000);
  }
  throw new Error(`Graph API: exceeded ${maxRetries} retries after repeated 429s for ${url}`);
}

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

/**
 * Same idea as fetchMessagesSince, but mailbox-wide — /users/{mailbox}/messages
 * (no /mailFolders/{x}/ path segment) searches every folder, not just
 * Inbox. For catching up on historical mail that arrived, got resolved,
 * and was archived into a folder before this app was ever ingesting
 * anything — ordinary polling only ever looks at Inbox, so it would never
 * find those on its own no matter how long it ran (see routes/ingest.js's
 * /backfill-all-folders, which is what actually calls this).
 *
 * Not used for regular polling — staff's own new mail always lands in
 * Inbox first, so fetchMessagesSince already catches everything going
 * forward; this is strictly a one-time catch-up tool.
 *
 * Also captures parentFolderId and lastModifiedDateTime per message (unlike
 * fetchMessagesSince) so ingestEmail can set the correct status/resolved_at
 * immediately for mail that's already sitting outside Inbox, instead of
 * waiting a full poll cycle for syncFlagStatuses to notice it.
 *
 * `untilIso` is an optional, exclusive upper bound — pass it to backfill a
 * specific bounded window (e.g. re-checking a range where an earlier run
 * left a gap) instead of "since X through right now." Omit it for the
 * normal open-ended catch-up.
 */
async function fetchAllMailboxMessagesSince(sinceIso, untilIso) {
  const token = await getAccessToken();
  const mailbox = encodeURIComponent(process.env.MAILBOX);
  const inboxFolderId = await getInboxFolderId();
  const select =
    '$select=id,internetMessageId,subject,bodyPreview,receivedDateTime,from,toRecipients,hasAttachments,importance,webLink,flag,conversationId,categories,parentFolderId,lastModifiedDateTime';
  const filter = untilIso
    ? `receivedDateTime ge ${sinceIso} and receivedDateTime lt ${untilIso}`
    : `receivedDateTime ge ${sinceIso}`;
  let url = `${GRAPH_BASE}/users/${mailbox}/messages?${select}&$filter=${filter}&$orderby=receivedDateTime desc&$top=${PAGE_SIZE}`;

  const messages = [];
  let pageCount = 0;
  while (url && messages.length < MAX_BACKFILL_MESSAGES && pageCount < MAX_BACKFILL_PAGES) {
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

  if ((pageCount >= MAX_BACKFILL_PAGES || messages.length >= MAX_BACKFILL_MESSAGES) && url) {
    console.warn(
      `[graph-client] fetchAllMailboxMessagesSince hit its cap (${MAX_BACKFILL_MESSAGES} messages) with more ` +
      `pages still available — the oldest messages in this window were left out. Re-run with a narrower ` +
      `"since" date, or raise MAX_BACKFILL_MESSAGES, to pick up the rest.`
    );
  }

  return messages.slice(0, MAX_BACKFILL_MESSAGES).map((msg) => ({
    ...toRawEmail(msg),
    movedOutOfInbox: msg.parentFolderId !== inboxFolderId,
    lastModifiedDateTime: msg.lastModifiedDateTime || null,
  }));
}

/**
 * Recursively enumerate the FULL mail folder tree for a mailbox, from the
 * top-level folders down through every level of nesting — never by
 * displayName. Name-based folder lookup (e.g. Graph's
 * /mailFolders?$filter=displayName eq '...', or anything that falls back to
 * scanning the whole tree for a non-exact/non-well-known name) was tested
 * directly against this mailbox and found unreliable: some plain-looking
 * names resolved fine, others 404'd for no explainable reason (not
 * hierarchy, not smart-quote vs straight-quote — apostrophe'd names failed
 * even with the apostrophe stripped), and repeated failed lookups triggered
 * 429s since the underlying fallback apparently re-scans the mailbox each
 * time. Walking the tree by id, once, and keeping that map is the only
 * reliable approach.
 *
 * Returns every folder as { id, displayName, parentFolderId,
 * childFolderCount, totalItemCount, unreadItemCount, fullPath }, where
 * fullPath is reconstructed by walking each folder's parent chain (e.g.
 * "Inbox > Client Enquiries > 1. CUST SERVICE EMAILS") — the real nesting,
 * not the "Favorites" list Outlook's UI shows (that's a separate,
 * display-only grouping, not the actual folder hierarchy).
 */
async function fetchFolderTree(mailboxEmail) {
  const token = await getAccessToken();
  const mailbox = encodeURIComponent(mailboxEmail);
  const select = '$select=id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount';
  const folders = new Map();

  async function walk(url, depth) {
    if (depth > MAX_FOLDER_DEPTH) {
      console.warn(`[graph-client] fetchFolderTree: hit MAX_FOLDER_DEPTH (${MAX_FOLDER_DEPTH}) at ${url} — stopping this branch, likely a cyclic or malformed parentFolderId.`);
      return;
    }
    let currentUrl = url;
    while (currentUrl) {
      const res = await fetchWithBackoff(currentUrl, token);
      const data = await res.json();
      for (const f of data.value || []) {
        folders.set(f.id, {
          id: f.id,
          displayName: f.displayName,
          parentFolderId: f.parentFolderId || null,
          childFolderCount: f.childFolderCount,
          totalItemCount: f.totalItemCount,
          unreadItemCount: f.unreadItemCount,
        });
        if (f.childFolderCount > 0) {
          await sleep(FOLDER_WALK_DELAY_MS);
          await walk(`${GRAPH_BASE}/users/${mailbox}/mailFolders/${f.id}/childFolders?${select}&$top=100`, depth + 1);
        }
      }
      currentUrl = data['@odata.nextLink'] || null;
    }
  }

  await walk(`${GRAPH_BASE}/users/${mailbox}/mailFolders?${select}&$top=100`, 0);

  function fullPathFor(id, seen) {
    const folder = folders.get(id);
    if (!folder) return '(unknown parent)';
    if (seen.has(id)) return `${folder.displayName} (cycle detected)`;
    seen.add(id);
    if (!folder.parentFolderId || !folders.has(folder.parentFolderId)) return folder.displayName;
    return `${fullPathFor(folder.parentFolderId, seen)} > ${folder.displayName}`;
  }

  return Array.from(folders.values()).map((f) => ({ ...f, fullPath: fullPathFor(f.id, new Set()) }));
}

/**
 * Full audit pull: every message received on/after `sinceIso`, from EVERY
 * folder in the mailbox (not just leaves — a parent folder can hold
 * messages directly too), attributed with the folder it was found in.
 * Fetches the folder tree fresh (unless `folders` is supplied — see below)
 * so folder_path is always consistent with the current tree, then queries
 * /mailFolders/{id}/messages?$filter=receivedDateTime ge {sinceIso} for
 * each folder in turn, paginating fully via @odata.nextLink.
 *
 * A single folder failing (repeated 429s past fetchWithBackoff's retry
 * budget, a permissions quirk on a system folder, etc.) is recorded in
 * folderErrors and skipped — it does not abort the run, same reasoning as
 * every other bulk operation in this file: one bad folder out of ~380
 * shouldn't throw away everything already pulled from the rest.
 *
 * Returns { messages, folderErrors, foldersChecked }. Each message is
 * { folderId, folderPath, subject, sender, recipients, receivedDateTime,
 * lastModifiedDateTime, hasAttachments, conversationId, internetMessageId }.
 * lastModifiedDateTime is Graph's own "last touched" timestamp — a proxy
 * for when a message was filed/archived, NOT a confirmed move date (it
 * also updates on read-status, categorization, or flagging changes). The
 * caller (routes/ingest.js) is responsible for labeling it as such in any
 * output — this function itself makes no claim about what the timestamp
 * means beyond what Graph documents.
 */
// `folders` lets the caller pass an already-fetched tree (see
// routes/ingest.js — it fetches this upfront to set an X-Folders-Checked
// response header before streaming starts, so re-fetching it here would
// be a wasted duplicate walk); omit it to have this fetch its own.
// `onFolderMessages(folderMessages, folder)` fires once per folder, right
// after that folder's messages are fully paginated — the caller uses this
// to stream CSV rows to the HTTP response as they're found instead of
// buffering the entire ~380-folder walk (which can take many minutes)
// before sending anything. A proxy's idle/request timeout killing a
// several-minutes-silent connection was the actual cause of "the file
// never finishes downloading" — streaming keeps the connection active
// throughout instead.
async function fetchAllFolderMessagesSince(mailboxEmail, sinceIso, { folders, onFolderMessages } = {}) {
  const token = await getAccessToken();
  const mailbox = encodeURIComponent(mailboxEmail);
  const resolvedFolders = folders || (await fetchFolderTree(mailboxEmail));
  const select = '$select=id,internetMessageId,subject,receivedDateTime,lastModifiedDateTime,from,toRecipients,ccRecipients,hasAttachments,conversationId';

  const messages = [];
  const folderErrors = [];

  for (let i = 0; i < resolvedFolders.length; i += 1) {
    const folder = resolvedFolders[i];
    await sleep(FOLDER_WALK_DELAY_MS);
    if ((i + 1) % 25 === 0) {
      console.log(`[graph-client] fetchAllFolderMessagesSince: checked ${i + 1}/${resolvedFolders.length} folders, ${messages.length} messages so far`);
    }
    // $orderby=receivedDateTime alongside the matching $filter, same as
    // every other date-filtered query in this file (fetchMessagesSince,
    // fetchAllMailboxMessagesSince) — Graph's $filter on a date field
    // without a same-property $orderby is a known source of unreliable
    // results.
    let url = `${GRAPH_BASE}/users/${mailbox}/mailFolders/${folder.id}/messages?${select}&$filter=receivedDateTime ge ${sinceIso}&$orderby=receivedDateTime desc&$top=999`;
    let pageCount = 0;
    const folderMessages = [];
    try {
      while (url && pageCount < MAX_FOLDER_MESSAGE_PAGES) {
        const res = await fetchWithBackoff(url, token);
        const data = await res.json();
        for (const msg of data.value || []) {
          folderMessages.push({
            folderId: folder.id,
            folderPath: folder.fullPath,
            subject: msg.subject || '',
            sender: msg.from?.emailAddress
              ? `${msg.from.emailAddress.name || ''} <${msg.from.emailAddress.address || ''}>`.trim()
              : '',
            recipients: [...(msg.toRecipients || []), ...(msg.ccRecipients || [])]
              .map((r) => r.emailAddress?.address)
              .filter(Boolean)
              .join('; '),
            receivedDateTime: msg.receivedDateTime,
            lastModifiedDateTime: msg.lastModifiedDateTime || null,
            hasAttachments: !!msg.hasAttachments,
            conversationId: msg.conversationId || null,
            internetMessageId: msg.internetMessageId || null,
          });
        }
        url = data['@odata.nextLink'] || null;
        pageCount += 1;
      }
      if (pageCount >= MAX_FOLDER_MESSAGE_PAGES && url) {
        console.warn(`[graph-client] fetchAllFolderMessagesSince: hit MAX_FOLDER_MESSAGE_PAGES (${MAX_FOLDER_MESSAGE_PAGES}) for folder "${folder.fullPath}" with more pages still available.`);
      }
    } catch (err) {
      folderErrors.push({ folderId: folder.id, folderPath: folder.fullPath, error: err.message });
      console.error(`[graph-client] fetchAllFolderMessagesSince: folder "${folder.fullPath}" failed, skipping it:`, err.message);
    }
    messages.push(...folderMessages);
    if (onFolderMessages && folderMessages.length > 0) onFolderMessages(folderMessages, folder);
  }

  return { messages, folderErrors, foldersChecked: resolvedFolders.length };
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

// Resolved once and cached for the process lifetime — the Inbox's real
// folder id never changes, so there's no reason to re-resolve the
// "inbox" well-known name on every poll. Used by fetchMessageFlags below
// to detect "moved out of Inbox," which is this mailbox's actual
// resolve-an-enquiry habit (staff file it into a folder rather than
// flagging it or tagging a category — see fetchMessageFlags for the
// flag/category channels, which are much less reliably used).
let cachedInboxFolderId = null;

async function getInboxFolderId() {
  if (cachedInboxFolderId) return cachedInboxFolderId;
  const token = await getAccessToken();
  const mailbox = encodeURIComponent(process.env.MAILBOX);
  const res = await fetch(`${GRAPH_BASE}/users/${mailbox}/mailFolders/inbox?$select=id`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph API error resolving Inbox folder id ${res.status}: ${body}`);
  }
  const data = await res.json();
  cachedInboxFolderId = data.id;
  return cachedInboxFolderId;
}

/**
 * Fetch the current Outlook follow-up flag, category tags, folder
 * location, AND last-modified time for a set of messages (by Graph message
 * id), via the $batch endpoint. The follow-up flag was the original plan
 * for detecting "done", but checking real Sent Items showed it's barely
 * used in practice — genuinely-handled threads routinely have no flag, or
 * one left at 'flagged' rather than 'complete'. Categories are a separate,
 * currently-unused Outlook feature in this mailbox, so they're a cleaner
 * channel for an explicit "Resolved"/"No Action Needed" tag — but staff's
 * actual habit (confirmed directly) is simpler still: file the message
 * into a folder once it's handled. `movedOutOfInbox` (parentFolderId no
 * longer matching the Inbox) captures that directly rather than depending
 * on a flag/category habit the team doesn't really have.
 *
 * Returns a Map of messageId -> { flagStatus, categories, movedOutOfInbox,
 * lastModifiedDateTime } on success, or { missing: true } for a confirmed 404 (message deleted,
 * or moved somewhere its ID no longer resolves at all — observed cause in
 * this mailbox: storage-quota cleanup deleting mail after it's been acted
 * on, not before). That's a different thing from movedOutOfInbox — a
 * normal folder move (e.g. into "11. ONLINE ORDERS") keeps the same id and
 * resolves fine via this mailbox-wide /messages/{id} lookup regardless of
 * which folder it's sitting in; only an actually-gone message 404s.
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
  const inboxFolderId = await getInboxFolderId();
  const results = new Map();

  for (const batch of chunk(messageIds, BATCH_CHUNK_SIZE)) {
    try {
      const body = {
        requests: batch.map((id, i) => ({
          id: String(i),
          method: 'GET',
          url: `/users/${mailbox}/messages/${encodeURIComponent(id)}?$select=flag,categories,parentFolderId,lastModifiedDateTime`,
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
            movedOutOfInbox: r.body?.parentFolderId !== inboxFolderId,
            // Exchange bumps this on a folder move the same as any other
            // property change, so it doubles as "when did this actually get
            // archived" — a real historical timestamp, not "whenever our
            // poller happened to check." Used for resolved_at in
            // db/repository.js instead of relying on our own updated_at,
            // which bumps on anything (a draft regenerated, a manual
            // category fix) and would silently corrupt the resolution-time
            // stat otherwise.
            lastModifiedDateTime: r.body?.lastModifiedDateTime || null,
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
 * graphMessageId -> { hasReply, recipients, firstReplyAt } where
 * `recipients` is every to/cc address across matching Sent Items messages
 * (used by the caller to tell a customer-facing reply from a purely
 * internal forward), and `firstReplyAt` is the earliest sentDateTime found
 * (used to set first_replied_at, once, on first detection — see
 * syncReplyStatuses in graph/poller.js). A conversationId that no longer
 * resolves (e.g. very old/purged mail) is skipped silently rather than
 * failing the whole batch — and, same as fetchMessageFlags, a failed
 * $batch call for one chunk doesn't lose the sync data already fetched for
 * every other chunk.
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
          // $top bumped from 3 to 25 (matching fetchConversationMessages'
          // own cap) — still small enough for a normal customer-service
          // thread, but wide enough to reliably include the *earliest*
          // sent message too, not just the most recent few. Needed so
          // firstReplyAt below (used to set first_replied_at, once, the
          // first time a reply is detected) reflects the actual first
          // reply rather than whichever happened to be newest at $top=3.
          url: `/users/${mailbox}/mailFolders/sentitems/messages?$filter=conversationId eq '${encodeURIComponent(escapeODataString(item.conversationId))}'&$select=toRecipients,ccRecipients,sentDateTime&$orderby=sentDateTime desc&$top=25`,
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
        const sentTimes = sentMessages.map((m) => m.sentDateTime).filter(Boolean);
        const firstReplyAt = sentTimes.length > 0 ? sentTimes.reduce((min, t) => (t < min ? t : min)) : null;
        results.set(item.graphMessageId, { hasReply: sentMessages.length > 0, recipients, firstReplyAt });
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
  fetchAllMailboxMessagesSince,
  fetchFolderTree,
  fetchAllFolderMessagesSince,
  fetchMessageFlags,
  fetchReplyStatus,
  fetchConversationMessages,
  fetchFullBody,
  toRawEmail,
};
