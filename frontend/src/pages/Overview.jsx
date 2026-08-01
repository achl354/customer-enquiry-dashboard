import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getOverviewStats } from '../api';
import { BarList } from '../components/BarList';
import { categoryLabel, statusLabel } from '../taxonomy';

const STATUS_COLORS = {
  NEW: 'var(--series-1)',
  IN_PROGRESS: 'var(--status-warning)',
  WAITING_ON_CUSTOMER: 'var(--text-muted)',
  RESOLVED: 'var(--status-good)',
  IGNORED: 'var(--text-muted)',
};

export default function Overview() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getOverviewStats().then(setStats).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="error-state">Failed to load stats: {error}</div>;
  if (!stats) return <div className="loading">Loading…</div>;

  const categoryData = Object.entries(stats.byCategory)
    .map(([key, value]) => ({ key, value, label: categoryLabel(key) }))
    .sort((a, b) => b.value - a.value);

  const statusOrder = ['NEW', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'IGNORED'];
  const statusData = statusOrder
    .filter((s) => stats.byStatus[s])
    .map((key) => ({ key, value: stats.byStatus[key], label: statusLabel(key) }));

  const weeklyDelta = stats.last7Days - stats.prev7Days;
  const trendDirection = weeklyDelta > 0 ? 'up' : weeklyDelta < 0 ? 'down' : 'flat';
  const trendText =
    weeklyDelta === 0
      ? 'same as last week'
      : `${weeklyDelta > 0 ? '+' : ''}${weeklyDelta} vs last week`;

  return (
    <div>
      <h2>Team overview</h2>

      <div className="stat-grid">
        <div className="stat-tile">
          <div className="label">Total enquiries</div>
          <div className="value-row">
            <div className="value">{stats.total}</div>
            <div className={`trend ${trendDirection}`}>{trendText}</div>
          </div>
        </div>
        <div className="stat-tile">
          <div className="label">Open</div>
          <div className="value">{stats.openCount}</div>
        </div>
        <div className="stat-tile">
          <div className="label">Urgent &amp; open</div>
          <div className={`value ${stats.urgentOpen > 0 ? 'critical' : ''}`}>{stats.urgentOpen}</div>
        </div>
        <div className="stat-tile">
          <div className="label">Avg. resolution time</div>
          <div className="value">
            {stats.avgResolutionHours != null ? `${stats.avgResolutionHours.toFixed(1)}h` : '—'}
          </div>
        </div>
        <div className="stat-tile">
          <div className="label">Classified by AI</div>
          <div className="value">{stats.byClassifiedBy?.ai || 0}</div>
        </div>
        <div className="stat-tile">
          <div className="label">Low-confidence (needs review)</div>
          <div className={`value ${stats.lowConfidenceCount > 0 ? 'critical' : ''}`}>{stats.lowConfidenceCount}</div>
        </div>
      </div>

      {stats.oldestOpen && (
        <div className="panel">
          <h3>Oldest unactioned enquiry</h3>
          <p style={{ margin: 0, fontSize: 13 }}>
            <Link to={`/enquiries/${stats.oldestOpen.id}`}>{stats.oldestOpen.subject}</Link>
            {' — '}
            <span style={{ color: 'var(--text-muted)' }}>
              {stats.oldestOpen.sender.email} · received {new Date(stats.oldestOpen.receivedAt).toLocaleString()}
            </span>
          </p>
        </div>
      )}

      <div className="chart-grid">
        <div className="panel">
          <h3>Enquiries by category</h3>
          <BarList data={categoryData} />
        </div>

        <div className="panel">
          <h3>Enquiries by status</h3>
          <BarList data={statusData} colorFor={(key) => STATUS_COLORS[key]} />
        </div>
      </div>
    </div>
  );
}
