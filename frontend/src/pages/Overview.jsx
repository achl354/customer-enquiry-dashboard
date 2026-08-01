import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getOverviewStats } from '../api';
import { BarList } from '../components/BarList';
import { TrendChart } from '../components/TrendChart';
import { categoryLabel, statusLabel } from '../taxonomy';

const STATUS_COLORS = {
  NEW: 'var(--series-1)',
  IN_PROGRESS: 'var(--status-warning)',
  WAITING_ON_CUSTOMER: 'var(--text-muted)',
  RESOLVED: 'var(--status-good)',
  IGNORED: 'var(--text-muted)',
};

const AGING_COLORS = {
  '0-24h': 'var(--status-good)',
  '1-3d': 'var(--series-1)',
  '3-7d': 'var(--status-warning)',
  '7d+': 'var(--status-critical)',
};

// Below this many resolved enquiries, an average is more noise than signal
// — showing "14.3h" from 2 data points reads as precise when it isn't.
const MIN_RESOLVED_SAMPLE = 5;

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

  const facilityData = stats.byFacility.map((f) => ({ key: f.facility, value: f.count, label: f.facility }));

  const agingData = stats.agingBuckets.map((b) => ({ key: b.bucket, value: b.count, label: b.bucket }));

  const workloadData = [
    ...stats.byAssignee.map((a) => ({ key: a.assignedTo, value: a.count, label: a.assignedTo })),
    ...(stats.unassignedOpen > 0 ? [{ key: '__unassigned', value: stats.unassignedOpen, label: 'Unassigned' }] : []),
  ].sort((a, b) => b.value - a.value);

  const weeklyDelta = stats.last7Days - stats.prev7Days;
  const trendDirection = weeklyDelta > 0 ? 'up' : weeklyDelta < 0 ? 'down' : 'flat';
  const trendText =
    weeklyDelta === 0
      ? 'same as last week'
      : `${weeklyDelta > 0 ? '+' : ''}${weeklyDelta} vs last week`;

  const hasEnoughResolved = stats.resolvedCount >= MIN_RESOLVED_SAMPLE;

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
            {hasEnoughResolved ? `${stats.avgResolutionHours.toFixed(1)}h` : '—'}
          </div>
          <div className="draft-hint">
            {stats.resolvedCount === 0
              ? 'No resolved enquiries yet'
              : hasEnoughResolved
                ? `based on ${stats.resolvedCount} resolved`
                : `only ${stats.resolvedCount} resolved so far — too few for a reliable average`}
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

      <div className="panel">
        <h3>Open enquiries by age</h3>
        <BarList data={agingData} colorFor={(key) => AGING_COLORS[key]} />
      </div>

      <div className="panel">
        <h3>Volume, last 30 days</h3>
        <TrendChart data={stats.dailyVolume} />
      </div>

      <div className="chart-grid">
        <div className="panel">
          <h3>Enquiries by category</h3>
          <BarList data={categoryData} />
        </div>

        <div className="panel">
          <h3>Enquiries by status</h3>
          <BarList data={statusData} colorFor={(key) => STATUS_COLORS[key]} />
        </div>

        <div className="panel">
          <h3>Top facilities / organisations</h3>
          {facilityData.length > 0 ? (
            <BarList data={facilityData} />
          ) : (
            <p className="draft-hint" style={{ margin: 0 }}>No facility data yet.</p>
          )}
        </div>

        <div className="panel">
          <h3>Open workload by assignee</h3>
          {workloadData.length > 0 ? (
            <BarList data={workloadData} colorFor={(key) => (key === '__unassigned' ? 'var(--text-muted)' : 'var(--series-1)')} />
          ) : (
            <p className="draft-hint" style={{ margin: 0 }}>No open enquiries.</p>
          )}
        </div>
      </div>
    </div>
  );
}
