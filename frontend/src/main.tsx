/**
 * @fileoverview main.tsx - Entry point for the React application. Renders the main App component.
 *
 * It also handles service worker registration from the root domain. Because our SW file
 * lives in "public/sw.js" with no Vite transformations, we cannot do "import.meta.env"
 * directly in there. Instead, we pass the API base URL via a postMessage once the SW is ready.
 *
 * Author: Troy Kelly <troy@troykelly.com>
 * Original Date: 16 March 2025
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Ensure the default scenario if someone hits "/"
const hostname = window.location.hostname;
const isDevMode = hostname.includes('localhost') || hostname.includes('127.');
if (window.location.pathname === '/') {
  // In dev mode, use "?s=toast" by default
  if (isDevMode) {
    window.location.replace('/nsw?s=toast');
  } else {
    // In production, if just domain.com => subdomain "toast"
    const parts = hostname.split('.');
    if (parts.length === 2) {
      window.location.replace(`toast.${hostname}/nsw`);
    }
  }
}

// Mount the React app
const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Could not find root element to mount.');
}
const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register our service worker from the public folder. Then configure it with the API URL.
if ('serviceWorker' in navigator) {
  const rootURL = import.meta.env.VITE_APP_URL || '';
  const swScriptURL = rootURL.replace(/\/+$/, '') + '/sw.js';
  const scopeURL   = rootURL.replace(/\/+$/, '') + '/';

  navigator.serviceWorker
    .register(swScriptURL, { scope: scopeURL })
    .then(() => navigator.serviceWorker.ready)
    .then((reg) => {
      // At this point, the service worker is installed & active.
      if (reg.active) {
        // We'll send it a message with our environment-based API URL
        const requestId = 'cfg_' + Date.now();
        reg.active.postMessage({
          requestId,
          command: 'CONFIGURE_API',
          apiBaseURL: import.meta.env.VITE_API_URL || ''
        });
      }
    })
    .catch((err) => {
      console.error('SW registration or configuration failed:', err);
    });
}