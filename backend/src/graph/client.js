const { ConfidentialClientApplication } = require('@azure/msal-node');

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_BATCH_URL = `${GRAPH_BASE}/$batch`;
const BATCH_CHUNK_SIZE = 20; // Graph's max sub-requests per $batch call

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

/**
 * Fetch messages from the configured mailbox's Inbox received after `sinceIso`,
 * newest first. Requires application permission Mail.Read (admin-consented),
 * ideally scoped to this mailbox via an Application Access Policy.
 */
async function fetchMessagesSince(sinceIso) {
  const token = await getAccessToken();
  const mailbox = encodeURIComponent(process.env.MAILBOX);
  const filter = sinceIso ? `&$filter=receivedDateTime ge ${sinceIso}` : '';
  const select = '$select=id,internetMessageId,subject,bodyPreview,receivedDateTime,from,toRecipients,hasAttachments,importance,webLink,flag';
  const url = `${GRAPH_BASE}/users/${mailbox}/mailFolders/inbox/messages?${select}${filter}&$orderby=receivedDateTime desc&$top=50`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph API error ${res.status}: ${body}`);
  }
  const data = await res.json();
  return (data.value || []).map(toRawEmail);
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
  };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Fetch the current Outlook follow-up flag status for a set of messages (by
 * Graph message id), via the $batch endpoint — staff already use Outlook's
 * flag feature to mark threads complete, so this lets the dashboard reflect
 * that instead of asking for a second, separate "mark as done" action.
 * Returns a Map of messageId -> flagStatus ('notFlagged' | 'flagged' |
 * 'complete'), silently skipping any message that no longer resolves (e.g.
 * moved/deleted) rather than failing the whole batch.
 */
async function fetchMessageFlags(messageIds) {
  if (messageIds.length === 0) return new Map();
  const token = await getAccessToken();
  const mailbox = encodeURIComponent(process.env.MAILBOX);
  const results = new Map();

  for (const batch of chunk(messageIds, BATCH_CHUNK_SIZE)) {
    const body = {
      requests: batch.map((id, i) => ({
        id: String(i),
        method: 'GET',
        url: `/users/${mailbox}/messages/${encodeURIComponent(id)}?$select=flag`,
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
      if (r.status === 200 && r.body?.flag?.flagStatus) {
        results.set(originalId, r.body.flag.flagStatus);
      }
      // Non-200 (e.g. 404 for a moved/deleted message) is skipped silently.
    }
  }

  return results;
}

module.exports = { isConfigured, fetchMessagesSince, fetchMessageFlags, toRawEmail };
