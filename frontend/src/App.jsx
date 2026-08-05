import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Link, Navigate, useLocation } from 'react-router-dom';
import Overview from './pages/Overview';
import Queue from './pages/Queue';
import Detail from './pages/Detail';
import { getOverviewStats, getIngestStatus } from './api';
import {
  IconGrid,
  IconInbox,
  IconAlertTriangle,
  IconDot,
  IconSun,
  IconMoon,
  IconMonitor,
  IconSearch,
  IconRefresh,
} from './components/Icons';
import { CommandPalette } from './components/CommandPalette';
import logoFull from './assets/jdhg-logo-full-white.png';
// The original jdhg-mark-white.png has ~60px of transparent padding on its
// right edge only, which throws off centering at icon size — this is a
// pre-trimmed copy so margin:auto centers the actual diamond, not its box.
import logoMark from './assets/jdhg-mark-white-trimmed.png';
import './App.css';

const STATS_REFRESH_MS = 60000;
const STATS_REFRESH_SECONDS = STATS_REFRESH_MS / 1000;
const THEME_KEY = 'enquiry-dashboard-theme';
const FORCE_DESKTOP_KEY = 'enquiry-dashboard-force-desktop';
const DESKTOP_VIEWPORT = 'width=1280';
const DEFAULT_VIEWPORT = 'width=device-width, initial-scale=1.0';

function systemPrefersDark() {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

function AppRoutes() {
  const location = useLocation();
  return (
    <div className="page-transition" key={location.pathname}>
      <Routes>
        <Route path="/" element={<Navigate to="/overview" replace />} />
        <Route path="/overview" element={<Overview />} />
        <Route path="/queue" element={<Queue />} />
        <Route path="/enquiries/:id" element={<Detail />} />
      </Routes>
    </div>
  );
}

function App() {
  const [stats, setStats] = useState(null);
  const [ingestStatus, setIngestStatus] = useState(null);
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === 'light' || saved === 'dark' ? saved : systemPrefersDark() ? 'dark' : 'light';
  });
  const [forceDesktop, setForceDesktop] = useState(() => localStorage.getItem(FORCE_DESKTOP_KEY) === '1');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [secondsToRefresh, setSecondsToRefresh] = useState(STATS_REFRESH_SECONDS);

  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // A single 1-second tick drives both the sidebar countdown display and the
  // actual refresh (firing it at 0 instead of running a separate 60s
  // interval) — that way "seconds remaining" is never just a cosmetic
  // number disconnected from when data actually reloads.
  useEffect(() => {
    const load = () => getOverviewStats().then(setStats).catch(() => {});
    load();
    const tick = setInterval(() => {
      setSecondsToRefresh((s) => {
        if (s <= 1) {
          load();
          return STATS_REFRESH_SECONDS;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    getIngestStatus().then(setIngestStatus).catch(() => {});
  }, []);

  function refreshNow() {
    getOverviewStats().then(setStats).catch(() => {});
    setSecondsToRefresh(STATS_REFRESH_SECONDS);
  }

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    const viewport = document.querySelector('meta[name="viewport"]');
    if (viewport) {
      viewport.setAttribute('content', forceDesktop ? DESKTOP_VIEWPORT : DEFAULT_VIEWPORT);
    }
    localStorage.setItem(FORCE_DESKTOP_KEY, forceDesktop ? '1' : '0');
  }, [forceDesktop]);

  const urgentCount = stats?.urgentOpen ?? null;

  return (
    <BrowserRouter>
      <div className={`app-shell${forceDesktop ? ' force-desktop' : ''}`}>
        <nav className="sidebar">
          <div className="brand">
            <img className="brand-logo brand-logo-full" src={logoFull} alt="JD Healthcare Group" />
            <img className="brand-logo brand-logo-mark" src={logoMark} alt="JD Healthcare Group" />
          </div>
          <div className="app-title">Enquiry Dashboard</div>

          <div className="sidebar-nav">
            <button type="button" className="sidebar-search-btn" onClick={() => setPaletteOpen(true)}>
              <IconSearch className="nav-icon" />
              <span className="nav-label">Quick search</span>
              <kbd className="sidebar-search-kbd">⌘K</kbd>
            </button>
            <NavLink to="/overview" className={({ isActive }) => (isActive ? 'active' : '')}>
              <IconGrid className="nav-icon" />
              <span className="nav-label">Overview</span>
            </NavLink>
            <NavLink to="/queue" className={({ isActive }) => (isActive ? 'active' : '')}>
              <IconInbox className="nav-icon" />
              <span className="nav-label">All Enquiries</span>
              {stats && <span className="nav-count">{stats.openCount}</span>}
            </NavLink>

            <div className="sidebar-section">Quick filters</div>
            <Link to="/queue?priority=URGENT&sort=status&order=asc" className="quick-filter-link">
              <IconAlertTriangle className="nav-icon" />
              <span className="nav-label">Urgent</span>
              {urgentCount !== null && (
                <span className={`nav-count${urgentCount > 0 ? ' urgent' : ''}`}>{urgentCount}</span>
              )}
            </Link>
          </div>

          <div className="sidebar-footer">
            <div className="sidebar-toggles">
              <button
                type="button"
                className="sidebar-toggle-btn"
                aria-pressed={theme === 'dark'}
                onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              >
                {theme === 'dark' ? <IconMoon className="nav-icon" /> : <IconSun className="nav-icon" />}
                <span>{theme === 'dark' ? 'Dark mode' : 'Light mode'}</span>
              </button>
              <button
                type="button"
                className={`sidebar-toggle-btn${forceDesktop ? ' active' : ''}`}
                aria-pressed={forceDesktop}
                onClick={() => setForceDesktop((v) => !v)}
              >
                <IconMonitor className="nav-icon" />
                <span>Desktop mode</span>
              </button>
            </div>
            {ingestStatus && (
              <div className="sidebar-status-row">
                <IconDot className={ingestStatus.graphConfigured ? 'status-dot-live' : 'status-dot-demo'} />
                <span>{ingestStatus.graphConfigured ? 'Live mailbox' : 'Demo data'}</span>
              </div>
            )}
            {ingestStatus && (
              <div className="sidebar-status-row">
                <IconDot className={ingestStatus.aiConfigured ? 'status-dot-live' : 'status-dot-demo'} />
                <span>{ingestStatus.aiConfigured ? 'Claude classification' : 'Rules-only classification'}</span>
              </div>
            )}
            <button type="button" className="sidebar-refresh-btn" onClick={refreshNow} title="Refresh now">
              <IconRefresh className="nav-icon" />
              <span>Refreshing in {secondsToRefresh}s</span>
            </button>
          </div>
        </nav>
        <div className="main">
          <AppRoutes />
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </BrowserRouter>
  );
}

export default App;
