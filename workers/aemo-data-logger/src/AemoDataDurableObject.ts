/**
 * @fileoverview Durable Object that stores AEMO intervals in a Cloudflare SQL-based backend.
 * This implementation follows the newest Cloudflare documentation for Durable Object + SQL:
 *  - In the constructor, "this.sql" is directly assigned from "state.storage.sql".
 *  - The table is created on construction or first usage (no disclaimers about missing bindings).
 *  - The "exec<T>" method requires T to extend "Record<string, SqlStorageValue>".
 *
 * Adjust the details (table schema, environment fields) as needed for your real usage.
 */

import type {
  SqlStorage,
  SqlStorageValue,
  DurableObjectState,
  DurableObject,
} from '@cloudflare/workers-types';

/** Environment bindings declared in wrangler.*.toml, pointing to a SQLite DO. */
export interface AemoDataEnv {
  AEMO_API_URL: string;
  AEMO_API_HEADERS: string;
}

/**
 * Row type for each interval in the "intervals" table.
 * Must extend Record<string, SqlStorageValue> to satisfy "exec<T>()".
 */
export interface IntervalRecord extends Record<string, SqlStorageValue> {
  settlementdate: string | null;
  regionid: string | null;
  rrp: number | null;
}

/** Single 5-minute interval from the AEMO API. */
export interface AemoInterval {
  settlementdate: string;  // e.g. "2025-03-18T00:10:00Z"
  regionid: string;        // e.g. "NSW1"
  rrp: number;             // numeric RRP
}

/** Shape of the AEMO 5-minute data JSON response. */
export interface AemoApiResponse {
  "5MIN": {
    SETTLEMENTDATE: string;
    REGIONID: string;
    RRP: string | number;
  }[];
}

/**
 * The Durable Object that ingests AEMO data and stores it in a SQLite table.
 */
export class AemoData implements DurableObject {
  private readonly sql: SqlStorage;
  private readonly env: AemoDataEnv;

  /**
   * Constructs the DO, assigning Cloudflare’s SQL storage to "this.sql".
   * Immediately creates the "intervals" table if it doesn’t exist.
   */
  constructor(private readonly state: DurableObjectState, env: AemoDataEnv) {
    // “sql” is guaranteed if your wrangler.*.toml is configured/migrated for SQLite.
    this.sql = state.storage.sql;
    this.env = env;

    // Create (or no-op if exists) an "intervals" table.
    // We can do this once in the constructor to ensure it's ready.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS intervals (
        settlementdate TEXT PRIMARY KEY,
        regionid TEXT,
        rrp NUMERIC
      );
    `);
  }

  /**
   * The DO responds to POST /sync by:
   * 1) Fetching data from AEMO_API_URL with a body of { timeScale: ["5MIN"] }.
   * 2) Parsing the "5MIN" array.
   * 3) Inserting intervals using INSERT OR IGNORE to skip duplicates.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/sync') {
      return this.handleSync();
    }
    return new Response('Not Found', { status: 404 });
  }

  /**
   * Makes a POST to AEMO_API_URL, converts response to typed intervals,
   * then inserts them into the table, ignoring duplicates.
   */
  private async handleSync(): Promise<Response> {
    // Prepare the fetch
    const requestBody = { timeScale: ['5MIN'] };
    const headers = this.parseHeaders(this.env.AEMO_API_HEADERS);
    const resp = await fetch(this.env.AEMO_API_URL, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!resp.ok) {
      const err = await resp.text();
      return new Response(`AEMO API error ${resp.status}: ${err}`, { status: 500 });
    }

    const data: AemoApiResponse = await resp.json();
    if (!Array.isArray(data["5MIN"])) {
      return new Response(`Invalid or missing "5MIN" array in response.`, { status: 500 });
    }

    // Convert each item to a typed interval
    const intervals: AemoInterval[] = data["5MIN"].map(item => ({
      settlementdate: item.SETTLEMENTDATE,
      regionid: item.REGIONID,
      rrp: parseFloat(String(item.RRP)),
    }));

    let insertedCount = 0;
    // Insert intervals in a loop. Each "exec" returns "rowsWritten", which increments on unique records.
    for (const interval of intervals) {
      const cursor = this.sql.exec<IntervalRecord>(
        `INSERT OR IGNORE INTO intervals (settlementdate, regionid, rrp) VALUES (?, ?, ?)`,
        interval.settlementdate,
        interval.regionid,
        interval.rrp,
      );
      insertedCount += cursor.rowsWritten;
    }

    return new Response(
      `Synced ${intervals.length} intervals, inserted ${insertedCount} new.`,
      { status: 200 }
    );
  }

  /**
   * Safely parse JSON headers or return an empty object if invalid.
   */
  private parseHeaders(raw: string): Record<string, string> {
    try {
      return raw && raw.trim() ? JSON.parse(raw) as Record<string, string> : {};
    } catch {
      // If it's malformed, just return empty so the fetch isn't blocked
      return {};
    }
  }
}