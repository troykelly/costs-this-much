/**
 * @fileoverview Cloudflare Worker entry point for the AEMO Data Logger.
 * Schedules every 5 minutes offset by 1 minute, fetches missing intervals from
 * AEMO, and stores them in a SQL-based Durable Object. This is the primary
 * orchestration script for data ingestion, now fully typed with no untyped
 * references.
 *
 * Usage:
 *  - Invoked automatically via schedule triggers.
 *  - For local testing of scheduled behavior, run `wrangler dev --test-scheduled`
 *    and then invoke /__scheduled?cron=*+*+*+*+* (or a custom cron pattern).
 */

import type {
  DurableObjectNamespace,
  ExecutionContext,
  ScheduledController,
} from '@cloudflare/workers-types';
import { AemoData } from './AemoDataDurableObject';

/**
 * Env interface defining the required environment bindings for the logger Worker.
 */
interface Env {
  /**
   * The Durable Object namespace for storing AEMO data in a SQL database.
   */
  AEMO_DATA: DurableObjectNamespace;

  /**
   * The endpoint URL used in the scheduled Worker for reference if needed
   * (also referenced in the DO).
   */
  AEMO_API_URL: string;

  /**
   * JSON string representing HTTP headers for requests to the AEMO API.
   */
  AEMO_API_HEADERS: string;
}

// Re-export the DO class for Cloudflare to find:
export { AemoData } from './AemoDataDurableObject';

export default {
  /**
   * Scheduled handler that runs automatically based on the cron settings provided
   * in wrangler.logger.toml. It retrieves the Durable Object for data storage and
   * sends a request to trigger the data synchronisation process in the DO.
   *
   * @param {ScheduledController} controller The Cloudflare scheduled controller.
   * @param {Env} env The environment variables and bindings.
   * @param {ExecutionContext} ctx The execution context for async tasks.
   * @returns {Promise<void>} No direct return value; any errors are caught and logged.
   */
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    try {
      // Identify the DO instance that stores our data
      const id = env.AEMO_DATA.idFromName("AEMO_LOGGER");
      const obj = env.AEMO_DATA.get(id);

      // Trigger the Durable Object to perform the sync process
      await obj.fetch("https://dummy-url/sync", { method: "POST" });
    } catch (err) {
      console.error("AEMO DataLogger scheduled job error: ", err);
    }
  },

  /**
   * Standard fetch handler. This Worker primarily relies on scheduled events
   * for operation. For local dev scheduled testing, run `wrangler dev --test-scheduled`
   * and invoke the /__scheduled route.
   *
   * @param {Request} request The incoming request.
   * @param {Env} env The environment variables and bindings.
   * @param {ExecutionContext} ctx The execution context for asynchronous tasks.
   * @returns {Promise<Response>} A basic response indicating the Worker is live.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response(
      "AEMO DataLogger Worker. Scheduled triggers perform the ingestion.\n",
      { headers: { "content-type": "text/plain" } }
    );
  },
};