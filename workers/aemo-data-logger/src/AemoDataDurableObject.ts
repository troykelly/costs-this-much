/**
 * @fileoverview Durable Object that stores AEMO intervals in a Cloudflare SQL-based backend.
 *
 * This version avoids the “argument of type '(txnStorage: DurableObjectStorage) => Promise<void>'
 * not assignable to parameter of type '(txn: DurableObjectTransaction) => Promise<void>'” error
 * by explicitly using DurableObjectTransaction in the transaction callback, then casting to access
 * the optional sql property. It also fixes the “Type 'IntervalRecord' does not satisfy the constraint
 * 'Record<string, SqlStorageValue>'” error by defining an index signature that allows for string,
 * number, ArrayBuffer, or null column values (the recognized SqlStorageValue set).
 */

import type {
  DurableObjectState,
  DurableObjectTransaction,
  SqlStorage,
  SqlStorageValue,
} from '@cloudflare/workers-types';

/**
 * Environment variables used by the AemoData Durable Object.
 */
export interface AemoDataEnv {
  /**
   * AEMO API endpoint for 5-minute data. The DO issues a POST request here with
   * a body of { timeScale: ["5MIN"] }.
   */
  AEMO_API_URL: string;

  /**
   * JSON-formatted string of headers for the AEMO API request.
   * For example: "{ \"Accept\": \"application/json\" }".
   */
  AEMO_API_HEADERS: string;
}

/**
 * Interface representing the shape of a single 5-minute AEMO data interval.
 */
export interface AemoInterval {
  /** Settlement date/time for the interval (e.g. "2025-03-18T00:10:00Z"). */
  settlementdate: string;
  /** The region identifier (e.g. "NSW1"). */
  regionid: string;
  /** Regional Reference Price, stored as a float. */
  rrp: number;
}

/**
 * Because Cloudflare’s `exec<T>()` requires `T` to extend `Record<string, SqlStorageValue>`,
 * we define the following row type with an index signature. This ensures it satisfies that
 * constraint (meaning each column is string | number | ArrayBuffer | null), while also
 * including our typed columns (settlementdate, regionid, rrp).
 */
export interface IntervalRecord extends Record<string, SqlStorageValue> {
  settlementdate: string | null;
  regionid: string | null;
  rrp: number | null;
}

/**
 * Shape of the JSON returned by the AEMO API for 5-minute intervals.
 */
export interface AemoApiResponse {
  "5MIN": Array<{
    SETTLEMENTDATE: string;
    REGIONID: string;
    RRP: string | number;
  }>;
}

/**
 * Durable Object for AEMO data ingestion and storage in an internal SQLite table.
 */
export class AemoData {
  private readonly state: DurableObjectState;
  private readonly env: AemoDataEnv;

  /**
   * @param {DurableObjectState} state - DO state object.
   * @param {AemoDataEnv} env - The typed environment bindings for AEMO data.
   */
  constructor(state: DurableObjectState, env: AemoDataEnv) {
    this.state = state;
    this.env = env;
  }

  /**
   * Handles incoming fetch events to this DO. Only supports POST /sync to perform ingestion.
   *
   * @param {Request} request - The incoming request.
   * @returns {Promise<Response>} - HTTP response for success/failure.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/sync' && request.method === 'POST') {
      return await this.handleSync();
    }

    return new Response("Not found", { status: 404 });
  }

  /**
   * Sync routine:
   * 1) POST { timeScale: ["5MIN"] } to AEMO_API_URL.
   * 2) Parse expected data from the "5MIN" property in the response.
   * 3) CREATE TABLE IF NOT EXISTS intervals (...).
   * 4) INSERT OR IGNORE intervals to avoid duplicates.
   * 5) Return summary message of how many intervals were inserted.
   *
   * Uses an asynchronous transaction on the Durable Object’s storage.
   */
  private async handleSync(): Promise<Response> {
    try {
      // Check if the DO has SQL bound
      const sql: SqlStorage | undefined = this.state.storage.sql;
      if (!sql) {
        console.error("SQL storage not available. Check your DO config/migrations.");
        return new Response("Sync failed: SQL storage is not enabled for this Durable Object.", {
          status: 500,
        });
      }

      const { AEMO_API_URL, AEMO_API_HEADERS } = this.env;
      const headers: Record<string, string> = AEMO_API_HEADERS
        ? JSON.parse(AEMO_API_HEADERS.trim())
        : {};

      // Prepare the request body for AEMO
      const requestBody = { timeScale: ['5MIN'] };
      const fetchResponse = await fetch(AEMO_API_URL, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      // Check for a non-OK response
      if (!fetchResponse.ok) {
        const errorText = await fetchResponse.text();
        console.error(`AEMO API error ${fetchResponse.status}: ${errorText}`);
        return new Response(`Sync failed: AEMO API responded ${fetchResponse.status} - ${errorText}`, {
          status: 500,
        });
      }

      // Parse the response JSON
      const rawJson = (await fetchResponse.json()) as AemoApiResponse;
      const dataArray = rawJson["5MIN"];
      if (!Array.isArray(dataArray)) {
        console.error('Response JSON missing the "5MIN" array.');
        return new Response('Sync failed: No valid "5MIN" array in AEMO response.', { status: 500 });
      }

      // Convert incoming data to typed intervals
      const intervals: AemoInterval[] = dataArray.map((item) => ({
        settlementdate: item.SETTLEMENTDATE,
        regionid: item.REGIONID,
        rrp: parseFloat(String(item.RRP)),
      }));

      // Ensure table exists (outside the transaction is fine)
      sql.exec(`
        CREATE TABLE IF NOT EXISTS intervals (
          settlementdate TEXT PRIMARY KEY,
          regionid TEXT,
          rrp NUMERIC
        );
      `);

      let insertedCount = 0;

      // Perform an asynchronous transaction to insert intervals
      await this.state.storage.transaction(
        async (txn: DurableObjectTransaction): Promise<void> => {
          // In transaction callbacks, we must cast 'txn' to find 'sql' if available
          const txnSql = (txn as unknown as { sql?: SqlStorage }).sql;
          if (!txnSql) {
            // Possibly misconfigured environment or missing migration for SQLite
            console.error("Transaction object does not have SQL bindings.");
            return;
          }

          for (const interval of intervals) {
            const cursor = txnSql.exec<IntervalRecord>(
              `INSERT OR IGNORE INTO intervals (settlementdate, regionid, rrp) VALUES (?, ?, ?)`,
              interval.settlementdate,
              interval.regionid,
              interval.rrp
            );
            insertedCount += cursor.rowsWritten;
          }
        }
      );

      const message = `Sync complete. Fetched ${intervals.length} intervals; inserted ${insertedCount} new.`;
      console.log(message);
      return new Response(message, { status: 200 });

    } catch (err) {
      console.error("Error during handleSync:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      return new Response("Sync failed: " + errorMessage, { status: 500 });
    }
  }
}