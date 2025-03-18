/**
 * @fileoverview Cloudflare Worker entry point for the AEMO Data Logger.
 * Schedules every 5 minutes offset by 1 minute, fetches missing intervals from
 * AEMO, and stores them in a SQL-based Durable Object. This is the primary
 * orchestration script for data ingestion.
 *
 * Usage:
 *  - Invoked automatically via schedule triggers.
 *  - The scheduled handler calls the associated Durable Object to perform
 *    the actual data fetch and insert operations.
 */

export { AemoData } from './AemoDataDurableObject';

/**
 * Env interface defining the required environment bindings.
 * @property {DurableObjectNamespace} AemoData The Durable Object namespace for storing AEMO data.
 * @property {string} AEMO_API_URL The API endpoint for fetching data from AEMO.
 * @property {string} AEMO_API_HEADERS A JSON-formatted string representing header key-value pairs.
 */
interface Env {
  AemoData: DurableObjectNamespace;
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
      const id = env.AemoData.idFromName("AEMO_LOGGER");
      const obj = env.AemoData.get(id);

      // Trigger the Durable Object to perform the sync process.
      await obj.fetch("https://dummy-url/sync", { method: "POST" });
    } catch (err) {
      console.error("AEMO DataLogger scheduled job error: ", err);
    }
  },

  /**
   * Standard fetch handler. This Worker primarily relies on scheduled events
   * for operation. The fetch handler can still serve requests for manual testing
   * or debugging if desired.
   *
   * @param {Request} request The incoming request.
   * @param {Env} env The environment variables and bindings.
   * @param {ExecutionContext} ctx The execution context for asynchronous tasks.
   * @returns {Promise<Response>} A basic response indicating the Worker is live or triggers manual sync.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Allow manual triggering of the sync in local dev.
    if (url.pathname === '/trigger' && request.method === 'POST') {
      try {
        const id = env.AemoData.idFromName("AEMO_LOGGER");
        const obj = env.AemoData.get(id);
        await obj.fetch("https://dummy-url/sync", { method: "POST" });
        return new Response("Local data sync triggered successfully.\n", { status: 200 });
      } catch (err) {
        console.error("Local dev trigger error:", err);
        return new Response("Local dev trigger failed.\n", { status: 500 });
      }
    }

    return new Response(
      "AEMO DataLogger Worker. Use schedule triggers for normal operation.\n",
      { headers: { "content-type": "text/plain" } }
    );
  },
};