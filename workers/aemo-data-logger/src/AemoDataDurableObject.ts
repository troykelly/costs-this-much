/**
 * @fileoverview The Durable Object that stores AEMO intervals in a SQL backend.
 * This implementation now fully retrieves and inserts data from the AEMO API,
 * covering a rolling 36-hour window.
 *
 * - Data is fetched from the AEMO_API_URL, which is expected to return an array
 *   of interval objects containing SETTLEMENTDATE, REGIONID, and RRP.
 * - The data is stored in a table named "intervals", keyed by settlementdate.
 * - Duplicate entries are skipped based on the primary key.
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
export class AemoDataDurableObject {
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
   * Performs the data synchronisation routine for the last 36 hours:
   * 1) Calculates the 36-hour time range from the current time.
   * 2) Fetches data from the AEMO API using the environment variables.
   * 3) Creates and/or ensures the "intervals" table exists.
   * 4) Inserts newly discovered intervals, skipping duplicates.
   * 5) Returns a summary of the operation.
   *
   * @private
   * @returns {Promise<Response>} A response containing the summary of inserted/fetched data.
   */
  private async handleSync(): Promise<Response> {
    try {
      // Establish the time window for data retrieval (last 36 hours).
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 36 * 60 * 60 * 1000);

      // Read environment-based configs for the AEMO API.
      const { AEMO_API_URL, AEMO_API_HEADERS } = this.env;
      const headers: Record<string, string> = AEMO_API_HEADERS
        ? JSON.parse(AEMO_API_HEADERS)
        : {};

      // Construct the API URL with the time range as query parameters (if supported by the API).
      const apiUrl = new URL(AEMO_API_URL);
      apiUrl.searchParams.set("start", startTime.toISOString());
      apiUrl.searchParams.set("end", endTime.toISOString());

      // Fetch the data from AEMO.
      const response = await fetch(apiUrl.toString(), { headers });
      if (!response.ok) {
        throw new Error(`AEMO API responded with status ${response.status}: ${await response.text()}`);
      }

      // Parse the response JSON. Expected to be an array of objects.
      const rawData = await response.json();
      if (!Array.isArray(rawData)) {
        throw new Error("AEMO API did not return the expected JSON array.");
      }

      // Convert the raw data into an internal structure for insertion.
      const intervals: AemoInterval[] = rawData.map((item: any) => {
        return {
          settlementdate: item.SETTLEMENTDATE,
          regionid: item.REGIONID,
          rrp: parseFloat(item.RRP),
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

      // Insert new intervals, skipping duplicates.
      let insertedCount = 0;
      sql.exec("BEGIN TRANSACTION;");
      for (const interval of intervals) {
        try {
          // Attempt a plain INSERT. If a record with the same settlementdate
          // exists, it will trigger a unique constraint error.
          sql.exec(
            `INSERT INTO intervals (settlementdate, regionid, rrp) VALUES (?, ?, ?)`,
            interval.settlementdate,
            interval.regionid,
            interval.rrp
          );
          insertedCount++;
        } catch (e: any) {
          // If the error is due to the unique constraint, ignore. Otherwise, rethrow.
          if (!String(e.message).includes("UNIQUE constraint failed")) {
            throw e;
          }
        }
      }
      sql.exec("COMMIT;");

      // Summarise the operation.
      const message = `Sync completed. Fetched ${intervals.length} intervals, inserted ${insertedCount} new intervals.`;
      console.log(message);
      return new Response(message, { status: 200 });

    } catch (err) {
      console.error("handleSync error:", err);
      return new Response("Sync failed: " + (err as Error).message, { status: 500 });
    }
  }
}