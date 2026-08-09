import { lazy, Suspense } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { Loading } from './components/ui';
import { Overview } from './routes/Overview';
import { Method } from './routes/Method';
import './app.css';

// The two heavy tabs are code-split: the 3D globe and echarts only download when
// you open Structure / Positioning, not on first paint.
const Positioning = lazy(() => import('./routes/Positioning'));
const Structure = lazy(() => import('./routes/Structure'));
const Segments = lazy(() => import('./routes/Segments'));
const Playbook = lazy(() => import('./routes/Playbook'));

const TABS = [
  { to: '/', label: 'Overview', end: true },
  { to: '/positioning', label: 'Positioning', end: false },
  { to: '/structure', label: 'Structure', end: false },
  { to: '/segments', label: 'Segments', end: false },
  { to: '/playbook', label: 'Playbook', end: false },
  { to: '/method', label: 'Method', end: false },
];

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="wrap topbar-inner">
          <NavLink to="/" className="brand" end>
            <span className="brand-mark" aria-hidden />
            <span>The B2B SaaS <em>Positioning Index</em></span>
          </NavLink>
          <nav className="tabs" aria-label="Sections">
            {TABS.map((t) => (
              <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => `tab ${isActive ? 'tab-on' : ''}`}>
                {t.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main className="app-main">
        {/* Routes mount immediately -- no animation gates navigation, so a
            throttled tab or slow device can never strand you on a half-exited
            page. Per-view reveals (framer-motion whileInView) provide the motion. */}
        <Suspense fallback={<div className="wrap"><Loading /></div>}>
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/positioning" element={<Positioning />} />
            <Route path="/structure" element={<Structure />} />
            <Route path="/segments" element={<Segments />} />
            <Route path="/playbook" element={<Playbook />} />
            <Route path="/method" element={<Method />} />
            <Route path="*" element={<Overview />} />
          </Routes>
        </Suspense>
      </main>

      <footer className="app-footer">
        <div className="wrap">
          <p>
            225 companies read the same way on the same day. Measures what the market does, never what
            &ldquo;works&rdquo; — no conversion data here. Built by Ruslan Shogenov · self-hosted, no third-party requests.
          </p>
        </div>
      </footer>
    </div>
  );
}
