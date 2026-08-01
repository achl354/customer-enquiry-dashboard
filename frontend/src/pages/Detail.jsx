import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getEnquiry, updateEnquiry, generateDraft, getThreadHistory } from '../api';
import { PriorityBadge, StatusBadge, CategoryPill } from '../components/Badges';
import { STATUS_OPTIONS, statusLabel } from '../taxonomy';

export default function Detail() {
  const { id } = useParams();
  const [enquiry, setEnquiry] = useState(null);
  const [error, setError] = useState(null);
  const [assigneeDraft, setAssigneeDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [draftError, setDraftError] = useState(null);
  const [draftEmpty, setDraftEmpty] = useState(false);
  const [threadMessages, setThreadMessages] = useState(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState(null);

  useEffect(() => {
    // Reset per-enquiry UI state on navigation between enquiries (this
    // component instance is reused across ids, not remounted) — otherwise
    // e.g. a "no draft needed" message from the previous enquiry would
    // briefly carry over onto the next one before its own data loads.
    setError(null);
    setDraftError(null);
    setDraftEmpty(false);
    setThreadMessages(null);
    setThreadError(null);
    setCopied(false);

    getEnquiry(id)
      .then((e) => {
        setEnquiry(e);
        setAssigneeDraft(e.assignedTo || '');
        setDraftText(e.draftReply || '');
      })
      .catch((e) => setError(e.message));
  }, [id]);

  async function handleCopyDraft() {
    await navigator.clipboard.writeText(draftText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleGenerateDraft() {
    setGenerating(true);
    setDraftError(null);
    setDraftEmpty(false);
    try {
      const updated = await generateDraft(id);
      setEnquiry(updated);
      setDraftText(updated.draftReply || '');
      // Claude decided this category genuinely doesn't need one (e.g.
      // INTERNAL/SPAM) — distinct from "never asked yet", so the button
      // doesn't just silently reappear with no explanation.
      if (!updated.draftReply) setDraftEmpty(true);
    } catch (e) {
      setDraftError(e.message);
    } finally {
      setGenerating(false);
    }
  }

  async function handleShowThread() {
    setThreadLoading(true);
    setThreadError(null);
    try {
      const { messages } = await getThreadHistory(id);
      setThreadMessages(messages);
    } catch (e) {
      setThreadError(e.message);
    } finally {
      setThreadLoading(false);
    }
  }

  async function handleStatusChange(e) {
    const status = e.target.value;
    setEnquiry((prev) => ({ ...prev, status }));
    setSaving(true);
    try {
      const updated = await updateEnquiry(id, { status });
      setEnquiry(updated);
    } finally {
      setSaving(false);
    }
  }

  async function handleAssigneeBlur() {
    if (assigneeDraft === (enquiry.assignedTo || '')) return;
    setSaving(true);
    try {
      const updated = await updateEnquiry(id, { assignedTo: assigneeDraft || null });
      setEnquiry(updated);
    } finally {
      setSaving(false);
    }
  }

  if (error) return <div className="error-state">Failed to load enquiry: {error}</div>;
  if (!enquiry) return <div className="loading">Loading…</div>;

  const f = enquiry.extractedFields;

  return (
    <div>
      <Link to="/queue" className="back-link">&larr; Back to queue</Link>

      <div className="detail-header">
        <div>
          <h2>{enquiry.subject}</h2>
          <div className="detail-meta">
            From {enquiry.sender.name ? `${enquiry.sender.name} <${enquiry.sender.email}>` : enquiry.sender.email}
            {' · '}
            {new Date(enquiry.receivedAt).toLocaleString()}
            {enquiry.webLink && (
              <>
                {' · '}
                <a href={enquiry.webLink} target="_blank" rel="noreferrer">Open in Outlook</a>
              </>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <CategoryPill category={enquiry.category} />
          <PriorityBadge priority={enquiry.priority} />
          <StatusBadge status={enquiry.status} />
        </div>
      </div>

      <div className="detail-grid">
        <div>
          <div className="panel">
            <h3>Email content</h3>
            <div className="email-body">{enquiry.bodyPreview || '(no preview available)'}</div>
          </div>

          {enquiry.conversationId && (
            <div className="panel">
              <h3>Email thread</h3>
              {threadMessages === null ? (
                <div className="draft-actions">
                  <button type="button" onClick={handleShowThread} disabled={threadLoading}>
                    {threadLoading ? 'Loading…' : 'Show previous replies'}
                  </button>
                  {threadError ? (
                    <span className="draft-hint" style={{ color: 'var(--status-critical)' }}>{threadError}</span>
                  ) : (
                    <span className="draft-hint">Fetched from Outlook on demand — not loaded automatically.</span>
                  )}
                </div>
              ) : threadMessages.length === 0 ? (
                <p className="draft-hint" style={{ margin: 0 }}>No other messages found in this thread.</p>
              ) : (
                <div className="thread-list">
                  {threadMessages.map((m, i) => (
                    <div className="thread-message" key={i}>
                      <div className="thread-message-meta">
                        <strong>{m.senderName || m.senderEmail}</strong> to {m.recipients.join(', ') || '—'}
                        {' · '}
                        {new Date(m.sentAt).toLocaleString()}
                      </div>
                      <div className="thread-message-body">{m.bodyPreview || '(empty)'}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="panel">
            <h3>Suggested action</h3>
            <div className="suggested-action">{enquiry.suggestedAction}</div>
            {enquiry.classifiedBy && (
              <div className={`classification-source ${enquiry.confidence != null && enquiry.confidence < 0.5 ? 'low-confidence' : ''}`}>
                {enquiry.classifiedBy === 'ai' && enquiry.confidence != null
                  ? `Classified by Claude — ${Math.round(enquiry.confidence * 100)}% confidence${enquiry.confidence < 0.5 ? ' (low — worth a second look)' : ''}`
                  : enquiry.classifiedBy === 'rules-fallback'
                    ? 'Classified by rules (AI classification failed for this one)'
                    : 'Classified by rules'}
              </div>
            )}
          </div>

          <div className="panel">
            <h3>Draft reply / handoff note</h3>
            {enquiry.draftReply ? (
              <>
                <textarea
                  className="draft-textarea"
                  value={draftText}
                  onChange={(e) => setDraftText(e.target.value)}
                  rows={10}
                />
                <div className="draft-actions">
                  <button type="button" onClick={handleCopyDraft}>{copied ? 'Copied!' : 'Copy to clipboard'}</button>
                  <span className="draft-hint">Review before sending — edit freely, this is a starting point.</span>
                </div>
              </>
            ) : (
              <div className="draft-actions">
                <button type="button" onClick={handleGenerateDraft} disabled={generating}>
                  {generating ? 'Generating…' : draftEmpty ? 'Try again' : 'Generate draft'}
                </button>
                {draftError ? (
                  <span className="draft-hint" style={{ color: 'var(--status-critical)' }}>{draftError}</span>
                ) : draftEmpty ? (
                  <span className="draft-hint">Claude decided no draft is needed for this category — click again if you disagree.</span>
                ) : (
                  <span className="draft-hint">Only generated when you ask for it — no draft has been created yet.</span>
                )}
              </div>
            )}
          </div>
        </div>

        <div>
          <div className="panel">
            <h3>Extracted details</h3>
            <div className="field-row">
              <span className="field-label">PO number</span>
              <span className="field-value">{f.poNumber || '—'}</span>
            </div>
            <div className="field-row">
              <span className="field-label">Quote number</span>
              <span className="field-value">{f.quoteNumber || '—'}</span>
            </div>
            <div className="field-row">
              <span className="field-label">Facility / org</span>
              <span className="field-value">{f.facility || '—'}</span>
            </div>
            <div className="field-row">
              <span className="field-label">Sender domain</span>
              <span className="field-value">{f.senderDomain || '—'}</span>
            </div>
            <div className="field-row">
              <span className="field-label">Has attachments</span>
              <span className="field-value">{enquiry.hasAttachments ? 'Yes' : 'No'}</span>
            </div>
          </div>

          <div className="panel">
            <h3>Manage</h3>
            <div className="control-row">
              <label htmlFor="status-select">Status</label>
              <select id="status-select" value={enquiry.status} onChange={handleStatusChange} disabled={saving}>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>{statusLabel(s)}</option>
                ))}
              </select>
            </div>
            <div className="control-row">
              <label htmlFor="assignee-input">Assigned to</label>
              <input
                id="assignee-input"
                type="text"
                placeholder="Unassigned"
                value={assigneeDraft}
                onChange={(e) => setAssigneeDraft(e.target.value)}
                onBlur={handleAssigneeBlur}
                disabled={saving}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
