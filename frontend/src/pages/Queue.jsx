import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listEnquiries } from '../api';
import { PriorityBadge, StatusBadge, CategoryPill } from '../components/Badges';
import { CATEGORY_OPTIONS, PRIORITY_OPTIONS, STATUS_OPTIONS, categoryLabel, priorityLabel, statusLabel } from '../taxonomy';

export default function Queue() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [filters, setFilters] = useState({ category: '', priority: '', status: '', search: '' });

  useEffect(() => {
    setLoading(true);
    const timeout = setTimeout(() => {
      listEnquiries({ ...filters, sort: 'receivedAt', order: 'desc', limit: 100 })
        .then((res) => {
          setItems(res.items);
          setTotal(res.total);
          setError(null);
        })
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(timeout);
  }, [filters]);

  const update = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }));

  return (
    <div>
      <h2>Triage queue</h2>

      <div className="filter-bar">
        <select value={filters.category} onChange={update('category')}>
          <option value="">All categories</option>
          {CATEGORY_OPTIONS.map((c) => (
            <option key={c} value={c}>{categoryLabel(c)}</option>
          ))}
        </select>
        <select value={filters.priority} onChange={update('priority')}>
          <option value="">All priorities</option>
          {PRIORITY_OPTIONS.map((p) => (
            <option key={p} value={p}>{priorityLabel(p)}</option>
          ))}
        </select>
        <select value={filters.status} onChange={update('status')}>
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{statusLabel(s)}</option>
          ))}
        </select>
        <input
          type="search"
          placeholder="Search subject, sender, PO#…"
          value={filters.search}
          onChange={update('search')}
        />
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{total} result{total === 1 ? '' : 's'}</span>
      </div>

      {error && <div className="error-state">{error}</div>}
      {!error && loading && items.length === 0 && <div className="loading">Loading…</div>}

      {!error && (loading === false || items.length > 0) && (
        <table className="enquiry-table">
          <thead>
            <tr>
              <th>Received</th>
              <th>Sender</th>
              <th>Subject</th>
              <th>Category</th>
              <th>Priority</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id} className="row-link" onClick={() => navigate(`/enquiries/${e.id}`)}>
                <td>{new Date(e.receivedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                <td>{e.extractedFields.facility || e.sender.name || e.sender.email}</td>
                <td className="subject-cell">{e.subject}</td>
                <td><CategoryPill category={e.category} /></td>
                <td><PriorityBadge priority={e.priority} /></td>
                <td><StatusBadge status={e.status} /></td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="empty-state">No enquiries match these filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
