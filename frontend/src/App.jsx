import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Link, Navigate } from 'react-router-dom';
import Overview from './pages/Overview';
import Queue from './pages/Queue';
import Detail from './pages/Detail';
import { getOverviewStats } from './api';
import logoMark from './assets/jdhg-mark-white.png';
import './App.css';

const STATS_REFRESH_MS = 60000;

function App() {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    const load = () => getOverviewStats().then(setStats).catch(() => {});
    load();
    const interval = setInterval(load, STATS_REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  const urgentCount = stats?.urgentOpen ?? null;
  const newCount = stats?.byStatus?.NEW ?? null;

  return (
    <BrowserRouter>
      <div className="app-shell">
        <nav className="sidebar">
          <div className="brand">
            <img className="brand-mark" src={logoMark} width="30" height="30" alt="" aria-hidden="true" />
            <div className="brand-word">
              <span className="brand-name">JD HEALTHCARE</span>
              <span className="brand-sub">Group</span>
            </div>
          </div>
          <div className="app-title">Enquiry Dashboard</div>
          <NavLink to="/overview" className={({ isActive }) => (isActive ? 'active' : '')}>
            Overview
          </NavLink>
          <NavLink to="/queue" className={({ isActive }) => (isActive ? 'active' : '')}>
            Triage Queue
            {stats && <span className="nav-count">{stats.openCount}</span>}
          </NavLink>

          <div className="sidebar-section">Quick filters</div>
          <Link to="/queue?priority=URGENT" className="quick-filter-link">
            Urgent
            {urgentCount !== null && (
              <span className={`nav-count${urgentCount > 0 ? ' urgent' : ''}`}>{urgentCount}</span>
            )}
          </Link>
          <Link to="/queue?status=NEW" className="quick-filter-link">
            New / unactioned
            {newCount !== null && <span className="nav-count">{newCount}</span>}
          </Link>
        </nav>
        <div className="main">
          <Routes>
            <Route path="/" element={<Navigate to="/overview" replace />} />
            <Route path="/overview" element={<Overview />} />
            <Route path="/queue" element={<Queue />} />
            <Route path="/enquiries/:id" element={<Detail />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  );
}

export default App;
