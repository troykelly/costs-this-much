/**
 * @fileoverview Durable Object that stores AEMO intervals in a Cloudflare SQL-based backend.
 *
 * This version aims to ensure that the settlement timestamps are stored in a consistent epoch format
 * by manually parsing the AEMO-supplied date strings as local Australian Eastern Time (UTC+10) and
 * converting them to UTC seconds. Note that this approach does not handle Daylight Saving Time
 * boundaries—if DST is relevant to your data, additional logic is required.
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
    // Some additional fields are shown in the data, but RRP is critical for identification
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
    this.sql = state.storage.sql;
    this.env = env;
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

    this.log("INFO", `AemoData DO constructed with LOG_LEVEL="${configuredLevel}".`);
  }

  /**
   * The DO responds to POST /sync by fetching data from AEMO, then storing intervals in the table.
   * Steps:
   *  1) Attempt to download AEMO data, logging any failure and giving up if unsuccessful.
   *  2) Check oldest/newest values; if none, log failure and give up.
   *  3) Generate a list of unique regions in the downloaded data.
   *  4) Check the database for missing data in the range of the downloaded intervals.
   *  5) Insert or update partial columns (upsert) for all intervals, effectively filling missing records.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/sync") {
      return this.handleSync();
    }
    return new Response("Not Found", { status: 404 });
  }

  /**
   * Fetches data from the configured API, parses it, then:
   * - Logs failures and aborts if the fetch fails or data is empty.
   * - Identifies earliest and latest intervals.
   * - Finds missing intervals in the DB for those regions/time range (logging at each sub step).
   * - Performs an upsert for each interval, preserving the existing partial-update functionality.
   */
  private async handleSync(): Promise<Response> {
    this.log("INFO", "Step 1: Attempting to download AEMO data...");

    const requestBody = { timeScale: ["5MIN"] };
    const headers = this.parseHeaders(this.env.AEMO_API_HEADERS);

    this.log("DEBUG", `Posting to AEMO URL: ${this.env.AEMO_API_URL}`);
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
    } catch (fetchErr) {
      this.log("ERROR", `AEMO API fetch failed: ${(fetchErr as Error).message}`);
      return new Response(`AEMO API fetch failed: ${(fetchErr as Error).message}`, { status: 500 });
    }

    if (!resp.ok) {
      const err = await resp.text();
      this.log("WARNING", `AEMO API error ${resp.status}: ${err}`);
      return new Response(`AEMO API error ${resp.status}: ${err}`, {
        status: 500
      });
    }

    this.log("INFO", "Step 2: Checking the AEMO data for oldest and newest intervals...");
    const data: AemoApiResponse = await resp.json();
    if (!Array.isArray(data["5MIN"])) {
      this.log("WARNING", `Invalid or missing "5MIN" array in the AEMO response.`);
      return new Response(`Invalid or missing "5MIN" array in AEMO response.`, {
        status: 500
      });
    }

    // Convert raw records to our intervals structure, carefully parsing the timestamp
    // so we consistently store the time as epoch in UTC. This does not handle DST.
    const intervals: AemoInterval[] = data["5MIN"].map((item) => {
      const settlementTs = this.parseAemoDateToUtc(item.SETTLEMENTDATE);
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
    });

    if (!intervals.length) {
      this.log("WARNING", "No intervals found in AEMO data. Aborting.");
      return new Response("No intervals found in AEMO data. Aborting.", { status: 200 });
    }

    // Identify earliest and latest settlement_ts
    let earliest = intervals[0].settlement_ts;
    let latest = intervals[0].settlement_ts;
    for (const i of intervals) {
      if (i.settlement_ts < earliest) earliest = i.settlement_ts;
      if (i.settlement_ts > latest) latest = i.settlement_ts;
    }

    if (
      Number.isNaN(earliest) ||
      Number.isNaN(latest)
    ) {
      this.log("ERROR", "One or more settlement_ts values were NaN. Check input format.");
      return new Response("Invalid date parse (NaN) encountered.", { status: 500 });
    }

    this.log("DEBUG", `Earliest settlement time: ${earliest}, latest: ${latest}`);

    this.log("INFO", "Step 3: Generating a list of unique regions included in the data...");
    const regionSet = new Set<string>();
    for (const i of intervals) {
      regionSet.add(i.regionid);
    }
    this.log("DEBUG", `Unique regions: ${Array.from(regionSet).join(", ")}`);

    if (!regionSet.size) {
      this.log("WARNING", "No region IDs found. Aborting.");
      return new Response("No region IDs in the data.", { status: 200 });
    }

    this.log("INFO", "Step 4: Checking the database for missing data in the available range...");
    const regionIds = Array.from(regionSet);
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
    if (
      existingCursor.results &&
      existingCursor.results[0] &&
      existingCursor.results[0].rows
    ) {
      existingCount = existingCursor.results[0].rows.length;
    }
    this.log(
      "DEBUG",
      `Found ${existingCount} existing records in this range for these regions.`
    );

    this.log("INFO", "Step 5: Inserting or updating records (upsert) in the database...");
    let upsertCount = 0;
    for (const interval of intervals) {
      // If settlement_ts is invalid, skip
      if (Number.isNaN(interval.settlement_ts)) {
        this.log(
          "ERROR",
          `Skipping record with NaN settlement_ts. Original date: ${interval.settlementdate}, region: ${interval.regionid}`
        );
        continue;
      }

      this.log(
        "DEBUG",
        `Upserting interval: settlement_ts=${interval.settlement_ts}, regionid=${interval.regionid}`
      );
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
        interval.regionid, // region placeholder if no distinct region name
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
   * If AEMO_API_HEADERS is invalid JSON or empty, return an empty object.
   */
  private parseHeaders(raw: string): Record<string, string> {
    try {
      return raw && raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  /**
   * Manually parses an AEMO-provided date "YYYY-MM-DDTHH:mm:ss" as if it is in
   * Australian Eastern Time (UTC+10), then converts to a UTC epoch (in seconds).
   *
   * NOTE: This does not handle Daylight Saving Time. If DST is active, adjustments
   *       will be necessary. Also, if your AEMO times do or will include an actual
   *       time zone field, you'll need a more robust parsing approach.
   *
   * @param dateStr The AEMO-supplied local date/time string, e.g. "2025-03-16T18:00:00"
   * @return The epoch timestamp (UTC seconds) or NaN if parsing fails
   */
  private parseAemoDateToUtc(dateStr: string): number {
    // We expect "YYYY-MM-DDTHH:mm:ss"
    this.log("DEBUG", `Parsing date string: "${dateStr}" as AEST (UTC+10)`);
    const [datePart, timePart] = dateStr.split("T");
    if (!datePart || !timePart) {
      this.log("ERROR", `Malformed date/time: "${dateStr}"`);
      return NaN;
    }

    const [yearStr, monthStr, dayStr] = datePart.split("-");
    const [hourStr, minuteStr, secondStr = "0"] = timePart.split(":");
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const day = parseInt(dayStr, 10);
    let hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);
    const second = parseInt(secondStr, 10);

    if (
      Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day) ||
      Number.isNaN(hour) || Number.isNaN(minute) || Number.isNaN(second)
    ) {
      this.log("ERROR", `Invalid numeric date/time components: "${dateStr}"`);
      return NaN;
    }

    // Subtract 10 hours to shift from local AEST to UTC.
    // This is naive and does not handle DST or day wrap-around properly.
    hour -= 10;
    const ms = Date.UTC(year, month - 1, day, hour, minute, second);

    if (Number.isNaN(ms)) {
      this.log("ERROR", `Could not build UTC time from: "${dateStr}"`);
      return NaN;
    }
    return Math.floor(ms / 1000);
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