/**
 * @fileoverview Durable Object that stores AEMO intervals in a Cloudflare SQL-based backend.
 *
 * The AEMO data is fixed to Australia/Brisbane time (UTC+10). By default, Date.parse() will
 * treat ISO-like strings (e.g. "2025-03-16T18:05:00") as UTC. Hence, if the data is provided
 * without a timezone, we must append "+10:00" manually so the epoch values will be consistent
 * between runs. Otherwise, the same intervals could re-insert each time if they are parsed
 * differently across invocations.
 *
 * This script implements:
 *  1. Attempt to download the AEMO data - logging failure and giving up in a failure case.
 *  2. Check the AEMO data for the oldest and most recent values (for all regions); if there is no data, log the failure and give up.
 *  3. Generate a list of unique regions included in the AEMO data.
 *  4. Output the date range and list of regions to the debug log.
 *  5. Check the database for missing data in the available AEMO data range for the available regions.
 *  6. Output the list of missing intervals in the database to the debug log.
 *  7. Insert any missing records in the database.
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
 * Applies a forced UTC+10 offset for Australia/Brisbane to avoid re-inserting the same data.
 */
export class AemoData implements DurableObject {
  private readonly sql: SqlStorage;
  private readonly logLevel: number;
  private readonly env: AemoDataEnv;

  /**
   * Constructs the DO, assigning Cloudflare’s SQL storage to "this.sql" and
   * creating the "aemo_five_min_data" table if it doesn’t exist.
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
   * Main fetch handler. For this DO, we specifically handle POST /sync to run the data ingestion.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/sync") {
      return this.handleSync();
    }
    return new Response("Not Found", { status: 404 });
  }

  /**
   * The orchestrated data ingestion workflow:
   *   1) Attempt to download AEMO data (log error and give up on failure).
   *   2) Identify oldest & most recent intervals. If none exist, log & return.
   *   3) Identify unique regions in the data.
   *   4) Output date range & region list to debug logs.
   *   5) Check DB for which intervals exist in that range for those regions.
   *   6) Output missing intervals to debug logs.
   *   7) Insert missing records.
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

    // Convert each raw record into an AemoInterval (with forced UTC+10 offset).
    const intervals = data["5MIN"]
      .map((item) => this.recordToInterval(item))
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

    // 3) Identify unique regions
    const regionIds = [...new Set(intervals.map((i) => i.regionid))];

    // 4) Output date range & region list to debug log
    this.log(
      "DEBUG",
      `Earliest settlement: ${earliest}, latest: ${latest}, regions: ${JSON.stringify(regionIds)}`
    );

    if (!regionIds.length) {
      const msg = "No region IDs in AEMO data. Aborting.";
      this.log("WARNING", msg);
      return new Response(msg, { status: 200 });
    }

    this.log("INFO", "Step 5: Checking the DB to see which intervals already exist...");

    // Query for existing records in that date range for these regions
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

    // Build a set of existing intervals
    const existingIntervals = new Set<string>();
    if (
      existingCursor.results &&
      existingCursor.results[0] &&
      existingCursor.results[0].rows
    ) {
      for (const row of existingCursor.results[0].rows) {
        const key = `${row.settlement_ts}-${row.regionid}`;
        existingIntervals.add(key);
      }
    }
    this.log(
      "DEBUG",
      `Found ${existingIntervals.size} existing records in the chosen time/region range.`
    );

    this.log("INFO", "Step 6: Determining which intervals are missing...");
    const missingIntervals: AemoInterval[] = [];
    for (const iv of intervals) {
      const key = `${iv.settlement_ts}-${iv.regionid}`;
      if (!existingIntervals.has(key)) {
        missingIntervals.push(iv);
      }
    }
    this.log(
      "DEBUG",
      `Missing intervals (${missingIntervals.length}): ${JSON.stringify(missingIntervals)}`
    );

    this.log("INFO", "Step 7: Inserting missing records...");
    let insertedCount = 0;
    for (const interval of missingIntervals) {
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
        interval.regionid,
        interval.rrp,
        interval.totaldemand,
        interval.periodtype,
        interval.netinterchange,
        interval.scheduledgeneration,
        interval.semischeduledgeneration,
        interval.apcflag
      );
      insertedCount += cursor.rowsWritten;
    }

    const msg = `Sync complete. Processed ${intervals.length} intervals; inserted ${insertedCount} new records.`;
    this.log("INFO", msg);
    return new Response(msg, { status: 200 });
  }

  /**
   * Convert the raw record from AEMO into an AemoInterval.
   * Returns null if parse fails.
   * Forces an Australia/Brisbane offset (+10:00) if the string doesn't already have a timezone.
   */
  private recordToInterval(item: AemoApiResponse["5MIN"][number]): AemoInterval | null {
    const settlementTs = this.parseLocalBrisbaneDate(item.SETTLEMENTDATE);
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
      periodtype: item.PERIODTYPE !== undefined ? String(item.PERIODTYPE) : null,
      netinterchange: item.NETINTERCHANGE !== undefined
        ? parseFloat(String(item.NETINTERCHANGE))
        : null,
      scheduledgeneration: item.SCHEDULEDGENERATION !== undefined
        ? parseFloat(String(item.SCHEDULEDGENERATION))
        : null,
      semischeduledgeneration: (() => {
        // Attempt to handle naming variations
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
   * Parse the input as if it is in Australia/Brisbane time (UTC+10).
   * If no timezone offset is present, we append "+10:00".
   */
  private parseLocalBrisbaneDate(dateStr: string): number {
    const hasOffsetRegex = /[Zz]|([\+\-]\d{2}:?\d{2})$/;
    let adjustedStr = dateStr;

    // If the date string doesn't already specify an offset or Z, append +10:00
    if (!hasOffsetRegex.test(dateStr)) {
      adjustedStr += "+10:00";
    }

    this.log("DEBUG", `parseLocalBrisbaneDate: Original="${dateStr}", Adjusted="${adjustedStr}"`);
    const ms = Date.parse(adjustedStr);
    if (Number.isNaN(ms)) {
      this.log("ERROR", `Failed to parse date string (Brisbane offset): "${adjustedStr}"`);
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
   * Logging helper, respects the configured log threshold.
   */
  private log(level: LogLevel, message: string): void {
    if (getLogPriority(level) >= this.logLevel) {
      console.log(`[${level}] ${message}`);
    }
  }
}