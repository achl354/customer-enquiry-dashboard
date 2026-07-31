import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import Overview from './pages/Overview';
import Queue from './pages/Queue';
import Detail from './pages/Detail';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <nav className="sidebar">
          <h1>Enquiry Dashboard</h1>
          <NavLink to="/overview" className={({ isActive }) => (isActive ? 'active' : '')}>
            Overview
          </NavLink>
          <NavLink to="/queue" className={({ isActive }) => (isActive ? 'active' : '')}>
            Triage Queue
          </NavLink>
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
