/**
 * @fileoverview Durable Object that stores AEMO intervals in a Cloudflare SQL-based backend.
 *
 * This updated version follows the new Cloudflare Durable Object + SQL model and adds
 * an environment-based debugging mechanism. If LOG_LEVEL is set to "INFO" or "DEBUG",
 * the DO will log what it's doing (retrieving data, which records are being processed,
 * etc.).
 */

import type {
  DurableObjectState,
  DurableObject,
  SqlStorage,
  SqlStorageValue
} from '@cloudflare/workers-types';

/** Possible log levels in ascending severity order. */
type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'NONE';

/** Returns a numeric priority for each log level (lower = more verbose). */
function getLogPriority(level: string): number {
  switch (level.toUpperCase()) {
    case 'DEBUG': return 1;
    case 'INFO':  return 2;
    case 'WARN':  return 3;
    case 'ERROR': return 4;
    default:      return 99;  // Means 'NONE' or unknown
  }
}

/** Environment bindings declared in wrangler.*.toml for a SQLite DO. */
export interface AemoDataEnv {
  AEMO_API_URL: string;      // e.g. "https://visualisations.aemo.com.au/aemo/apps/api/report/5MIN"
  AEMO_API_HEADERS: string;  // JSON string of headers, e.g. '{"Accept":"application/json"}'
  LOG_LEVEL?: string;        // If set to "DEBUG" or "INFO", logs more details about the process
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
 * This Durable Object fetches AEMO data and stores it in a SQLite table named "intervals".
 * When LOG_LEVEL is set to "INFO" or "DEBUG", it logs details about its work.
 */
export class AemoData implements DurableObject {
  private readonly sql: SqlStorage;
  private readonly logLevel: number;   // numeric priority derived from LOG_LEVEL
  private readonly env: AemoDataEnv;

  /**
   * Constructs the DO, assigning Cloudflare’s SQL storage to "this.sql" and
   * immediately creating the table if it doesn’t exist. Reads LOG_LEVEL from
   * the environment to control debugging verbosity.
   */
  constructor(private readonly state: DurableObjectState, env: AemoDataEnv) {
    // “sql” must be bound if wrangler.*.toml and migrations are configured for SQLite.
    this.sql = state.storage.sql;
    this.env = env;
    // Default to WARN if LOG_LEVEL is unset or unrecognised
    const configuredLevel = env.LOG_LEVEL ?? 'WARN';
    this.logLevel = getLogPriority(configuredLevel);

    // Create (or no-op if it already exists) an "intervals" table.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS intervals (
        settlementdate TEXT PRIMARY KEY,
        regionid TEXT,
        rrp NUMERIC
      );
    `);

    this.log('INFO', `AemoData DO constructed with LOG_LEVEL="${configuredLevel}".`);
  }

  /**
   * The DO responds to POST /sync by fetching data from AEMO, then storing intervals in the table.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/sync') {
      return this.handleSync();
    }
    return new Response('Not Found', { status: 404 });
  }

  /**
   * Fetches data from the configured API, parses it, then inserts intervals
   * using INSERT OR IGNORE to skip duplicates. Logs intermediate steps if
   * LOG_LEVEL is "INFO" or more verbose.
   */
  private async handleSync(): Promise<Response> {
    this.log('INFO', 'Beginning data sync from AEMO...');

    const requestBody = { timeScale: ['5MIN'] };
    const headers = this.parseHeaders(this.env.AEMO_API_HEADERS);

    this.log('DEBUG', `Posting to AEMO URL: ${this.env.AEMO_API_URL}`);
    this.log('DEBUG', `Request headers: ${JSON.stringify(headers)}`);
    this.log('DEBUG', `Request body: ${JSON.stringify(requestBody)}`);

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
      this.log('ERROR', `AEMO API error ${resp.status}: ${err}`);
      return new Response(`AEMO API error ${resp.status}: ${err}`, { status: 500 });
    }

    const data: AemoApiResponse = await resp.json();
    if (!Array.isArray(data["5MIN"])) {
      this.log('ERROR', `Invalid or missing "5MIN" array in the AEMO response.`);
      return new Response(`Invalid or missing "5MIN" array in AEMO response.`, { status: 500 });
    }

    const intervals: AemoInterval[] = data["5MIN"].map(item => ({
      settlementdate: item.SETTLEMENTDATE,
      regionid: item.REGIONID,
      rrp: parseFloat(String(item.RRP)),
    }));

    this.log('INFO', `Retrieved ${intervals.length} intervals from AEMO. Inserting...`);

    let insertedCount = 0;
    for (const interval of intervals) {
      // If log level is DEBUG, log each record being inserted
      this.log('DEBUG', `Inserting interval: settlementdate=${interval.settlementdate}, regionid=${interval.regionid}, rrp=${interval.rrp}`);

      const cursor = this.sql.exec<IntervalRecord>(
        `INSERT OR IGNORE INTO intervals (settlementdate, regionid, rrp) VALUES (?, ?, ?)`,
        interval.settlementdate,
        interval.regionid,
        interval.rrp
      );
      insertedCount += cursor.rowsWritten;
    }

    const msg = `Sync complete. Received ${intervals.length} intervals; inserted ${insertedCount} new.`;
    this.log('INFO', msg);
    return new Response(msg, { status: 200 });
  }

  /**
   * If AEMO_API_HEADERS is invalid JSON or empty, just return an empty object.
   */
  private parseHeaders(raw: string): Record<string, string> {
    try {
      return raw && raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  /**
   * Logs a message if the given level is at or above the configured log level.
   */
  private log(level: LogLevel, message: string): void {
    if (getLogPriority(level) >= this.logLevel) {
      console.log(`[${level}] ${message}`);
    }
  }
}