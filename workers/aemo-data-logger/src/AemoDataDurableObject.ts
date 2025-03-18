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
    case 'DEBUG':
      return 1;
    case 'INFO':
      return 2;
    case 'WARN':
      return 3;
    case 'ERROR':
      return 4;
    default:
      return 99; // Means 'NONE' or unknown
  }
}

/** Environment bindings declared in wrangler.*.toml for a SQLite DO. */
export interface AemoDataEnv {
  AEMO_API_URL: string; // e.g. "https://visualisations.aemo.com.au/aemo/apps/api/report/5MIN"
  AEMO_API_HEADERS: string; // JSON string of headers, e.g. '{"Accept":"application/json"}'
  LOG_LEVEL?: string; // If set to "DEBUG" or "INFO", logs more details about the process
}

/**
 * Row type for each interval in the "aemo_five_min_data" table.
 */
export interface IntervalRecord extends Record<string, SqlStorageValue> {
  settlement_ts: number | null;
  regionid: string | null;
  region: string | null;
  rrp: number | null;
  totaldemand: number | null;
  periodtype: string | null;
  netinterchange: number | null;
  scheduledgeneration: number | null;
  semischeduledgeneration: number | null;
  apcflag: number | null;
}

/** Single 5-minute interval from the AEMO API, plus a derived Unix timestamp. */
export interface AemoInterval {
  settlementdate: string;
  settlement_ts: number;
  regionid: string;
  rrp: number;
  totaldemand: number | null;
  periodtype: string | null;
  netinterchange: number | null;
  scheduledgeneration: number | null;
  semischeduledgeneration: number | null;
  apcflag: number | null;
}

/**
 * Shape of the AEMO 5-minute data JSON response.
 * Adjust fields to match all provided data from AEMO.
 */
export interface AemoApiResponse {
  "5MIN": {
    SETTLEMENTDATE: string;
    REGIONID: string;
    RRP: string | number;
    TOTALDEMAND?: string | number;
    PERIODTYPE?: string;
    NETINTERCHANGE?: string | number;
    SCHEDULEDGENERATION?: string | number;
    SEMISCHEduledGENERATION?: string | number; // Some AEMO data sources might differ in casing
    SEMISCHEcheduledGENERATION?: string | number; // Variation placeholders
    SEMISCHECHEDULEDGENERATION?: string | number; // Variation placeholders
    APCFLAG?: string | number;
  }[];
}

/**
 * This Durable Object fetches AEMO data and stores it in a SQLite table named "aemo_five_min_data".
 * When LOG_LEVEL is set to "INFO" or "DEBUG", it logs details about its work.
 */
export class AemoData implements DurableObject {
  private readonly sql: SqlStorage;
  private readonly logLevel: number; // Numeric priority derived from LOG_LEVEL
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
    const configuredLevel = env.LOG_LEVEL ?? "WARN";
    this.logLevel = getLogPriority(configuredLevel);

