import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import './theme.css';
import App from './App.tsx';

// HashRouter: the deploy is a pure static mirror (rsync to the VPS) with no
// server-side rewrite rules, so routes live in the hash and always resolve.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
