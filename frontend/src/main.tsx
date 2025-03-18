/**
 * @fileoverview main.tsx - Entry point for the React application. Renders the main App component.
 *
 * This file should be loaded as a module in index.html: <script type="module" src="./src/main.tsx"></script>
 *
 * Author: Troy Kelly <troy@troykelly.com>
 * Original Date: 16 March 2025
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const hostname = window.location.hostname;
const isDevMode = hostname.includes('localhost') || hostname.includes('127.');
if (window.location.pathname === '/') {
  // In dev mode (localhost) use the querystring "?s" for the scenario, defaulting to "toast"
  if (isDevMode) {
    window.location.replace('/nsw?s=toast');
  } else {
    // In production, if the hostname lacks a subdomain (only two parts) then redirect to a default subdomain "toast"
    const parts = hostname.split('.');
    if (parts.length === 2) {
      window.location.replace(`toast.${hostname}/nsw`);
    }
    // Otherwise (hostname already has a subdomain) let the app load normally.
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Could not find root element to mount to.');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);