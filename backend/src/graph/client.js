const { ConfidentialClientApplication } = require('@azure/msal-node');

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

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
  const select = '$select=id,internetMessageId,subject,bodyPreview,receivedDateTime,from,toRecipients,hasAttachments,importance,webLink';
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
  };
}

module.exports = { isConfigured, fetchMessagesSince, toRawEmail };
