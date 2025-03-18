/**
 * @fileoverview Entry point for the AEMO data logger Worker.
 *
 * Schedules every 5 minutes offset by 1 minute to fetch missing intervals from the AEMO API and
 * store them in a SQL-based Durable Object. Adheres to Cloudflare's documented approach for
 * using DO + SQL.
 */

import type {
  DurableObjectNamespace,
  ExecutionContext,
  ScheduledController,
} from '@cloudflare/workers-types';
import { AemoData } from './AemoDataDurableObject';

/**
 * Typed environment for the data-logger approach.
 */
export interface Env {
  /**
   * Reference to the AEMO_DATA Durable Object, which stores and manages
   * the intervals in an embedded SQLite database.
   */
  AEMO_DATA: DurableObjectNamespace;

  /**
   * AEMO API endpoint, also used by the DO for retrieving intervals.
   */
  AEMO_API_URL: string;

  /**
   * JSON string of HTTP headers to pass to the AEMO API fetch calls.
   */
  AEMO_API_HEADERS: string;
}

/**
 * Export the DO class so that Wrangler can identify and deploy it.
 */
export { AemoData } from './AemoDataDurableObject';

export default {
  /**
   * Called by Cloudflare on your configured cron schedule. This function locates the DO instance
   * (by name), then invokes the /sync route to fetch and store data.
   *
   * @param controller The scheduled task controller.
   * @param env        The typed environment containing references and secrets.
   * @param ctx        The execution context for async tasks.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      const id = env.AEMO_DATA.idFromName("AEMO_LOGGER");
      const stub = env.AEMO_DATA.get(id);

      // Ask the DO to run its sync routine:
      await stub.fetch("https://dummy-url/sync", { method: "POST" });
    } catch (err) {
      console.error("Data logger scheduled task error:", err);
    }
  },

  /**
   * Minimal fetch handler. The data ingestion primarily relies on the scheduled handler above.
   * For local testing, you can run wrangler dev --test-scheduled and
   * call /__scheduled?cron=*+*+*+*+* to simulate the cron invocation.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response(
      "AEMO data logger Worker. Cron triggers handle ingestion.\n",
      { headers: { "content-type": "text/plain" } }
    );
  },
};