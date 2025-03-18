/**
 * @fileoverview Durable Object that stores AEMO intervals in a Cloudflare SQL-based backend.
 *
 * This version parses the AEMO-supplied settlement date exactly as provided, without forcibly
 * appending any timezone offsets. By default, Date.parse() treats a string like
 * "2025-03-16T18:05:00" as UTC if no timezone is specified. If your input is actually local
 * Australian Eastern Time, you may need to explicitly append "+10:00" or handle DST logic.
 * 
 * However, this example shows a bare-minimum approach of storing the parsed epoch timestamp
 * from the raw date string directly. If you still see "Found 0 existing records," verify that:
 *   1) The same DO instance is being used across invocations (i.e., using the same Durable
 *      Object ID or name).  
 *   2) The times are parsed identically on subsequent runs (no ephemeral environment resets).  
 *   3) The date strings match your assumptions about local or UTC.  
 */

import type {
  DurableObjectState,
  DurableObject,
  SqlStorage,
  SqlStorageValue
} from "@cloudflare/workers-types";

/** Possible log levels in ascending severity order. */
type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "NONE";

/** Returns a numeric priority for each log level (lower = more verbose). */
function getLogPriority(level: string): number {
  switch (level.toUpperCase()) {
    case "DEBUG":
      return 1;
    case "INFO":
      return 2;
    case "WARN":
      return 3;
    case "ERROR":
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
    SEMISCHEduledGENERATION?: string | number;
    SEMISCHEcheduledGENERATION?: string | number;
    SEMISCHECHEDULEDGENERATION?: string | number;
    APCFLAG?: string | number;
  }[];
}

/**
 * Durable Object that fetches AEMO data and stores intervals in a SQLite table named "aemo_five_min_data".
 * When LOG_LEVEL is set to "INFO" or "DEBUG", it logs details of the process.  It:
 *   1) Fetches data from the AEMO API.
 *   2) Parses earliest and latest intervals.
 *   3) Checks which records already exist for that time range.
 *   4) Inserts or updates (upsert) any missing intervals.
 */
export class AemoData implements DurableObject {
  private readonly sql: SqlStorage;
  private readonly logLevel: number;
  private readonly env: AemoDataEnv;

  /**
   * Constructs the DO, assigning Cloudflare’s SQL storage to "this.sql" and
   * creating the "aemo_five_min_data" table if it doesn’t exist. Reads LOG_LEVEL
   * from the environment to control debugging verbosity.
   */
  constructor(private readonly state: DurableObjectState, env: AemoDataEnv) {
    this.sql = state.storage.sql;
    this.env = env;
    const configuredLevel = env.LOG_LEVEL ?? "WARN";
    this.logLevel = getLogPriority(configuredLevel);

    // Create table if not existing
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

    this.log("INFO", `AemoData DO constructed with LOG_LEVEL="${configuredLevel}".`);
  }

  /**
   * Main fetch handler. We specifically handle POST /sync to run the data ingestion.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/sync") {
      return this.handleSync();
    }
    return new Response("Not Found", { status: 404 });
  }

  /**
   * Orchestrates data ingestion from the AEMO source.
   */
  private async handleSync(): Promise<Response> {
    this.log("INFO", "Step 1: Attempting to download AEMO data...");

    const requestBody = { timeScale: ["5MIN"] };
    const headers = this.parseHeaders(this.env.AEMO_API_HEADERS);
    this.log("DEBUG", `Request headers: ${JSON.stringify(headers)}`);
    this.log("DEBUG", `Request body: ${JSON.stringify(requestBody)}`);

    let resp: Response;
    try {
      resp = await fetch(this.env.AEMO_API_URL, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      });
    } catch (err) {
      const msg = `AEMO API fetch failed: ${(err as Error).message}`;
      this.log("ERROR", msg);
      return new Response(msg, { status: 500 });
    }

    if (!resp.ok) {
      const errText = await resp.text();
      const msg = `AEMO API error ${resp.status}: ${errText}`;
      this.log("WARNING", msg);
      return new Response(msg, { status: 500 });
    }

    this.log("INFO", "Step 2: Checking the AEMO data for earliest and latest intervals...");
    let data: AemoApiResponse;
    try {
      data = await resp.json() as AemoApiResponse;
    } catch (err) {
      const msg = `Invalid JSON in AEMO response: ${(err as Error).message}`;
      this.log("ERROR", msg);
      return new Response(msg, { status: 500 });
    }

    if (!Array.isArray(data["5MIN"])) {
      const msg = `Missing or invalid "5MIN" array in AEMO data.`;
      this.log("WARNING", msg);
      return new Response(msg, { status: 500 });
    }

    // Convert each raw record into an AemoInterval with settlement_ts.
    const intervals = data["5MIN"].map((item) => this.recordToInterval(item))
                                  .filter((rec) => rec !== null) as AemoInterval[];

    if (!intervals.length) {
      const msg = "No intervals parsed from AEMO data.";
      this.log("WARNING", msg);
      return new Response(msg, { status: 200 });
    }

    // Identify earliest & latest settlement timestamps
    let earliest = intervals[0].settlement_ts;
    let latest = intervals[0].settlement_ts;
    for (const iv of intervals) {
      if (iv.settlement_ts < earliest) earliest = iv.settlement_ts;
      if (iv.settlement_ts > latest) latest = iv.settlement_ts;
    }

