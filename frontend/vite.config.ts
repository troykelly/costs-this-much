/**
 * vite.config.ts - Vite configuration for the frontend workspace.
 *
 * This configuration utilises the React plugin for Vite and sets up Vitest for testing.
 *
 * Author: Troy Kelly (troy@team.production.city)
 * Created: 16 March 2025
 */

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  // Deduplicate React so that only a single version is used throughout.
  resolve: {
    dedupe: ['react', 'react-dom']
  },
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom'
  }
})