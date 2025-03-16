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

// Automatically redirect to /nsw if user is at root path.
if (window.location.pathname === '/') {
  window.location.replace('/nsw');
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