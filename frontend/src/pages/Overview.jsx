import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getOverviewStats, getIngestStatus } from '../api';
import { BarList } from '../components/BarList';
import { TrendChart } from '../components/TrendChart';
import { Sparkline } from '../components/Sparkline';
import { OverviewSkeleton } from '../components/Skeletons';
import { IconLayers, IconInbox, IconAlertTriangle, IconClock, IconEye } from '../components/Icons';
import { categoryLabel, statusLabel } from '../taxonomy';
import { useCountUp } from '../hooks/useCountUp';

// Matches App.jsx's sidebar poll interval — the two independently fetched
// the same stats with no shared cadence, so this page's own numbers could
// silently drift out of sync with the sidebar's Urgent/New counts (visible
// until the user navigated away and back) instead of just refreshing together.
const STATS_REFRESH_MS = 60000;

const STATUS_COLORS = {
  NEW: 'var(--series-1)',
  IN_PROGRESS: 'var(--status-warning)',
  WAITING_ON_CUSTOMER: 'var(--text-muted)',
  RESOLVED: 'var(--status-good)',
  IGNORED: 'var(--text-muted)',
  REMOVED: 'var(--accent-gold)',
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

const STATUS_ORDER = ['NEW', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'IGNORED', 'REMOVED'];

export default function Overview() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [mailbox, setMailbox] = useState(null);

  useEffect(() => {
    const load = () => getOverviewStats().then(setStats).catch((e) => setError(e.message));
    load();
    const interval = setInterval(load, STATS_REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  // One-time — the mailbox address is static config, not something that
  // changes while the page is open, unlike stats.
  useEffect(() => {
    getIngestStatus().then((s) => setMailbox(s.mailbox)).catch(() => {});
  }, []);

  // Hooks must run unconditionally, so these all sit above the
  // loading/error early-returns below, fed with `null` until stats arrive.
  const totalDisplay = useCountUp(stats?.total ?? null);
  const openDisplay = useCountUp(stats?.openCount ?? null);
  const urgentDisplay = useCountUp(stats?.urgentOpen ?? null);
  const avgResolutionDisplay = useCountUp(stats?.avgResolutionHours ?? null, { decimals: 1 });
  const lowConfidenceDisplay = useCountUp(stats?.lowConfidenceCount ?? null);

  // Memoized since these are pure functions of `stats` alone, but Overview
  // re-renders on every useCountUp animation tick (up to 5 concurrent
  // animations x ~42 frames over 700ms right after stats load) — without
  // this, all four array transforms below re-ran on every one of those
  // frames for no reason.
  const categoryData = useMemo(() => {
    if (!stats) return [];
    return Object.entries(stats.byCategory)
      .map(([key, value]) => ({ key, value, label: categoryLabel(key) }))
      .sort((a, b) => b.value - a.value);
  }, [stats]);

  const statusData = useMemo(() => {
    if (!stats) return [];
    return STATUS_ORDER.filter((s) => stats.byStatus[s]).map((key) => ({
      key,
      value: stats.byStatus[key],
      label: statusLabel(key),
    }));
  }, [stats]);

  const facilityData = useMemo(() => {
    if (!stats) return [];
    return stats.byFacility.map((f) => ({ key: f.facility, value: f.count, label: f.facility }));
  }, [stats]);

  const agingData = useMemo(() => {
    if (!stats) return [];
    return stats.agingBuckets.map((b) => ({ key: b.bucket, value: b.count, label: b.bucket }));
  }, [stats]);

  const sparklineValues = useMemo(() => {
    // Real data only — the daily volume series is the one metric on this
    // page with genuine history, so it's the only tile that gets a sparkline.
    if (!stats) return [];
    return stats.dailyVolume.slice(-14).map((d) => d.count);
  }, [stats]);

  if (error) return <div className="error-state">Failed to load stats: {error}</div>;
  if (!stats) return <OverviewSkeleton />;

  const weeklyDelta = stats.last7Days - stats.prev7Days;
  const trendDirection = weeklyDelta > 0 ? 'up' : weeklyDelta < 0 ? 'down' : 'flat';
  const trendText =
    weeklyDelta === 0
      ? 'same as last week'
      : `${weeklyDelta > 0 ? '+' : ''}${weeklyDelta} vs last week`;

  const hasEnoughResolved = stats.resolvedCount >= MIN_RESOLVED_SAMPLE;

  // "Total enquiries" counts from a fixed reporting start date (backend
  // constant, not the mailbox's actual first-ever message) — without a
  // caption showing that date it reads as if it might be a weekly/monthly
  // figure instead.
  const sinceDate = stats.totalSinceDate
    ? new Date(stats.totalSinceDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  return (
    <div>
      <div className="overview-header">
        <h2>Mailbox Overview</h2>
        {mailbox && <span className="overview-mailbox">{mailbox}</span>}
      </div>

      <div className="stat-grid">
        <div className="stat-tile stat-tile-in" style={{ animationDelay: '0ms' }}>
          <div className="stat-tile-header">
            <IconLayers className="stat-icon" />
            <div className="label">Total enquiries</div>
          </div>
          <div className="stat-tile-body">
            <div className="value-row">
              <div className="value">{totalDisplay}</div>
              <div className={`trend ${trendDirection}`}>{trendText}</div>
            </div>
            <Sparkline values={sparklineValues} />
          </div>
          {sinceDate && <div className="draft-hint">Since {sinceDate}</div>}
        </div>
        <div className="stat-tile stat-tile-in" style={{ animationDelay: '60ms' }}>
          <div className="stat-tile-header">
            <IconInbox className="stat-icon" />
            <div className="label">Open</div>
          </div>
          <div className="value">{openDisplay}</div>
        </div>
        <Link
          to="/queue?priority=URGENT"
          className={`stat-tile stat-tile-in stat-tile-link${stats.urgentOpen > 0 ? ' attention' : ''}`}
          style={{ animationDelay: '120ms' }}
        >
          <div className="stat-tile-header">
            <IconAlertTriangle className="stat-icon" />
            <div className="label">Urgent &amp; open</div>
          </div>
          <div className={`value ${stats.urgentOpen > 0 ? 'critical' : ''}`}>{urgentDisplay}</div>
        </Link>
        <Link to="/queue?status=RESOLVED" className="stat-tile stat-tile-in stat-tile-link" style={{ animationDelay: '180ms' }}>
          <div className="stat-tile-header">
            <IconClock className="stat-icon" />
            <div className="label">Avg. resolution time</div>
          </div>
          <div className="value">
            {hasEnoughResolved ? `${avgResolutionDisplay}h` : '—'}
          </div>
          <div className="draft-hint">
            {stats.resolvedCount === 0
              ? 'No resolved enquiries yet'
              : hasEnoughResolved
                ? `based on ${stats.resolvedCount} resolved`
                : `only ${stats.resolvedCount} resolved so far — too few for a reliable average`}
          </div>
        </Link>
        <Link
          to="/queue?lowConfidence=true"
          className={`stat-tile stat-tile-in stat-tile-link${stats.lowConfidenceCount > 0 ? ' attention' : ''}`}
          style={{ animationDelay: '240ms' }}
        >
          <div className="stat-tile-header">
            <IconEye className="stat-icon" />
            <div className="label">Low-confidence (needs review)</div>
          </div>
          <div className={`value ${stats.lowConfidenceCount > 0 ? 'critical' : ''}`}>{lowConfidenceDisplay}</div>
        </Link>
      </div>

      {stats.oldestOpen && (
        <div className="panel panel-narrow">
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
          <h3>Open enquiries by age</h3>
          <BarList data={agingData} colorFor={(key) => AGING_COLORS[key]} />
        </div>

        <div className="panel">
          <h3>Volume, last 30 days</h3>
          <TrendChart data={stats.dailyVolume} />
        </div>
      </div>

      <div className="chart-grid">
        <div className="panel">
          <h3>Enquiries by category</h3>
          <BarList data={categoryData} linkTo={(key) => `/queue?category=${encodeURIComponent(key)}`} />
        </div>

        <div className="panel">
          <h3>Enquiries by status</h3>
          <BarList
            data={statusData}
            colorFor={(key) => STATUS_COLORS[key]}
            linkTo={(key) => `/queue?status=${encodeURIComponent(key)}`}
          />
        </div>

        <div className="panel">
          <h3>Top facilities / organisations</h3>
          {facilityData.length > 0 ? (
            <BarList data={facilityData} />
          ) : (
            <p className="draft-hint" style={{ margin: 0 }}>No facility data yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
