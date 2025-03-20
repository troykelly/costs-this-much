/**
 * @fileoverview The Cloudflare Worker responsible for scheduling data fetches from AEMO.
 * It's configured to run every 5 minutes offset by 1 minute (in your TOML). On each schedule:
 *  - it calls the Durable Object's /sync endpoint to fetch new intervals and store them.
 * Now includes environment-based debugging at "INFO"/"DEBUG" if LOG_LEVEL is set that way.
 */

import type {
  DurableObjectNamespace,
  ExecutionContext,
  ScheduledController,
} from '@cloudflare/workers-types';
import { AemoData } from './AemoDataDurableObject';

/** Environment for the Worker, referencing the DO and log level. */
export interface Env {
  /**
   * Points to the AemoData Durable Object class. Must be configured in wrangler.*.toml
   * with a matching migration to enable Cloudflare’s SQL backend (new_sqlite_classes).
   */
  AEMO_DATA: DurableObjectNamespace;

  /** The AEMO API URL, also read by the DO. */
  AEMO_API_URL: string;

  /** JSON headers for connecting to AEMO. */
  AEMO_API_HEADERS: string;

  /** Optional environment-based log level: "DEBUG", "INFO", "WARN", or "ERROR". */
  LOG_LEVEL?: string;
}

// Re-export the DO class for Wrangler’s build:
export { AemoData } from './AemoDataDurableObject';

const WORKER_INFO = `AEMO Data Logger Worker. 
Runs on a CRON schedule, calls the DO’s /sync route to ingest intervals. 
Honours LOG_LEVEL in environment for additional debugging.`;

export default {
  /**
   * Invoked by Cloudflare’s scheduler as configured in wrangler.*.toml (e.g. every 5min).
   * Triggers the DO's /sync route to fetch and insert intervals.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const logLevel = env.LOG_LEVEL ?? 'WARN';
    if (getLogPriority(logLevel) <= getLogPriority('INFO')) {
      console.log(`[INFO] Scheduled event triggered. Invoking DO sync with LOG_LEVEL="${logLevel}".`);
    }

    const id = env.AEMO_DATA.idFromName('AEMO_LOGGER');
    const stub = env.AEMO_DATA.get(id);
    await stub.fetch('https://dummy-url/sync', { method: 'POST' });
  },

  /**
   * Minimal fetch handler. For local dev, you can run wrangler dev --test-scheduled
   * or call /__scheduled?cron=*+*+*+*+* to simulate the scheduled event triggers.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const logLevel = env.LOG_LEVEL ?? 'WARN';
    if (getLogPriority(logLevel) <= getLogPriority('INFO')) {
      console.log(`[INFO] Worker fetch handler invoked.`);
    }
    return new Response(WORKER_INFO, { headers: { 'Content-Type': 'text/plain' } });
  },
};

/** Helper to convert log level strings to numeric priority. */
function getLogPriority(level: string): number {
  switch (level.toUpperCase()) {
    case 'DEBUG': return 1;
    case 'INFO':  return 2;
    case 'WARN':  return 3;
    case 'ERROR': return 4;
    default:      return 99; // 'NONE' or unknown
  }
}