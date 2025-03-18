/**
 * @fileoverview The Durable Object that stores AEMO intervals in a SQL backend.
 * This implementation was updated to match the existing frontend’s POST approach,
 * sending { timeScale: ['5MIN'] } in the request payload, rather than using a time window.
 *
 * - Data is fetched from the AEMO_API_URL by POST with body { "timeScale": ["5MIN"] },
 *   as done in the frontend code.  
 * - The data is expected to be returned in an object with a "5MIN" property containing
 *   an array of intervals (SETTLEMENTDATE, REGIONID, RRP).
 * - The intervals table remains as before (“intervals”), keyed by settlementdate.
 * - Duplicate entries are skipped via an INSERT OR IGNORE approach.
 * - Failures to fetch or parse the data are now logged and handled (500 response),
 *   rather than resulting in an unhandled exception.
 */

import type { DurableObjectState } from '@cloudflare/workers-types';

/**
 * Interface representing the structure of each AEMO data interval record.
 */
interface AemoInterval {
  settlementdate: string;
  regionid: string;
  rrp: number;
}

/**
 * Durable Object class that manages storage of AEMO data in a Cloudflare
 * SQL-based database.
 */
export class AemoData {
  /** Reference to this Durable Object's persistent state. */
  state: DurableObjectState;

  /**
   * Environment bindings (e.g. AEMO_API_URL, AEMO_API_HEADERS, etc.)
   * This is typed as 'any' here because Cloudflare passes environment variables
   * dynamically. In practice, you can define a stronger type for these if desired.
   */
  env: any;

  /**
   * Constructs the AemoDataDurableObject.
   * @param {DurableObjectState} state The Durable Object state for storage and transactions.
   * @param {any} env Environment bindings, including AEMO_API_URL and AEMO_API_HEADERS.
   */
  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
  }

  /**
   * Handles HTTP fetch events sent to this Durable Object. For this particular
   * DO, the '/sync' endpoint with POST is used to perform the ingestion routine.
   *
   * @param {Request} request The incoming request object.
   * @returns {Promise<Response>} The response indicating success or failure.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/sync' && request.method === 'POST') {
      return await this.handleSync();
    }
    return new Response("Not found", { status: 404 });
  }

  /**
   * Performs the data synchronisation routine:
   * 1) Posts to AEMO_API_URL with { timeScale: ['5MIN'] } in JSON body.
   * 2) Expects a JSON object with a "5MIN" property containing an array of intervals.
   * 3) Creates/ensures the "intervals" table.
   * 4) Inserts new intervals with INSERT OR IGNORE to skip duplicates.
   * 5) Returns a summary of the operation.
   *
   * @private
   * @returns {Promise<Response>} A response containing the summary of inserted/fetched data.
   */
  private async handleSync(): Promise<Response> {
    try {
      // Retrieve AEMO_API_URL and AEMO_API_HEADERS from environment
      const { AEMO_API_URL, AEMO_API_HEADERS } = this.env;
      const headers: Record<string, string> = AEMO_API_HEADERS
        ? JSON.parse(AEMO_API_HEADERS)
        : {};

      // We now POST to the AEMO API with the same payload as the frontend
      const requestBody = { timeScale: ['5MIN'] };
      const response = await fetch(AEMO_API_URL, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`AEMO API responded with error ${response.status}: ${errorText}`);
        return new Response(
          `Sync failed: AEMO API error ${response.status} - ${errorText}`,
          { status: 500 }
        );
      }

      // Parse the response JSON, expecting data["5MIN"] as an array
      const rawJson = await response.json();
      const rawData = rawJson['5MIN'];
      if (!Array.isArray(rawData)) {
        console.error('Response JSON missing expected "5MIN" array property.');
        return new Response(
          'Sync failed: "5MIN" property not found or invalid in AEMO response.',
          { status: 500 }
        );
      }

      // Convert the raw data to our internal structure
      const intervals: AemoInterval[] = rawData.map((item: any) => {
        return {
          settlementdate: item.SETTLEMENTDATE,
          regionid: item.REGIONID,
          rrp: parseFloat(item.RRP)
        };
      });

      // Prepare our SQL instance for creating and inserting data.
      const sql = this.state.storage.sql;

      // Ensure the "intervals" table exists.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS intervals (
          settlementdate TEXT PRIMARY KEY,
          regionid TEXT,
          rrp NUMERIC
        );
      `);

      // Insert new intervals via INSERT OR IGNORE to avoid duplicates.
      let insertedCount = 0;
      this.state.storage.transactionSync((txn) => {
        const tsql = txn.sql;
        for (const interval of intervals) {
          const cursor = tsql.exec(
            `INSERT OR IGNORE INTO intervals (settlementdate, regionid, rrp) VALUES (?, ?, ?)`,
            interval.settlementdate,
            interval.regionid,
            interval.rrp
          );
          insertedCount += cursor.rowsWritten;
        }
      });

      const message = `Sync completed. Received ${intervals.length} intervals, inserted ${insertedCount} new intervals.`;
      console.log(message);
      return new Response(message, { status: 200 });

    } catch (err) {
      console.error("handleSync error:", err);
      return new Response("Sync failed: " + (err as Error).message, { status: 500 });
    }
  }
}