/**
 * @fileoverview The Cloudflare Worker entry point for the AEMO data-logging mode.
 * It automatically runs on a schedule (5-minute intervals) and invokes the Durable
 * Object to fetch and store fresh intervals. Fully typed with no untyped references.
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
   * API URL for AEMO; used here if needed, but primarily
   * taken from within the DO environment as well.
   */
  AEMO_API_URL: string;

  /**
   * JSON string of headers to add to AEMO API fetch calls.
   */
  AEMO_API_HEADERS: string;
}

// Make the DO class discoverable by Cloudflare
export { AemoData } from './AemoDataDurableObject';

export default {
  /**
   * Handles scheduled cron triggers. This function identifies the
   * DO instance by name and invokes /sync on it via a POST request.
   *
   * @param {ScheduledController} controller - The scheduler context.
   * @param {Env} env - The typed environment containing the DO namespace.
   * @param {ExecutionContext} ctx - The Cloudflare execution context.
   */
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    try {
      const id = env.AEMO_DATA.idFromName("AEMO_LOGGER");
      const objStub = env.AEMO_DATA.get(id);

      // Send a POST request to /sync in the DO
      await objStub.fetch("https://dummy-url/sync", { method: "POST" });
    } catch (err) {
      console.error("Scheduled job error in the data logger:", err);
    }
  },

  /**
   * Minimal fetch handler. For local testing with cron triggers,
   * run wrangler dev --test-scheduled and possibly hit /__scheduled as needed.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response(
      "AEMO data logger worker is active. In production, it runs on a schedule.\n",
      { headers: { "content-type": "text/plain" } }
    );
  },
};