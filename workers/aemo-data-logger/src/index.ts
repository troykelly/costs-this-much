/**
 * @fileoverview Cloudflare Worker entry point for the AEMO Data Logger.
 * Schedules every 5 minutes offset by 1 minute, fetches missing intervals from
 * AEMO, and stores them in a SQL-based Durable Object. This is the primary
 * orchestration script for data ingestion.
 *
 * Usage:
 *  - Invoked automatically via schedule triggers.
 *  - For local testing of scheduled behavior, run `wrangler dev --test-scheduled`
 *    and then invoke the endpoint at /__scheduled?cron=*+*+*+*+* (or a custom cron pattern).
 */

export { AemoData } from './AemoDataDurableObject';

/**
 * Env interface defining the required environment bindings.
 * @property {DurableObjectNamespace} AEMO_DATA The Durable Object namespace for storing AEMO data.
 * @property {string} AEMO_API_URL The API endpoint for fetching data from AEMO.
 * @property {string} AEMO_API_HEADERS A JSON-formatted string representing header key-value pairs.
 */
interface Env {
  AEMO_DATA: DurableObjectNamespace;
  AEMO_API_URL: string;
  AEMO_API_HEADERS: string;
}

export default {
  /**
   * Scheduled handler that runs automatically based on the cron settings provided
   * in wrangler.logger.toml. It retrieves the Durable Object for data storage and
   * sends a request to trigger the data synchronisation process.
   *
   * @param {ScheduledController} controller The Cloudflare scheduled controller.
   * @param {Env} env The environment variables and bindings.
   * @param {ExecutionContext} ctx The execution context for asynchronous tasks.
   * @returns {Promise<void>} No direct return value; any errors are caught and logged.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      // Identify the DO instance that stores our data.
      const id = env.AEMO_DATA.idFromName("AEMO_LOGGER");
      const obj = env.AEMO_DATA.get(id);

      // Trigger the Durable Object to perform the sync process.
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