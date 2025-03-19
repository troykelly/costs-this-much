/**
 * @fileoverview Durable Object that stores AEMO intervals in a Cloudflare SQL-based backend.
 *
 * IMPORTANT: AEMO data is fixed to Australia/Brisbane time (UTC+10), and the database is
 * storing epoch timestamps. Previously, this code used seconds-based epoch values, which may
 * not match pre-existing data if it was stored in milliseconds. If your existing database
 * entries were stored with millisecond precision, those records will never match the
 * seconds-based lookup range, leading to the appearance of "Found 0 existing records."
 *
 * In this version, we now store timestamps in milliseconds (ms) rather than seconds, ensuring
 * the queries match if the database also stores ms-based epochs. If your DB was originally
 * storing second-based epochs, you should convert them or revert to storing in seconds. The
 * key point is that both the code and DB must consistently use the same units.
 *
 * Additionally, we force an Australia/Brisbane offset (+10:00) for timestamps that lack a
 * timezone, preventing re-insertion of the same data due to inconsistent parse results.
 *
 * --------------------------------------------------------------------------
 * This Durable Object implements the requested steps:
 *  1. Attempt to download the AEMO data - logging failure and giving up if unavailable.
 *  2. Check the AEMO data for the oldest and most recent values (for all regions); if no data, log the failure and give up.
 *  3. Generate a list of unique regions included in the AEMO data.
 *  4. Output the date range and list of regions to the debug log.
 *  5. Check the database for missing data in the available AEMO data range for the available regions.
 *  6. Output the list of missing intervals in the database to the debug log.
 *  7. Insert any missing records in the database.
 * --------------------------------------------------------------------------
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
  settlement_ts: number | null;  // Now stored in milliseconds
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

/** Single 5-minute interval from AEMO, plus a derived epoch timestamp (ms). */
export interface AemoInterval {
  settlementdate: string;
  settlement_ts: number; // stored in ms
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
 * Forces a UTC+10 offset for Australia/Brisbane if none is provided.
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
   * The orchestrated data ingestion:
   *  1) Attempt to download data from AEMO (log error & give up on failure).
   *  2) Identify oldest & newest intervals across all regions; if none, log & return.
   *  3) Identify unique regions in the data.
   *  4) Output date range & region list to debug logs.
   *  5) Check DB for which intervals exist in that range for those regions.
   *  6) Output missing intervals to debug logs.
   *  7) Insert missing records.
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

    this.log("INFO", "Parsing intervals (forcing Brisbane offset if needed)...");
    const intervals = data["5MIN"]
      .map((item) => this.recordToInterval(item))
      .filter((rec) => rec !== null) as AemoInterval[];

    if (!intervals.length) {
      const msg = "No intervals parsed from AEMO data. Giving up.";
      this.log("WARNING", msg);
      return new Response(msg, { status: 200 });
    }

    // Identify earliest & latest
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

    // 3) Unique regions
    const regionIds = [...new Set(intervals.map((i) => i.regionid))];

    // 4) Output date range & region list
    this.log(
      "DEBUG",
      `Earliest (ms): ${earliest}, latest (ms): ${latest}, Regions: ${JSON.stringify(regionIds)}`
    );

    if (!regionIds.length) {
      const msg = "No region IDs found in AEMO data. Aborting.";
      this.log("WARNING", msg);
      return new Response(msg, { status: 200 });
    }

    // Step 5 debug code (Google TypeScript style: two-space indent).
    this.log("INFO", "Step 5: Checking the DB for existing records...");

    // // 1) Check how many rows are in the table.
    // {
    //   const countQuery = `
    //     SELECT COUNT(*) AS count
    //     FROM aemo_five_min_data
    //   `;
    //   // "countCursor" will yield row objects with a "count" property.
    //   const countCursor = this.sql.exec<{ count: number }>(countQuery);
    //   let totalRows = 0;

    //   // Iterate over the returned cursor to capture the count.
    //   for (const row of countCursor) {
    //     totalRows = row.count;
    //   }

    //   this.log("DEBUG", `Total rows in aemo_five_min_data: ${totalRows}`);
    // }

    // // 2) Check the min and max settlement_ts in the table.
    // {
    //   const minMaxQuery = `
    //     SELECT MIN(settlement_ts) AS min_ts,
    //           MAX(settlement_ts) AS max_ts
    //     FROM aemo_five_min_data
    //   `;
    //   // "minMaxCursor" will yield row objects with "min_ts" and "max_ts" properties.
    //   const minMaxCursor = this.sql.exec<{ min_ts: number; max_ts: number }>(minMaxQuery);

    //   for (const row of minMaxCursor) {
    //     this.log("DEBUG", `Min: ${row.min_ts}, Max: ${row.max_ts}`);
    //   }
    // }

    // // 3) Query a known row that we expect to exist.
    // {
    //   const knownRowQuery = `
    //     SELECT settlement_ts, regionid
    //     FROM aemo_five_min_data
    //     WHERE settlement_ts = 1742177700000
    //       AND regionid = 'NSW1'
    //   `;
    //   // "knownCursor" should yield row objects with "settlement_ts" and "regionid" properties.
    //   const knownCursor = this.sql.exec<{ settlement_ts: number; regionid: string }>(knownRowQuery);
    //   let foundKnown = false;

    //   // If we see any row, we know the data is present.
    //   for (const row of knownCursor) {
    //     foundKnown = true;
    //     this.log("DEBUG", `Found known row in DB: ${JSON.stringify(row)}`);
    //   }
    //   if (!foundKnown) {
    //     this.log("DEBUG", "Known row (1742177700000, NSW1) was NOT found in the current DB.");
    //   }
    // }

    // 4) Run the actual query to find existing records in the chosen range.
    const placeholders: string = regionIds.map(() => "?").join(", ");
    const selectSql = `
      SELECT settlement_ts, regionid
      FROM aemo_five_min_data
      WHERE settlement_ts >= ? AND settlement_ts <= ?
        AND regionid IN (${placeholders})
    `;
    // this.log("DEBUG", selectSql);
    // this.log("DEBUG", JSON.stringify({ earliest, latest, regionIds }));

    // "existingCursor" yields IntervalRecord objects for all matching rows.
    const existingCursor = this.sql.exec<IntervalRecord>(
      selectSql,
      earliest,
      latest,
      ...regionIds
    );

    // Collect matching rows and build a Set of keys in one pass.
    const existingRows: IntervalRecord[] = [];
    const existingKeys: Set<string> = new Set();

    for (const row of existingCursor) {
      existingRows.push(row);
      existingKeys.add(`${row.settlement_ts}-${row.regionid}`);
    }

    this.log(
      "DEBUG",
      `Found ${existingRows.length} existing records in the chosen ms-range & region set.`
    );
    this.log(
      "DEBUG",
      `Found ${existingKeys.size} unique records in the chosen ms-range & region set.`
    );

    // 5) Determine which intervals are missing from the DB.
    this.log("INFO", "Step 6: Figure out missing intervals...");
    const missingIntervals: AemoInterval[] = [];

    for (const iv of intervals) {
      const key: string = `${iv.settlement_ts}-${iv.regionid}`;
      if (!existingKeys.has(key)) {
        missingIntervals.push(iv);
      }
    }

    this.log(
      "DEBUG",
      `Missing intervals (${missingIntervals.length}): ${JSON.stringify(missingIntervals)}`
    );


    this.log("INFO", "Step 7: Insert missing records...");
    let insertedCount = 0;
    for (const iv of missingIntervals) {
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
          DO NOTHING
        `,
        iv.settlement_ts,
        iv.regionid,
        iv.regionid,
        iv.rrp,
        iv.totaldemand,
        iv.periodtype,
        iv.netinterchange,
        iv.scheduledgeneration,
        iv.semischeduledgeneration,
        iv.apcflag
      );
      insertedCount += cursor.rowsWritten;
    }

    const msg = `Sync complete. Processed ${intervals.length} intervals; inserted ${insertedCount} new records.`;
    this.log("INFO", msg);
    return new Response(msg, { status: 200 });
  }

  /**
   * Convert a raw record from AEMO to an AemoInterval, forcing UTC+10 if no timezone is specified,
   * and storing the resulting time in milliseconds.
   */
  private recordToInterval(item: AemoApiResponse["5MIN"][number]): AemoInterval | null {
    const tsMs = this.parseLocalBrisbaneMs(item.SETTLEMENTDATE);
    if (Number.isNaN(tsMs)) {
      this.log("ERROR", `Invalid date parse for: "${item.SETTLEMENTDATE}". Got NaN.`);
      return null;
    }

    return {
      settlementdate: item.SETTLEMENTDATE,
      settlement_ts: tsMs,
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
   * Parses the input as if it is in Australia/Brisbane time (UTC+10).
   * If no timezone offset is present, append "+10:00", then parse.
   * Returns the result in milliseconds.
   */
  private parseLocalBrisbaneMs(dateStr: string): number {
    const hasOffsetRegex = /[Zz]|[\+\-]\d{2}:?\d{2}(\s*\(.*\))?$/;
    let adjusted = dateStr.trim();

    // If the date string doesn't already specify an offset or 'Z', we force +10:00
    if (!hasOffsetRegex.test(adjusted)) {
      adjusted += "+10:00";
    }

    const ms = Date.parse(adjusted);
    if (Number.isNaN(ms)) {
      this.log("ERROR", `Failed to parse date string with +10 offset: "${adjusted}"`);
      return NaN;
    }
    return ms;
  }

  /**
   * Parse environment headers, ignoring invalid JSON.
   */
  private parseHeaders(raw: string): Record<string, string> {
    try {
      return raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  /**
   * Logging helper that obeys the configured log level threshold.
   */
  private log(level: LogLevel, message: string): void {
    if (getLogPriority(level) >= this.logLevel) {
      console.log(`[${level}] ${message}`);
    }
  }
}