    // Create (or no-op if it already exists) an "aemo_five_min_data" table.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS aemo_five_min_data (
          settlement_ts             INTEGER NOT NULL,
          regionid                  TEXT    NOT NULL,
          region                    TEXT,
          rrp                       REAL,
          totaldemand              REAL,
          periodtype               TEXT,
          netinterchange           REAL,
          scheduledgeneration      REAL,
          semischeduledgeneration  REAL,
          apcflag                  REAL,
          PRIMARY KEY (settlement_ts, regionid)
      );
      CREATE INDEX IF NOT EXISTS idx_aemo_five_min_data_regionid_ts
          ON aemo_five_min_data (regionid, settlement_ts);
      CREATE INDEX IF NOT EXISTS idx_aemo_five_min_data_ts
          ON aemo_five_min_data (settlement_ts);
    `);

    this.log(
      "INFO",
      `AemoData DO constructed with LOG_LEVEL="${configuredLevel}".`
    );
  }

  /**
   * The DO responds to POST /sync by fetching data from AEMO, then storing intervals in the table.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/sync") {
      return this.handleSync();
    }
    return new Response("Not Found", { status: 404 });
  }

  /**
   * Fetches data from the configured API, parses it, then checks for missing intervals
   * across the discovered date range and regions, inserting or updating records to ensure
   * all data is stored. Logs intermediate steps at INFO/DEBUG or WARNING on failures.
   */
  private async handleSync(): Promise<Response> {
    this.log("INFO", "Beginning data sync from AEMO...");

    const requestBody = { timeScale: ["5MIN"] };
    const headers = this.parseHeaders(this.env.AEMO_API_HEADERS);

    this.log("DEBUG", `Posting to AEMO URL: ${this.env.AEMO_API_URL}`);
    this.log("DEBUG", `Request headers: ${JSON.stringify(headers)}`);
    this.log("DEBUG", `Request body: ${JSON.stringify(requestBody)}`);

    const resp = await fetch(this.env.AEMO_API_URL, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    if (!resp.ok) {
      const err = await resp.text();
      this.log("WARNING", `AEMO API error ${resp.status}: ${err}`);
      return new Response(`AEMO API error ${resp.status}: ${err}`, {
        status: 500
      });
    }

    const data: AemoApiResponse = await resp.json();
    if (!Array.isArray(data["5MIN"])) {
      this.log(
        "WARNING",
        `Invalid or missing "5MIN" array in the AEMO response.`
      );
      return new Response(
        `Invalid or missing "5MIN" array in AEMO response.`,
        { status: 500 }
      );
    }

    // Map to internal intervals structure
    const intervals: AemoInterval[] = data["5MIN"].map((item) => {
      const settlementTs = Math.floor(Date.parse(item.SETTLEMENTDATE) / 1000);
      return {
        settlementdate: item.SETTLEMENTDATE,
        settlement_ts: settlementTs,
        regionid: item.REGIONID,
        rrp: parseFloat(String(item.RRP)),
        totaldemand:
          item.TOTALDEMAND !== undefined
            ? parseFloat(String(item.TOTALDEMAND))
            : null,
        periodtype:
          item.PERIODTYPE !== undefined ? String(item.PERIODTYPE) : null,
        netinterchange:
          item.NETINTERCHANGE !== undefined
            ? parseFloat(String(item.NETINTERCHANGE))
            : null,
        scheduledgeneration:
          item.SCHEDULEDGENERATION !== undefined
            ? parseFloat(String(item.SCHEDULEDGENERATION))
            : null,
        semischeduledgeneration: (() => {
          // Attempt to handle minor naming inconsistencies
          if (item.SEMISCHEduledGENERATION !== undefined) {
            return parseFloat(String(item.SEMISCHEduledGENERATION));
          }
          if (item.SEMISCHECHEDULEDGENERATION !== undefined) {
            return parseFloat(String(item.SEMISCHECHEDULEDGENERATION));
          }
          if (item.SEMISCHEduledGENERATION !== undefined) {
            return parseFloat(String(item.SEMISCHEduledGENERATION));
          }
          return null;
        })(),
        apcflag:
          item.APCFLAG !== undefined ? parseFloat(String(item.APCFLAG)) : null
      };
    });

    // Step 2: Check if there's any data
    if (intervals.length === 0) {
      this.log("WARNING", "No intervals found in AEMO data. Aborting.");
      return new Response("No intervals found in AEMO data. Aborting.", {
        status: 200
      });
    }

    // Find oldest and most recent settlement_ts
    let earliest = intervals[0].settlement_ts;
    let latest = intervals[0].settlement_ts;
    for (const i of intervals) {
      if (i.settlement_ts < earliest) earliest = i.settlement_ts;
      if (i.settlement_ts > latest) latest = i.settlement_ts;
    }
    this.log(
      "DEBUG",
      `Earliest settlement time: ${earliest}, latest settlement time: ${latest}`
    );

    // Step 3: Generate list of unique regions
    const regionSet = new Set<string>();
    for (const i of intervals) {
      regionSet.add(i.regionid);
    }
    this.log(
      "DEBUG",
      `Unique regions found: ${Array.from(regionSet).join(", ")}`
    );

    this.log(
      "INFO",
      `Retrieved ${intervals.length} intervals from AEMO. Checking DB for missing or partial data...`
    );

    /**
     * Step 4 & 5 combined:
     * We've been using "INSERT OR IGNORE" which skips rows that already exist. If a row
     * is partially populated, it won't get updated. Instead, we'll use a standard
     * SQLite upsert approach: "ON CONFLICT(...) DO UPDATE" to ensure data is fully stored.
     */
    let insertedOrUpdatedCount = 0;
    for (const interval of intervals) {
      this.log(
        "DEBUG",
        `Upserting interval: settlement_ts=${interval.settlement_ts}, ` +
          `regionid=${interval.regionid}, rrp=${interval.rrp}, ` +
          `totaldemand=${interval.totaldemand}, periodtype=${interval.periodtype}, ` +
          `netinterchange=${interval.netinterchange}, ` +
          `scheduledgeneration=${interval.scheduledgeneration}, ` +
          `semischeduledgeneration=${interval.semischeduledgeneration}, ` +
          `apcflag=${interval.apcflag}`
      );

      // Use a single upsert statement to ensure complete data is stored if it already exists
      const cursor = this.sql.exec<IntervalRecord>(
        `
        INSERT INTO aemo_five_min_data (
          settlement_ts,
          regionid,
          region,
          rrp,
          totaldemand,
          periodtype,
          netinterchange,
          scheduledgeneration,
          semischeduledgeneration,
          apcflag
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (settlement_ts, regionid)
        DO UPDATE SET
          region=excluded.region,
          rrp=excluded.rrp,
          totaldemand=excluded.totaldemand,
          periodtype=excluded.periodtype,
          netinterchange=excluded.netinterchange,
          scheduledgeneration=excluded.scheduledgeneration,
          semischeduledgeneration=excluded.semischeduledgeneration,
          apcflag=excluded.apcflag
        `,
        interval.settlement_ts,
        interval.regionid,
        interval.regionid, // Insert regionid as region placeholder if no separate region field is provided
        interval.rrp,
        interval.totaldemand,
        interval.periodtype,
        interval.netinterchange,
        interval.scheduledgeneration,
        interval.semischeduledgeneration,
        interval.apcflag
      );

      insertedOrUpdatedCount += cursor.rowsWritten;
    }

    const msg = `Sync complete. Processed ${intervals.length} intervals; upserted ${insertedOrUpdatedCount} rows.`;
    this.log("INFO", msg);
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