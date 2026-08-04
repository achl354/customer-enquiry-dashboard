import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { getEnquiry, generateDraft, getThreadHistory, getFullBody, updateCategory, deleteEnquiry } from '../api';
import { PriorityBadge, StatusBadge, CategoryPill } from '../components/Badges';
import { CATEGORY_OPTIONS, categoryLabel } from '../taxonomy';

export default function Detail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [enquiry, setEnquiry] = useState(null);
  const [error, setError] = useState(null);
  const [draftText, setDraftText] = useState('');
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [draftError, setDraftError] = useState(null);
  const [draftEmpty, setDraftEmpty] = useState(false);
  const [threadMessages, setThreadMessages] = useState(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState(null);
  const [fullBody, setFullBody] = useState(null);
  const [fullBodyLoading, setFullBodyLoading] = useState(false);
  const [fullBodyError, setFullBodyError] = useState(null);
  const [categorySaving, setCategorySaving] = useState(false);
  const [categoryError, setCategoryError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

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
    setFullBody(null);
    setFullBodyError(null);
    setCopied(false);
    setCategoryError(null);
    setDeleteError(null);

    // Same instance-reuse issue means a slow response for the *previous*
    // id could otherwise land after a faster response for the current one
    // and overwrite it — cancel it instead of racing. One shared controller
    // covers the enquiry fetch and the two follow-up fetches below, so
    // navigating away cancels all three at once.
    const controller = new AbortController();
    getEnquiry(id, { signal: controller.signal })
      .then((e) => {
        setEnquiry(e);
        setDraftText(e.draftReply || '');

        // Both are Graph calls, not Claude — no AI cost either way, so
        // there's no cost reason to gate these behind a click. Only fires
        // for live-ingested mail (conversationId is unset for seed/demo
        // data, which already has its full text in bodyPreview anyway).
        if (e.conversationId) {
          setFullBodyLoading(true);
          getFullBody(id, { signal: controller.signal })
            .then(({ body }) => setFullBody(body))
            .catch((err) => {
              if (err.name === 'AbortError') return;
              setFullBodyError(err.message);
            })
            .finally(() => setFullBodyLoading(false));

          setThreadLoading(true);
          getThreadHistory(id, { signal: controller.signal })
            .then(({ messages }) => setThreadMessages(messages))
            .catch((err) => {
              if (err.name === 'AbortError') return;
              setThreadError(err.message);
            })
            .finally(() => setThreadLoading(false));
        }
      })
      .catch((e) => {
        if (e.name === 'AbortError') return;
        setError(e.message);
      });
    return () => controller.abort();
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

  async function handleCategoryChange(e) {
    const category = e.target.value;
    setCategorySaving(true);
    setCategoryError(null);
    try {
      const updated = await updateCategory(id, category);
      setEnquiry(updated);
    } catch (err) {
      setCategoryError(err.message);
    } finally {
      setCategorySaving(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm('Delete this enquiry? It will be hidden from the queue — you can still find it later by filtering the queue for "Dismissed".')) {
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteEnquiry(id);
      navigate('/queue');
    } catch (err) {
      setDeleteError(err.message);
      setDeleting(false);
    }
  }

  if (error) return <div className="error-state">Failed to load enquiry: {error}</div>;
  if (!enquiry) return <div className="loading">Loading…</div>;

  const f = enquiry.extractedFields;
  // mailto: (unlike webLink) respects the OS's default mail app setting, so
  // this is the one link that can actually land in desktop Outlook instead
  // of the browser — at the cost of opening as a new email rather than a
  // true reply on the original thread (mailto has no way to express that).
  const replySubject = /^re:/i.test(enquiry.subject || '') ? enquiry.subject : `RE: ${enquiry.subject || ''}`;
  const replyMailto = enquiry.sender.email
    ? `mailto:${enquiry.sender.email}?subject=${encodeURIComponent(replySubject)}&body=${encodeURIComponent(draftText)}`
    : null;

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
        <div className="detail-header-badges">
          <CategoryPill category={enquiry.category} />
          <PriorityBadge priority={enquiry.priority} />
          <StatusBadge status={enquiry.status} />
        </div>
      </div>

      <div className="detail-grid">
        <div>
          <div className="panel">
            <h3>Email content</h3>
            <div className="email-body scrollable">{fullBody ?? enquiry.bodyPreview ?? '(no preview available)'}</div>
            {fullBodyLoading && <p className="draft-hint" style={{ margin: '8px 0 0' }}>Loading full email…</p>}
            {fullBodyError && (
              <p className="draft-hint" style={{ margin: '8px 0 0', color: 'var(--status-critical)' }}>{fullBodyError}</p>
            )}
          </div>

          {enquiry.conversationId && (
            <div className="panel">
              <h3>Email thread</h3>
              {threadLoading && <p className="draft-hint" style={{ margin: 0 }}>Loading previous replies…</p>}
              {threadError && (
                <p className="draft-hint" style={{ margin: 0, color: 'var(--status-critical)' }}>{threadError}</p>
              )}
              {threadMessages !== null && threadMessages.length === 0 && (
                <p className="draft-hint" style={{ margin: 0 }}>No other messages found in this thread.</p>
              )}
              {threadMessages !== null && threadMessages.length > 0 && (
                <div className="thread-list scrollable">
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
                {enquiry.classifiedBy === 'manual'
                  ? 'Category set manually by staff'
                  : enquiry.classifiedBy === 'ai' && enquiry.confidence != null
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
            {replyMailto && (
              <div className="draft-actions" style={{ marginTop: 12 }}>
                <a href={replyMailto} className="outlook-link">Reply via email app</a>
                <span className="draft-hint">
                  {enquiry.draftReply
                    ? 'Opens your email app with the draft above already filled in.'
                    : 'Opens your email app addressed to the sender — generate a draft above to pre-fill the body too.'}
                </span>
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
              <label htmlFor="category-select">Category</label>
              <select
                id="category-select"
                value={enquiry.category}
                onChange={handleCategoryChange}
                disabled={categorySaving}
              >
                {CATEGORY_OPTIONS.map((c) => (
                  <option key={c} value={c}>{categoryLabel(c)}</option>
                ))}
              </select>
            </div>
            {categoryError && (
              <p className="draft-hint" style={{ margin: '4px 0 0', color: 'var(--status-critical)' }}>{categoryError}</p>
            )}

            <div className="control-row" style={{ marginTop: 10 }}>
              <label>Status</label>
              <StatusBadge status={enquiry.status} />
            </div>
            <p className="draft-hint" style={{ margin: '4px 0 0' }}>
              Synced automatically from Outlook — moving this out of the Inbox into any
              folder marks it Resolved, and replies/flags/categories are picked up too.
              Take the actual action in Outlook and this will catch up on the next poll.
              "Delete" below is the one status change this dashboard sets directly.
            </p>

            <div className="draft-actions" style={{ marginTop: 14 }}>
              <button type="button" className="danger-btn" onClick={handleDelete} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
              <span className="draft-hint">Hides this from the queue — doesn't touch the real mailbox.</span>
            </div>
            {deleteError && (
              <p className="draft-hint" style={{ margin: '4px 0 0', color: 'var(--status-critical)' }}>{deleteError}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
