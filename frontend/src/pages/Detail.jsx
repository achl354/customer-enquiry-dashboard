import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getEnquiry, updateEnquiry } from '../api';
import { PriorityBadge, StatusBadge, CategoryPill } from '../components/Badges';
import { STATUS_OPTIONS, statusLabel } from '../taxonomy';

export default function Detail() {
  const { id } = useParams();
  const [enquiry, setEnquiry] = useState(null);
  const [error, setError] = useState(null);
  const [assigneeDraft, setAssigneeDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getEnquiry(id)
      .then((e) => {
        setEnquiry(e);
        setAssigneeDraft(e.assignedTo || '');
      })
      .catch((e) => setError(e.message));
  }, [id]);

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

          <div className="panel">
            <h3>AI-suggested action</h3>
            <div className="suggested-action">{enquiry.suggestedAction}</div>
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
