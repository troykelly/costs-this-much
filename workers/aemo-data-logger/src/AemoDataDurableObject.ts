/**
 * @fileoverview The Durable Object that stores AEMO intervals in a SQL backend.
 * This implementation was updated to ensure complete TypeScript typing of every
 * object and variable (removing all inferred or untyped references).
 *
 * Data is fetched from the AEMO_API_URL by POST with body { "timeScale": ["5MIN"] },
 * as done in the frontend code. The data is expected to be returned in an object
 * with a "5MIN" property (an array), each containing: SETTLEMENTDATE, REGIONID, RRP.
 * The intervals table remains as before ("intervals"), keyed by settlementdate.
 * Duplicate entries are skipped using an INSERT OR IGNORE approach. Failures
 * are logged and returned as HTTP 500 instead of crashing.
 */

import {
  DurableObjectState,
  KVTransaction,
  SqlStorage,
} from '@cloudflare/workers-types';

/**
 * Environment variables used by the AemoData Durable Object.
 */
export interface AemoDataEnv {
  /**
   * The URI for the AEMO API endpoint. The DO will POST to this URL
   * with { timeScale: ['5MIN'] } as the request body.
   */
  AEMO_API_URL: string;

  /**
   * JSON-formatted string representing header key-value pairs for
   * the AEMO API request. For example: "{ \"Accept\": \"application/json\" }".
   */
  AEMO_API_HEADERS: string;
}

/**
 * Interface representing the structure of each AEMO data interval record.
 */
export interface AemoInterval {
  /**
   * The settlement date/time in a string representation,
   * used as a primary key in the DB (e.g., "2025-03-18T00:05:00Z").
   */
  settlementdate: string;

  /**
   * The region identifier for the interval (e.g., "NSW1").
   */
  regionid: string;

  /**
   * The numeric RRP (Regional Reference Price) indicator.
   */
  rrp: number;
}

/**
 * Interface for the rows stored in the "intervals" table.
 * The columns must match the schema used in our CREATE TABLE statement.
 */
export interface IntervalRecord {
  /**
   * The primary key for each row, representing settlement date/time.
   * In the database, this is stored as TEXT, so we allow for null
   * in typed results (e.g., if a row was partial).
   */
  settlementdate: string | null;

  /**
   * The region ID for the row, stored as TEXT in the DB, so we allow null.
   */
  regionid: string | null;

  /**
   * The RRP field, stored as NUMERIC in the DB, so we allow null.
   */
  rrp: number | null;
}

/**
 * Represents the transaction object used within `transactionSync` calls,
 * containing the standard KVTransaction plus an additional `sql` property
 * for executing SQL queries.
 */
export interface SqlTransaction extends KVTransaction {
  /**
   * The SQL storage interface for issuing exec calls or iterating results.
   */
  sql: SqlStorage;
}

/**
 * Interface representing the shape of an AEMO API response for 5-minute intervals.
 */
export interface AemoApiResponse {
  /**
   * An array of objects describing each interval returned by the AEMO API,
   * keyed by "5MIN".
   */
  "5MIN": Array<{
    SETTLEMENTDATE: string;
    REGIONID: string;
    RRP: string | number;
  }>;
}

/**
 * Durable Object class that manages storage of AEMO data in a Cloudflare
 * SQL-based database.
 */
export class AemoData {
  /**
   * Reference to this Durable Object's persistent state.
   */
  private readonly state: DurableObjectState;

  /**
   * Environment bindings (e.g., AEMO_API_URL, AEMO_API_HEADERS, etc.),
   * typed to eliminate untyped references.
   */
  private readonly env: AemoDataEnv;

  /**
   * Constructs the AemoDataDurableObject.
   *
   * @param {DurableObjectState} state The DO state for storage and transactions.
   * @param {AemoDataEnv} env The typed environment bindings including AEMO details.
   */
  constructor(state: DurableObjectState, env: AemoDataEnv) {
    this.state = state;
    this.env = env;
  }

  /**
   * Handles HTTP fetch events sent to this Durable Object. For this DO, the
   * '/sync' endpoint with POST is used to perform the ingestion routine.
   *
   * @param {Request} request The incoming request object.
   * @returns {Promise<Response>} An HTTP response describing success or failure.
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
   * 3) Creates/ensures the "intervals" table if it doesn't already exist.
   * 4) Inserts new intervals using INSERT OR IGNORE to skip duplicates.
   * 5) Returns a summary of the operation via an HTTP Response.
   *
   * @private
   * @returns {Promise<Response>} A response indicating how many intervals were inserted.
   */
  private async handleSync(): Promise<Response> {
    try {
      // Check that the DO storage SQL feature is available
      const sql: SqlStorage | undefined = (this.state.storage as unknown as { sql?: SqlStorage }).sql;
      if (!sql) {
        console.error("SQL storage is not enabled or not bound. Check wrangler config/migrations.");
        return new Response("Sync failed: SQL storage not available in this environment.", { status: 500 });
      }

      // Retrieve environment variables with typed references
      const { AEMO_API_URL, AEMO_API_HEADERS } = this.env;
      const headers: Record<string, string> =
        AEMO_API_HEADERS.trim() ? JSON.parse(AEMO_API_HEADERS) as Record<string, string> : {};

      // We POST to the AEMO API with the same payload used by the frontend
      const requestBody = { timeScale: ['5MIN'] };
      const response = await fetch(AEMO_API_URL, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      // Check for a non-OK response
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`AEMO API responded with error ${response.status}: ${errorText}`);
        return new Response(
          `Sync failed: AEMO API error ${response.status} - ${errorText}`,
          { status: 500 },
        );
      }

      // Parse the response JSON as the expected AemoApiResponse shape
      const rawJson = await response.json() as AemoApiResponse;
      const rawData = rawJson['5MIN'];
      if (!Array.isArray(rawData)) {
        console.error('Response JSON missing expected "5MIN" array property.');
        return new Response(
          'Sync failed: "5MIN" property not found or invalid in AEMO response.',
          { status: 500 },
        );
      }

      // Convert to our internal structure with typed fields
      const intervals: AemoInterval[] = rawData.map((item) => ({
        settlementdate: item.SETTLEMENTDATE,
        regionid: item.REGIONID,
        rrp: parseFloat(String(item.RRP)),
      }));

      // Ensure the "intervals" table exists
      sql.exec(`
        CREATE TABLE IF NOT EXISTS intervals (
          settlementdate TEXT PRIMARY KEY,
          regionid TEXT,
          rrp NUMERIC
        );
      `);

      // Insert new intervals using INSERT OR IGNORE to avoid duplicates
      let insertedCount = 0;

      this.state.storage.transactionSync((txn: SqlTransaction) => {
        const tsql = txn.sql;
        for (const interval of intervals) {
          const cursor = tsql.exec<IntervalRecord>(
            `INSERT OR IGNORE INTO intervals (settlementdate, regionid, rrp) VALUES (?, ?, ?)`,
            interval.settlementdate,
            interval.regionid,
            interval.rrp,
          );
          insertedCount += cursor.rowsWritten;
        }
      });

      const message = `Sync completed. Received ${intervals.length} intervals; inserted ${insertedCount} new intervals.`;
      console.log(message);
      return new Response(message, { status: 200 });

    } catch (err) {
      console.error("handleSync error:", err);
      return new Response("Sync failed: " + (err as Error).message, { status: 500 });
    }
  }
}