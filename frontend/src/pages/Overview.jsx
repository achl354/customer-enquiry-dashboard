import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getOverviewStats,
  getIngestStatus,
  getResolutionTrend,
  getFirstResponseTrend,
  getResolutionByPriority,
  getBacklogTrend,
  getVolumeTrend,
  reclassifyByFacility,
  getReclassifyByFacilityStatus,
} from '../api';
import { BarList } from '../components/BarList';
import { DualTrendChart } from '../components/DualTrendChart';
import { NetDiffChart } from '../components/NetDiffChart';
import { StackedBar } from '../components/StackedBar';
import { OverviewSkeleton } from '../components/Skeletons';
import { IconLayers, IconInbox, IconAlertTriangle, IconRefresh } from '../components/Icons';
import { PriorityBadge, CategoryPill } from '../components/Badges';
import { categoryLabel, priorityLabel } from '../taxonomy';
import { useCountUp } from '../hooks/useCountUp';
import { usePeriodTrend } from '../hooks/usePeriodTrend';

// Matches App.jsx's sidebar poll interval — the two independently fetched
// the same stats with no shared cadence, so this page's own numbers could
// silently drift out of sync with the sidebar's Urgent/New counts (visible
// until the user navigated away and back) instead of just refreshing together.
const STATS_REFRESH_MS = 60000;

// A green -> amber -> red escalating-risk ramp, reading left to right as
// "how overdue." The 1-3d step is a paler tint of the same good-green
// rather than an unrelated hue, so the story stays green -> red instead
// of jumping through an unrelated color partway through.
const AGING_COLORS = {
  '0-24h': 'var(--status-good)',
  '1-3d': 'color-mix(in srgb, var(--status-good) 55%, var(--surface-1))',
  '3-7d': 'var(--status-warning)',
  '7d+': 'var(--status-critical)',
};

// Same colors these two concepts already use elsewhere on this page (New =
// series-1, Resolved = status-good) — reused here rather than picked fresh,
// so "received" and "resolved" read the same way in every chart.
const RECEIVED_SERIES = { key: 'received', label: 'Received', color: 'var(--series-1)' };
const RESOLVED_SERIES = { key: 'resolved', label: 'Resolved', color: 'var(--status-good)' };

const DEFAULT_SLA_HOURS = 48;

