import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { listEnquiries, getExportUrl } from '../api';
import { PriorityBadge, StatusBadge, CategoryPill } from '../components/Badges';
import { QueueSkeleton } from '../components/Skeletons';
import { CATEGORY_OPTIONS, PRIORITY_OPTIONS, STATUS_OPTIONS, categoryLabel, priorityLabel, statusLabel } from '../taxonomy';

const PAGE_SIZE = 25;

const SORTABLE_COLUMNS = [
  { key: 'receivedAt', label: 'Received' },
  { key: 'category', label: 'Category' },
  { key: 'priority', label: 'Priority' },
  { key: 'status', label: 'Status' },
];

export default function Queue() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [filters, setFilters] = useState({
    category: '',
    priority: '',
    status: '',
    search: '',
    lowConfidence: undefined,
  });
  const [sort, setSort] = useState('receivedAt');
  const [order, setOrder] = useState('desc');
  const [page, setPage] = useState(0);

  // Sidebar "quick filter" links (e.g. /queue?priority=URGENT) land here —
  // re-apply on every change so clicking one while already on this page works too.
  useEffect(() => {
    setFilters({
      category: searchParams.get('category') || '',
      priority: searchParams.get('priority') || '',
      status: searchParams.get('status') || '',
      search: searchParams.get('search') || '',
      lowConfidence: searchParams.get('lowConfidence') === 'true' ? true : undefined,
    });
    setPage(0);
  }, [searchParams]);

  useEffect(() => {
    setLoading(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      listEnquiries({ ...filters, sort, order, limit: PAGE_SIZE, offset: page * PAGE_SIZE }, { signal: controller.signal })
        .then((res) => {
          setItems(res.items);
          setTotal(res.total);
          setError(null);
          setLoading(false);
        })
        .catch((e) => {
          // Aborted on purpose (a newer filter/sort/page change fired before
          // this one resolved) — not a real error. Also don't touch loading
          // here: the newer request already set it true, and this stale one
          // finishing shouldn't flip it back off underneath it.
          if (e.name === 'AbortError') return;
          setError(e.message);
          setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [filters, sort, order, page]);

  const update = (key) => (e) => {
    setPage(0);
    setFilters((f) => ({ ...f, [key]: e.target.value }));
  };

  // No dropdown covers this one (unlike category/priority/status), so it
  // needs its own visible indicator + a way to clear it — otherwise landing
  // here from the Overview tile leaves no sign the list is filtered at all.
  const clearParam = (key) => () => {
    const next = new URLSearchParams(searchParams);
    next.delete(key);
    setSearchParams(next);
    setPage(0);
  };

  const toggleSort = (key) => {
    setPage(0);
    if (sort === key) {
      setOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(key);
      // Default to showing the most urgent/most recent first.
      setOrder(key === 'receivedAt' || key === 'priority' ? 'desc' : 'asc');
    }
  };

  const pageStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const pageEnd = Math.min(total, (page + 1) * PAGE_SIZE);

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
          placeholder="Search subject, sender, PO#, facility…"
          value={filters.search}
          onChange={update('search')}
        />
        {filters.lowConfidence && (
          <span className="filter-chip">
            Low confidence
            <button type="button" onClick={clearParam('lowConfidence')} aria-label="Clear low-confidence filter">×</button>
          </span>
        )}
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{total} result{total === 1 ? '' : 's'}</span>
        <a
          className="export-link"
          href={getExportUrl({ ...filters, sort, order })}
          download
        >
          Export CSV
        </a>
      </div>

      {error && <div className="error-state">{error}</div>}
      {!error && loading && items.length === 0 && <QueueSkeleton />}

      {!error && (loading === false || items.length > 0) && (
        <>
          <div className="table-scroll">
          <table className="enquiry-table">
            <thead>
              <tr>
                {SORTABLE_COLUMNS.slice(0, 1).map((col) => (
                  <th key={col.key} className="sortable" onClick={() => toggleSort(col.key)}>
                    {col.label}{sort === col.key ? (order === 'asc' ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
                <th>Sender</th>
                <th>Subject</th>
                {SORTABLE_COLUMNS.slice(1).map((col) => (
                  <th key={col.key} className="sortable" onClick={() => toggleSort(col.key)}>
                    {col.label}{sort === col.key ? (order === 'asc' ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr
                  key={e.id}
                  className={`row-link${e.priority === 'URGENT' ? ' row-urgent' : ''}`}
                  onClick={() => navigate(`/enquiries/${e.id}`)}
                  onKeyDown={(ev) => {
                    // A <tr> isn't natively focusable/activatable, so without
                    // this a keyboard-only user has no way to open an
                    // enquiry from this table at all — Tab just skips it.
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault();
                      navigate(`/enquiries/${e.id}`);
                    }
                  }}
                  tabIndex={0}
                  role="link"
                >
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
          </div>

          {total > PAGE_SIZE && (
            <div className="pagination">
              <span>{pageStart}–{pageEnd} of {total}</span>
              <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Prev</button>
              <button type="button" disabled={pageEnd >= total} onClick={() => setPage((p) => p + 1)}>Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
