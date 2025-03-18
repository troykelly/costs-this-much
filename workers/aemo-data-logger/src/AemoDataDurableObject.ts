/**
 * @fileoverview Durable Object that stores AEMO intervals in a Cloudflare SQL-based backend.
 *
 * This version aligns with Cloudflare’s documented approach to Durable Object SQL storage:
 *   • Uses "transaction()" from DurableObjectStorage instead of any ad-hoc or synchronous types.
 *   • Strictly types all fields. 
 *   • Checks for availability of "sql" before executing queries.
 *   • Creates/ensures the "intervals" table, then inserts records in a single transaction.
 */

import type {
  DurableObjectState,
  DurableObjectStorage,
  SqlStorage,
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
   * JSON-formatted string of request headers for the AEMO API calls.
   * For example: "{ \"Accept\": \"application/json\" }".
   */
  AEMO_API_HEADERS: string;
}

/**
 * Interface representing the shape of an AEMO data interval record.
 */
export interface AemoInterval {
  /** Settlement date/time for the interval (e.g., "2025-03-18T00:10:00Z"). */
  settlementdate: string;
  /** The region identifier (e.g., "NSW1"). */
  regionid: string;
  /** Regional Reference Price, stored as a float. */
  rrp: number;
}

/**
 * Interface describing rows in the "intervals" table.
 */
export interface IntervalRecord {
  /**
   * The settlement date/time for the record, stored as TEXT, so we allow null
   * if the row is incomplete for any reason.
   */
  settlementdate: string | null;
  /**
   * The region ID for this record, also TEXT in the DB, so may be null.
   */
  regionid: string | null;
  /**
   * The numeric RRP field, stored as NUMERIC in the DB, so may be null.
   */
  rrp: number | null;
}

/**
 * Shape of the AEMO API response for 5-minute intervals.
 */
export interface AemoApiResponse {
  "5MIN": Array<{
    SETTLEMENTDATE: string;
    REGIONID: string;
    RRP: string | number;
  }>;
}

/**
 * Durable Object for AEMO data ingestion and local storage in an internal SQLite table.
 */
export class AemoData {
  private readonly state: DurableObjectState;
  private readonly env: AemoDataEnv;

  /**
   * @param state - DO state object, providing SQL storage and transactions.
   * @param env   - Typed environment bindings for AEMO data (URL, headers, etc.).
   */
  constructor(state: DurableObjectState, env: AemoDataEnv) {
    this.state = state;
    this.env = env;
  }

  /**
   * Standard fetch handler for this DO. Only responds to POST /sync to ingest data.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/sync' && request.method === 'POST') {
      return this.handleSync();
    }
    return new Response("Not found", { status: 404 });
  }

  /**
   * Sync ingestion routine:
   * 1) POST { timeScale: ["5MIN"] } to AEMO_API_URL.
   * 2) Parse expected data from the "5MIN" property of response.
   * 3) CREATE TABLE IF NOT EXISTS intervals(...) if needed.
   * 4) INSERT OR IGNORE intervals to avoid duplicates.
   * 5) Return a summary message about how many intervals were inserted.
   *
   * Uses the documented "transaction" approach from Cloudflare for SQL statements.
   */
  private async handleSync(): Promise<Response> {
    try {
      // Check that the "sql" property is available
      const sql: SqlStorage | undefined = this.state.storage.sql;
      if (!sql) {
        console.error("SQL storage not available. Check DO configuration/migrations.");
        return new Response("Sync failed: SQL storage not bound.", { status: 500 });
      }

      // Prepare the outbound request
      const { AEMO_API_URL, AEMO_API_HEADERS } = this.env;
      const parsedHeaders: Record<string, string> =
        AEMO_API_HEADERS.trim() ? JSON.parse(AEMO_API_HEADERS) : {};
      const requestBody = { timeScale: ['5MIN'] };

      const response = await fetch(AEMO_API_URL, {
        method: 'POST',
        headers: {
          ...parsedHeaders,
          'content-type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) {
        const errText = await response.text();
        console.error(`AEMO API error ${response.status}: ${errText}`);
        return new Response(`Sync failed: AEMO API ${response.status} - ${errText}`, { status: 500 });
      }

      // Parse the response JSON for 5MIN array
      const apiJson = (await response.json()) as AemoApiResponse;
      const rawData = apiJson["5MIN"];
      if (!Array.isArray(rawData)) {
        console.error("Response missing '5MIN' array property.");
        return new Response("Sync failed: '5MIN' field is invalid or missing.", { status: 500 });
      }

      // Convert the raw data to typed intervals
      const intervals: AemoInterval[] = rawData.map((item) => ({
        settlementdate: item.SETTLEMENTDATE,
        regionid: item.REGIONID,
        rrp: parseFloat(String(item.RRP)),
      }));

      // Create or ensure the table
      sql.exec(`
        CREATE TABLE IF NOT EXISTS intervals (
          settlementdate TEXT PRIMARY KEY,
          regionid TEXT,
          rrp NUMERIC
        );
      `);

      let insertedCount = 0;

      // Run an async transaction to batch inserts using INSERT OR IGNORE
      await this.state.storage.transaction(async (txnStorage: DurableObjectStorage) => {
        // Each statement is run through txnStorage.sql
        const txnSql = txnStorage.sql;
        if (!txnSql) {
          console.error("SQL not available inside transaction callback.");
          return;
        }
        for (const interval of intervals) {
          const cursor = txnSql.exec<IntervalRecord>(
            `INSERT OR IGNORE INTO intervals (settlementdate, regionid, rrp) VALUES (?, ?, ?)`,
            interval.settlementdate,
            interval.regionid,
            interval.rrp,
          );
          insertedCount += cursor.rowsWritten;
        }
      });

      const summary = `Sync successful: retrieved ${intervals.length} intervals; inserted ${insertedCount} new.`;
      console.log(summary);
      return new Response(summary, { status: 200 });

    } catch (err) {
      console.error("Sync error:", err);
      return new Response(
        "Sync failed: " + (err as Error).message,
        { status: 500 },
      );
    }
  }
}