function formatDay(d) {
  return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatWeekStart(d) {
  return `Wk of ${new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

const PRIORITY_ORDER = ['URGENT', 'HIGH', 'NORMAL', 'LOW'];

const PERIOD_GRANULARITIES = [
  { key: 'month', label: 'Month' },
  { key: 'quarter', label: 'Quarter' },
  { key: 'year', label: 'Year' },
];
const VOLUME_GRANULARITIES = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'quarter', label: 'Quarter' },
];

// Rolling window for the volume panel's smoothed view — only offered at
// day granularity, where raw daily counts are noisy enough that a trend
// line benefits from averaging; week/month/quarter are already smooth
// enough on their own.
const ROLLING_AVG_DAYS = 7;

// Period strings come straight from the backend's SQL grouping (see
// resolutionTimeTrend in db/repository.js): "2026-07" for month (calendar),
// "2026-FQ1" for quarter, "2026" for year — the latter two are fiscal, not
// calendar (FY starts 1 Jul; "2026" means the FY starting Jul 2026 and
// ending Jun 2027, so it's shown as "FY26–27" rather than the bare year,
// which would otherwise read as calendar 2026). Reformatted here for
// display only, never used for sorting/comparison (the backend already
// returns them in fiscal order).
function fiscalYearLabel(startYear) {
  const endYearShort = String(Number(startYear) + 1).slice(-2);
  return `FY${String(startYear).slice(-2)}–${endYearShort}`;
}

function formatTrendPeriod(period, granularity) {
  if (granularity === 'month') {
    const [y, m] = period.split('-');
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }
  if (granularity === 'quarter') {
    const [startYear, q] = period.split('-FQ');
    return `Q${q} ${fiscalYearLabel(startYear)}`;
  }
  return fiscalYearLabel(period);
}

// Volume's granularity set (day/week/month/quarter) overlaps with the
// month/quarter/year panels' set but adds day/week, which have their own
// existing formatters (plain calendar dates, not fiscal).
function formatVolumePeriod(period, granularity) {
  if (granularity === 'day') return formatDay(period);
  if (granularity === 'week') return formatWeekStart(period);
  return formatTrendPeriod(period, granularity);
}

// Age of the action queue's oldest-open rows — these can genuinely be
// years old (demo/seed data, or a long-neglected real one), so this
// always shows whole days once at least one has passed rather than
// switching to a "years" unit past some threshold; a bare day count stays
// legible and comparable across the whole queue either way.
function formatAge(receivedAt) {
  const ms = Date.now() - new Date(receivedAt).getTime();
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days}d`;
  const hours = Math.max(0, Math.floor(ms / (60 * 60 * 1000)));
  return `${hours}h`;
}

// Trailing N-day rolling average over an already-fetched day-granularity
// series — computed client-side (no new endpoint) since it's a pure
// function of rows the volume panel already has. The first few points
// average over a shorter, partial window (as many prior days as exist)
// rather than needing N-1 days of lookback the chart doesn't have.
function rollingAverage(rows, key, windowSize) {
  return rows.map((_, i) => {
    const windowRows = rows.slice(Math.max(0, i - windowSize + 1), i + 1);
    return windowRows.reduce((sum, r) => sum + r[key], 0) / windowRows.length;
  });
}

// Shared shape for the small "Loading… / failed / empty / data" panel body
// used by every period-toggle KPI panel below, so that state-handling logic
// (and its ordering — error first, then loading, then empty, then content)
// isn't repeated five times with a chance of drifting out of sync.
function TrendPanelBody({ error, loading, data, emptyMessage, children }) {
  if (error) return <p className="draft-hint" style={{ margin: 0 }}>Failed to load: {error}</p>;
  if (loading) return <p className="draft-hint" style={{ margin: 0 }}>Loading…</p>;
  if (!data || data.length === 0) return <p className="draft-hint" style={{ margin: 0 }}>{emptyMessage}</p>;
  return children;
}

function GranularityToggle({ granularities, value, onChange }) {
  return (
    <div className="panel-toggle">
      {granularities.map((g) => (
        <button
          key={g.key}
          type="button"
          className={`panel-toggle-btn${value === g.key ? ' active' : ''}`}
          onClick={() => onChange(g.key)}
        >
          {g.label}
        </button>
      ))}
    </div>
  );
}

export default function Overview() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [mailbox, setMailbox] = useState(null);

  // Each of these three gets its own independent Month/Quarter/Year
  // toggle — briefly consolidated into one shared control, then split
  // back out: sharing one control meant clicking it re-rendered all three
  // panels at once, making it impossible to compare a panel's "before" and
  // "after" state while switching granularity (you'd lose sight of what
  // the other panels looked like a moment ago). A per-card toggle costs a
  // little more visual repetition but keeps that comparison possible.
  const [resolutionGranularity, setResolutionGranularity] = useState('month');
  const [firstResponseGranularity, setFirstResponseGranularity] = useState('month');
  const [backlogGranularity, setBacklogGranularity] = useState('month');
  const [volumeGranularity, setVolumeGranularity] = useState('day');
  // Only meaningful (and only shown) at day granularity — see
  // ROLLING_AVG_DAYS above.
  const [volumeSmoothed, setVolumeSmoothed] = useState(false);

  // Facility-scoped reclassify (Top facilities panel) — one at a time,
  // fire-and-poll same as the mailbox-wide backfill job (see
  // reclassifyByFacility in graph/poller.js). reclassifyCancelRef guards
  // the poll loop's setState calls against firing after this page has
  // navigated away mid-poll. The effect body resets the flag to false, not
  // just the cleanup setting it true — React 18 StrictMode double-invokes
  // this effect once in dev (mount -> effect -> cleanup -> effect again),
  // and a cleanup-only version left the ref permanently `true` after that
  // synthetic cleanup with nothing to ever flip it back, silently killing
  // every poll loop's first status check before it could schedule a
  // second one.
  const [reclassifyingFacility, setReclassifyingFacility] = useState(null);
  const [reclassifyResult, setReclassifyResult] = useState(null);
  const reclassifyCancelRef = useRef(false);
  useEffect(() => {
    reclassifyCancelRef.current = false;
    return () => { reclassifyCancelRef.current = true; };
  }, []);

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

  // Each backed by its own usePeriodTrend call (fetch + AbortController
  // cleanup on granularity change, see hooks/usePeriodTrend.js).
  // resolutionByPriority has no real granularity (an all-time snapshot,
  // not a period trend — see resolutionTimeByPriority in
  // db/repository.js), so it's called with a fixed 'all' key just to
  // reuse the same fetch/abort plumbing rather than duplicating it for
  // one const-value case.
  const resolutionTrend = usePeriodTrend(getResolutionTrend, resolutionGranularity);
  const firstResponseTrend = usePeriodTrend(getFirstResponseTrend, firstResponseGranularity);
  const backlogTrend = usePeriodTrend(getBacklogTrend, backlogGranularity);
  const volumeTrend = usePeriodTrend(getVolumeTrend, volumeGranularity);
  const priorityTrend = usePeriodTrend((_g, opts) => getResolutionByPriority(opts), 'all');

  // Hooks must run unconditionally, so these all sit above the
  // loading/error early-returns below, fed with `null` until stats arrive.
  const totalDisplay = useCountUp(stats?.total ?? null);
  const openDisplay = useCountUp(stats?.openCount ?? null);
  const urgentDisplay = useCountUp(stats?.urgentOpen ?? null);

  // Memoized since these are pure functions of `stats` alone, but Overview
  // re-renders on every useCountUp animation tick (up to 5 concurrent
  // animations x ~42 frames over 700ms right after stats load) — without
  // this, all four array transforms below re-ran on every one of those
  // frames for no reason.
  //
  // Pareto view: same descending-by-count order as before, plus a running
  // cumulative share folded into each label (e.g. "... (cum. 68%)") rather
  // than a second axis — a classic Pareto chart is dual-axis (bars +
  // cumulative-% line), which is the single biggest chart anti-pattern
  // this project avoids elsewhere, so the cumulative figure is a direct
  // label instead of a second scale. No automation-candidate highlighting
  // yet — which categories count as one is a real judgment call, not
  // something to guess at and bake in silently.
  const categoryData = useMemo(() => {
    if (!stats) return [];
    const sorted = Object.entries(stats.byCategory)
      .map(([key, value]) => ({ key, value, label: categoryLabel(key) }))
      .sort((a, b) => b.value - a.value);
    const total = sorted.reduce((sum, c) => sum + c.value, 0);
    let cumulative = 0;
    return sorted.map((c) => {
      cumulative += c.value;
      const cumPct = total > 0 ? Math.round((cumulative / total) * 100) : 0;
      return { ...c, label: `${c.label} (cum. ${cumPct}%)` };
    });
  }, [stats]);

  const facilityData = useMemo(() => {
    if (!stats) return [];
    return stats.byFacility.map((f) => ({ key: f.facility, value: f.count, label: f.facility }));
  }, [stats]);

  const agingData = useMemo(() => {
    if (!stats) return [];
    return stats.agingBuckets.map((b) => ({ key: b.bucket, value: b.count, label: b.bucket, color: AGING_COLORS[b.bucket] }));
  }, [stats]);

  // Action queue — the 5 longest-waiting open enquiries (see
  // oldestOpenQueue in db/repository.js), replacing the single "oldest
  // unactioned enquiry" banner. No owner column: assigned_to isn't a real,
  // populated feature yet (see the comment on OLDEST_OPEN_QUEUE_SIZE in
  // repository.js) — showing a blank/fake column would be worse than
  // omitting it.
  const actionQueueData = useMemo(() => {
    if (!stats) return [];
    return stats.oldestOpenQueue.map((e) => ({ ...e, age: formatAge(e.receivedAt) }));
  }, [stats]);

  // count (and, for resolution time, SLA compliance) folded into the label
  // rather than a second BarList series, since they're on a completely
  // different scale (a count/percentage vs. hours) — same reasoning
  // DualTrendChart's shared-axis limitation would otherwise run into if
  // these were plotted together.
  const resolutionTrendData = useMemo(() => {
    if (!resolutionTrend.data) return [];
    return resolutionTrend.data.map((r) => {
      const slaPct = r.slaComplianceRate == null ? null : Math.round(r.slaComplianceRate * 100);
      return {
        key: r.period,
        value: r.avgHours,
        label: `${formatTrendPeriod(r.period, resolutionGranularity)} (${r.count} resolved${slaPct == null ? '' : ` · ${slaPct}% ≤${DEFAULT_SLA_HOURS}h`})`,
      };
    });
  }, [resolutionTrend.data, resolutionGranularity]);

  const firstResponseTrendData = useMemo(() => {
    if (!firstResponseTrend.data) return [];
    return firstResponseTrend.data.map((r) => ({
      key: r.period,
      value: r.avgHours,
      label: `${formatTrendPeriod(r.period, firstResponseGranularity)} (${r.count} replied)`,
    }));
  }, [firstResponseTrend.data, firstResponseGranularity]);

  const backlogTrendData = useMemo(() => {
    if (!backlogTrend.data) return [];
    return backlogTrend.data.map((r) => ({
      key: r.period,
      value: r.openAtEnd,
      label: formatTrendPeriod(r.period, backlogGranularity),
    }));
  }, [backlogTrend.data, backlogGranularity]);

  // Raw by default; the 7-day rolling average (day granularity only)
  // replaces received/resolved with their smoothed equivalents rather than
  // adding two more lines alongside the raw ones — a 4-line chart reads as
  // noise, and smoothing exists specifically to replace noisy raw data,
  // not sit next to it.
  const volumeChartData = useMemo(() => {
    if (!volumeTrend.data) return [];
    if (volumeGranularity !== 'day' || !volumeSmoothed) return volumeTrend.data;
    const receivedAvg = rollingAverage(volumeTrend.data, 'received', ROLLING_AVG_DAYS);
    const resolvedAvg = rollingAverage(volumeTrend.data, 'resolved', ROLLING_AVG_DAYS);
    return volumeTrend.data.map((row, i) => ({ period: row.period, received: receivedAvg[i], resolved: resolvedAvg[i] }));
  }, [volumeTrend.data, volumeGranularity, volumeSmoothed]);

  const priorityTrendData = useMemo(() => {
    if (!priorityTrend.data) return [];
    return [...priorityTrend.data]
      .sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority))
      .map((r) => ({
        key: r.priority,
        value: r.avgHours,
        label: `${priorityLabel(r.priority)} (${r.count} resolved)`,
      }));
  }, [priorityTrend.data]);

  // Fires the facility-scoped reclassify job, then polls its status until
  // done (same 202-then-poll shape as the mailbox-wide backfill — see
  // reclassifyByFacility/getReclassifyByFacilityStatus in api.js). Scoped
  // to *every* enquiry currently attributed to `facility`, not just the
  // ones counted in this panel's since-TOTAL_SINCE total — the confirm
  // copy says so rather than quoting a number that wouldn't match.
  async function handleReclassifyFacility(facility) {
    if (reclassifyingFacility) return;
    const confirmed = window.confirm(
      `Reclassify all enquiries currently attributed to "${facility}"?\n\nThis re-runs AI classification and may change category, priority, or status — including any enquiries from before the reporting window shown here.`
    );
    if (!confirmed) return;

    setReclassifyingFacility(facility);
    setReclassifyResult(null);
    try {
      await reclassifyByFacility(facility);
    } catch (e) {
      if (reclassifyCancelRef.current) return;
      setReclassifyingFacility(null);
      setReclassifyResult({ facility, message: `Failed to start: ${e.message}` });
      return;
    }

    const poll = async () => {
      let status;
      try {
        status = await getReclassifyByFacilityStatus();
      } catch (e) {
        if (reclassifyCancelRef.current) return;
        setReclassifyingFacility(null);
        setReclassifyResult({ facility, message: `Failed to check progress: ${e.message}` });
        return;
      }
      if (reclassifyCancelRef.current) return;
      if (status.running) {
        setTimeout(poll, 2000);
        return;
      }
      setReclassifyingFacility(null);
      const result = status.lastResult;
      if (!result || result.error) {
        setReclassifyResult({ facility, message: `Failed: ${result?.error || 'unknown error'}` });
      } else {
        setReclassifyResult({
          facility,
          message: `Reclassified ${result.reclassified}/${result.reassessed}${result.failed ? `, ${result.failed} failed` : ''}.`,
        });
        getOverviewStats().then(setStats).catch(() => {});
      }
    };
    setTimeout(poll, 1500);
  }

  if (error) return <div className="error-state">Failed to load stats: {error}</div>;
  if (!stats) return <OverviewSkeleton />;

  const weeklyDelta = stats.last7Days - stats.prev7Days;
  const trendDirection = weeklyDelta > 0 ? 'up' : weeklyDelta < 0 ? 'down' : 'flat';
  const trendText =
    weeklyDelta === 0
      ? 'same as last week'
      : `${weeklyDelta > 0 ? '+' : ''}${weeklyDelta} vs last week`;

  // "Total enquiries" counts from a fixed reporting start date (backend
  // constant, not the mailbox's actual first-ever message) — without a
  // caption showing that date it reads as if it might be a weekly/monthly
  // figure instead.
  const sinceDate = stats.totalSinceDate
    ? new Date(stats.totalSinceDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  return (
    <div className="overview-page">
      <div className="overview-header">
        <h2>Mailbox Overview</h2>
        {mailbox && (
          <>
            <span className="overview-separator">–</span>
            <span className="overview-mailbox">{mailbox}</span>
          </>
        )}
      </div>

      <div className="stat-grid">
        <div className="stat-tile stat-tile-in" style={{ animationDelay: '0ms' }}>
          <div className="stat-tile-header">
            <IconLayers className="stat-icon" />
            <div className="label">Total enquiries</div>
          </div>
          <div className="value-row">
            <div className="value">{totalDisplay}</div>
            <div className={`trend ${trendDirection}`}>{trendText}</div>
          </div>
          {sinceDate && <div className="draft-hint">Since {sinceDate}</div>}
        </div>
        <div className="stat-tile stat-tile-in" style={{ animationDelay: '60ms' }}>
          <div className="stat-tile-header">
            <IconInbox className="stat-icon" />
            <div className="label">Open</div>
          </div>
          <div className="value">{openDisplay}</div>
          <div className="draft-hint">as of now</div>
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
      </div>

      {actionQueueData.length > 0 && (
        <div className="panel">
          <h3>Action queue — longest waiting, still open</h3>
          <ul className="action-queue">
            {actionQueueData.map((e) => (
              <li key={e.id} className="action-queue-row">
                <span className="action-queue-age">{e.age}</span>
                <PriorityBadge priority={e.priority} />
                <CategoryPill category={e.category} />
                <Link to={`/enquiries/${e.id}`} className="action-queue-subject">{e.subject}</Link>
                <span className="action-queue-sender">{e.sender.email}</span>
              </li>
            ))}
          </ul>
          <p className="draft-hint" style={{ margin: '10px 0 0' }}>
            Owner isn't shown — assignment tracking isn't a real feature yet (see the README).
          </p>
        </div>
      )}

      <div className="panel">
        <div className="panel-header-row">
          <h3>Enquiry volume: received vs. resolved by {volumeGranularity}</h3>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {volumeGranularity === 'day' && (
              <button
                type="button"
                className={`panel-toggle-btn${volumeSmoothed ? ' active' : ''}`}
                onClick={() => setVolumeSmoothed((v) => !v)}
                title={`${ROLLING_AVG_DAYS}-day rolling average, smooths day-to-day noise`}
              >
                {ROLLING_AVG_DAYS}d avg
              </button>
            )}
            <GranularityToggle granularities={VOLUME_GRANULARITIES} value={volumeGranularity} onChange={setVolumeGranularity} />
          </div>
        </div>
        <TrendPanelBody
          error={volumeTrend.error}
          loading={volumeTrend.loading}
          data={volumeTrend.data}
          emptyMessage="No enquiries recorded yet."
        >
          <DualTrendChart
            data={volumeChartData}
            xKey="period"
            seriesA={RECEIVED_SERIES}
            seriesB={RESOLVED_SERIES}
            xFormat={(p) => formatVolumePeriod(p, volumeGranularity)}
            format={(v) => (volumeSmoothed && volumeGranularity === 'day' ? v.toFixed(1) : v.toLocaleString())}
          />
          <p className="draft-hint" style={{ margin: '10px 0 4px' }}>Net received − resolved (bar above zero: backlog growing; below: shrinking)</p>
          <NetDiffChart data={volumeTrend.data || []} xKey="period" xFormat={(p) => formatVolumePeriod(p, volumeGranularity)} />
        </TrendPanelBody>
      </div>

      <div className="panel">
        <div className="panel-header-row">
          <h3>Avg. resolution time by {resolutionGranularity}</h3>
          <GranularityToggle granularities={PERIOD_GRANULARITIES} value={resolutionGranularity} onChange={setResolutionGranularity} />
        </div>
        {resolutionGranularity !== 'month' && (
          <p className="draft-hint" style={{ marginTop: 0, marginBottom: 10 }}>Financial year — 1 Jul to 30 Jun.</p>
        )}
        <TrendPanelBody
          error={resolutionTrend.error}
          loading={resolutionTrend.loading}
          data={resolutionTrendData}
          emptyMessage="No resolved enquiries with known resolution time yet."
        >
          <BarList data={resolutionTrendData} format={(h) => `${h.toFixed(1)}h`} />
        </TrendPanelBody>
      </div>

      <div className="chart-grid">
        <div className="panel">
          <h3>Resolution time by priority</h3>
          <TrendPanelBody
            error={priorityTrend.error}
            loading={priorityTrend.loading}
            data={priorityTrendData}
            emptyMessage="No resolved enquiries with known resolution time yet."
          >
            <BarList data={priorityTrendData} format={(h) => `${h.toFixed(1)}h`} />
          </TrendPanelBody>
        </div>

        <div className="panel">
          <div className="panel-header-row">
            <h3>First response time by {firstResponseGranularity}</h3>
            <GranularityToggle granularities={PERIOD_GRANULARITIES} value={firstResponseGranularity} onChange={setFirstResponseGranularity} />
          </div>
          {firstResponseGranularity !== 'month' && (
            <p className="draft-hint" style={{ marginTop: 0, marginBottom: 10 }}>Financial year — 1 Jul to 30 Jun.</p>
          )}
          <TrendPanelBody
            error={firstResponseTrend.error}
            loading={firstResponseTrend.loading}
            data={firstResponseTrendData}
            emptyMessage="No replies tracked yet — this only counts replies sent since this feature was added."
          >
            <BarList data={firstResponseTrendData} format={(h) => `${h.toFixed(1)}h`} />
          </TrendPanelBody>
        </div>

        <div className="panel">
          <div className="panel-header-row">
            <h3>Backlog (open at end of {backlogGranularity})</h3>
            <GranularityToggle granularities={PERIOD_GRANULARITIES} value={backlogGranularity} onChange={setBacklogGranularity} />
          </div>
          {backlogGranularity !== 'month' && (
            <p className="draft-hint" style={{ marginTop: 0, marginBottom: 10 }}>Financial year — 1 Jul to 30 Jun.</p>
          )}
          <TrendPanelBody
            error={backlogTrend.error}
            loading={backlogTrend.loading}
            data={backlogTrendData}
            emptyMessage="No data yet."
          >
            <BarList data={backlogTrendData} />
          </TrendPanelBody>
        </div>
      </div>

      <div className="chart-grid">
        <div className="panel">
          <h3>Open enquiries by age</h3>
          {agingData.some((b) => b.value > 0) ? (
            <StackedBar data={agingData} />
          ) : (
            <p className="draft-hint" style={{ margin: 0 }}>No open enquiries.</p>
          )}
        </div>

        <div className="panel">
          <h3>Enquiries by category{sinceDate ? ` (since ${sinceDate})` : ''}</h3>
          <BarList data={categoryData} linkTo={(key) => `/queue?category=${encodeURIComponent(key)}`} />
        </div>
      </div>

      <div className="panel">
        <div className="panel-header-row">
          <h3>Top facilities / organisations{sinceDate ? ` (since ${sinceDate})` : ''}</h3>
          {stats.facilityAttributionRate != null && (
            <span className="draft-hint" style={{ margin: 0 }} title="Share of enquiries with a real facility name, not 'Not attributed' — see classify.js's KNOWN_ORG_DOMAINS/GENERIC_DOMAINS">
              {Math.round(stats.facilityAttributionRate * 100)}% attributed
            </span>
          )}
        </div>
        {reclassifyResult && (
          <p className="draft-hint" style={{ marginTop: 0, marginBottom: 10 }}>
            "{reclassifyResult.facility}": {reclassifyResult.message}
          </p>
        )}
        {facilityData.length > 0 ? (
          <BarList
            data={facilityData}
            renderAction={(key) => (
              <button
                type="button"
                className={`bar-action-btn${reclassifyingFacility === key ? ' spinning' : ''}`}
                disabled={reclassifyingFacility !== null}
                title={`Reclassify all enquiries from "${key}"`}
                onClick={() => handleReclassifyFacility(key)}
              >
                <IconRefresh />
              </button>
            )}
          />
        ) : (
          <p className="draft-hint" style={{ margin: 0 }}>No facility data yet.</p>
        )}
      </div>
    </div>
  );
}
