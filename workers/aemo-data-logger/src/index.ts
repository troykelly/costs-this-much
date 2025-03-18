/**
 * @fileoverview The Cloudflare Worker responsible for scheduling data fetches from AEMO.
 * It's configured to run every 5 minutes offset by 1 minute (in your TOML). On each schedule:
 *  - it calls the Durable Object's /sync endpoint to fetch new intervals and store them.
 */

import type {
  DurableObjectNamespace,
  ExecutionContext,
  ScheduledController,
} from '@cloudflare/workers-types';
import { AemoData } from './AemoDataDurableObject';

/**
 * The environment for this Worker, referencing the DO namespace and any needed forms of config.
 */
export interface Env {
  /**
   * Points to the AemoData Durable Object class, declared in wrangler.*.toml with
   * a "new_sqlite_classes = ['AemoData']" migration to enable Cloudflare’s SQL backend.
   */
  AEMO_DATA: DurableObjectNamespace;

  /** The AEMO API URL, also read by the DO. */
  AEMO_API_URL: string;

  /** JSON headers for connecting to AEMO. */
  AEMO_API_HEADERS: string;
}

// Re-export the DO class so Wrangler sees it in the same build:
export { AemoData } from './AemoDataDurableObject';

const WORKER_INFO = `AEMO Data Logger Worker. 
Runs on a CRON schedule, calls the DO’s /sync route to ingest intervals.`;

/**
 * The Worker’s scheduled function triggers the DO to run its sync routine.
 */
export default {
  /**
   * Invoked by Cloudflare’s scheduler as configured in wrangler.*.toml (e.g., every 5min).
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const id = env.AEMO_DATA.idFromName('AEMO_LOGGER');
    const stub = env.AEMO_DATA.get(id);

    // As the DO code expects a POST /sync, we call that:
    await stub.fetch('https://dummy-url/sync', { method: 'POST' });
  },

  /**
   * Minimal fetch handler. For local dev, you can run wrangler dev --test-scheduled
   * or call /__scheduled?cron=*+*+*+*+* to simulate the scheduled event triggers.
   */
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response(WORKER_INFO, { headers: { 'Content-Type': 'text/plain' } });
  },
};