    if (Number.isNaN(earliest) || Number.isNaN(latest)) {
      const msg = "One or more settlement_ts values were NaN. Aborting.";
      this.log("ERROR", msg);
      return new Response(msg, { status: 500 });
    }
    this.log("DEBUG", `Earliest settlement time: ${earliest}, latest: ${latest}`);

    this.log("INFO", "Step 3: Generating a list of unique regions in the data...");
    const regionIds = [...new Set(intervals.map((i) => i.regionid))];
    this.log("DEBUG", `Unique region IDs: ${regionIds.join(", ")}`);

    if (!regionIds.length) {
      const msg = "No region IDs in AEMO data. Aborting.";
      this.log("WARNING", msg);
      return new Response(msg, { status: 200 });
    }

    this.log("INFO", "Step 4: Checking the DB for existing records in the available range...");
    const placeholders = regionIds.map(() => '?').join(', ');
    const selectSql = `
      SELECT settlement_ts, regionid
      FROM aemo_five_min_data
      WHERE settlement_ts >= ? AND settlement_ts <= ?
      AND regionid IN (${placeholders})
    `;
    const existingCursor = this.sql.exec<IntervalRecord>(
      selectSql,
      earliest,
      latest,
      ...regionIds
    );
    let existingCount = 0;
    if (existingCursor.results && existingCursor.results[0] && existingCursor.results[0].rows) {
      existingCount = existingCursor.results[0].rows.length;
    }
    this.log("DEBUG", `Found ${existingCount} existing records in this time & region range.`);

    this.log("INFO", "Step 5: Upserting records in the database...");
    let upsertCount = 0;
    for (const interval of intervals) {
      if (Number.isNaN(interval.settlement_ts)) {
        this.log(
          "ERROR",
          `Skipping record with NaN settlement_ts. Original date: ${interval.settlementdate}`
        );
        continue;
      }
      this.log("DEBUG", `Upserting settlement_ts=${interval.settlement_ts}, regionid=${interval.regionid}`);
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
        interval.regionid, // store regionid as "region" if no distinct name
        interval.rrp,
        interval.totaldemand,
        interval.periodtype,
        interval.netinterchange,
        interval.scheduledgeneration,
        interval.semischeduledgeneration,
        interval.apcflag
      );
      upsertCount += cursor.rowsWritten;
    }

    const msg = `Sync complete. Processed ${intervals.length} intervals; upserted ${upsertCount} rows.`;
    this.log("INFO", msg);
    return new Response(msg, { status: 200 });
  }

  /**
   * Convert the raw record from AEMO into an AemoInterval. Returns null if the parse fails.
   */
  private recordToInterval(item: AemoApiResponse["5MIN"][number]): AemoInterval | null {
    const settlementTs = this.parseLocalDate(item.SETTLEMENTDATE);
    if (Number.isNaN(settlementTs)) {
      this.log("ERROR", `Invalid date parse: "${item.SETTLEMENTDATE}" => NaN.`);
      return null;
    }

    return {
      settlementdate: item.SETTLEMENTDATE,
      settlement_ts: settlementTs,
      regionid: item.REGIONID,
      rrp: parseFloat(String(item.RRP)),
      totaldemand: item.TOTALDEMAND !== undefined
        ? parseFloat(String(item.TOTALDEMAND))
        : null,
      periodtype: item.PERIODTYPE !== undefined
        ? String(item.PERIODTYPE)
        : null,
      netinterchange: item.NETINTERCHANGE !== undefined
        ? parseFloat(String(item.NETINTERCHANGE))
        : null,
      scheduledgeneration: item.SCHEDULEDGENERATION !== undefined
        ? parseFloat(String(item.SCHEDULEDGENERATION))
        : null,
      semischeduledgeneration: (() => {
        // Attempt to accommodate minor naming variations
        if (item.SEMISCHEduledGENERATION !== undefined) {
          return parseFloat(String(item.SEMISCHEduledGENERATION));
        }
        if (item.SEMISCHEcheduledGENERATION !== undefined) {
          return parseFloat(String(item.SEMISCHEcheduledGENERATION));
        }
        if (item.SEMISCHECHEDULEDGENERATION !== undefined) {
          return parseFloat(String(item.SEMISCHECHEDULEDGENERATION));
        }
        return null;
      })(),
      apcflag: item.APCFLAG !== undefined
        ? parseFloat(String(item.APCFLAG))
        : null
    };
  }

  /**
   * Directly parses the date string as local time — 
   * i.e., "2025-03-16T18:00:00" => new Date("2025-03-16T18:00:00").getTime()/1000
   * If your AEMO data is truly local time, this might or might not match your desired offset.
   * If your times are already UTC, or you need a specific offset, adjust accordingly.
   */
  private parseLocalDate(dateStr: string): number {
    this.log("DEBUG", `parseLocalDate: "${dateStr}"`);
    const ms = Date.parse(dateStr);
    if (Number.isNaN(ms)) {
      this.log("ERROR", `Failed to parse date string: "${dateStr}"`);
      return NaN;
    }
    return Math.floor(ms / 1000);
  }

  /**
   * If AEMO_API_HEADERS is invalid JSON or empty, return an empty object.
   */
  private parseHeaders(raw: string): Record<string, string> {
    try {
      return raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  /**
   * Logs a message at the given level if it meets or exceeds the configured log threshold.
   */
  private log(level: LogLevel, message: string): void {
    if (getLogPriority(level) >= this.logLevel) {
      console.log(`[${level}] ${message}`);
    }
  }
}