/**
 * @fileoverview The Cloudflare Worker entry point for the AEMO data-logging mode.
 *
 * This worker uses a cron-based schedule to periodically call the associated Durable
 * Object's /sync endpoint, which fetches and stores fresh intervals from AEMO in a
 * SQL-based table. We've addressed typed transaction usage and type constraints for
 * the IntervalRecord shape.
 */

import type {
  DurableObjectNamespace,
  ExecutionContext,
  ScheduledController,
} from '@cloudflare/workers-types';
import { AemoData } from './AemoDataDurableObject';

/**
 * Environment interface for the data-logger Worker.
 */
export interface Env {
  /**
   * Reference to the AEMO_DATA Durable Object, which stores and manages
   * the interval data in a SQLite database.
   */
  AEMO_DATA: DurableObjectNamespace;

  /**
   * AEMO data endpoints, also consumed by the DO environment for direct fetch calls.
   */
  AEMO_API_URL: string;
  AEMO_API_HEADERS: string;
}

/**
 * Export the DO class so Cloudflare can find and deploy it.
 */
export { AemoData } from './AemoDataDurableObject';

/**
 * Main Worker logic: sets up a scheduled job to trigger data ingestion.
 */
export default {
  /**
   * The scheduled handler runs every 5 minutes offset by 1 minute (or as configured).
   *
   * @param controller The Cloudflare scheduled event controller.
   * @param env        The typed environment with DO references.
   * @param ctx        The execution context for async tasks.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      const id = env.AEMO_DATA.idFromName("AEMO_LOGGER");
      const stub = env.AEMO_DATA.get(id);
      await stub.fetch("https://dummy-url/sync", { method: "POST" });
    } catch (err) {
      console.error("Scheduled job error in data logger:", err);
    }
  },

  /**
   * A basic fetch handler for local testing or fallback usage.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response(
      "AEMO data logger Worker: use scheduled triggers or manual fetch to /sync on the DO.\n",
      { headers: { "content-type": "text/plain" } }
    );
  }
};