/**
 * @fileoverview Durable Object that stores AEMO intervals in a Cloudflare SQL-based backend.
 *
 * IMPORTANT: AEMO data is fixed to Australia/Brisbane time (UTC+10), and the database is
 * storing epoch timestamps. This version stores timestamps in milliseconds (ms).
 *
 * This version includes endpoints for data retrieval:
 *   - POST /sync: used by the scheduled data logger to ingest intervals.
 *   - GET /range: retrieve intervals with optional filters.
 *
 * Updated to support paging (limit & offset parameters) and ensure we return
 * recent records in descending timestamp order when no query parameters are
 * provided. Additional debug logging and documentation added for troubleshooting.
 */

import type {
  DurableObjectState,
  DurableObject,
  SqlStorage,
  SqlStorageValue,
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

export class AemoData implements DurableObject {
  private readonly sql: SqlStorage;
  private readonly logLevel: number;
  private readonly env: AemoDataEnv;

  constructor(private readonly state: DurableObjectState, env: AemoDataEnv) {
    this.sql = state.storage.sql;
    this.env = env;
    const configuredLevel = env.LOG_LEVEL ?? "WARN";
    this.logLevel = getLogPriority(configuredLevel);

    // Check table existence; create if needed
    try {
      this.sql.exec("SELECT 1 FROM aemo_five_min_data LIMIT 1;");
      this.log("DEBUG", "Table aemo_five_min_data exists. Skipping creation.");
    } catch (err) {
      this.log("INFO", `Creating table and indexes aemo_five_min_data - reason: ${String(err)}`);
      this.sql.exec(`
        CREATE TABLE aemo_five_min_data (
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
        CREATE INDEX idx_aemo_five_min_data_regionid_ts
          ON aemo_five_min_data (regionid, settlement_ts);
        CREATE INDEX idx_aemo_five_min_data_ts
          ON aemo_five_min_data (settlement_ts);
      `);
    }

    this.log("INFO", `AemoData DO constructed with LOG_LEVEL="${configuredLevel}".`);
  }

  /**
   * Dispatch fetch requests for:
   * - POST /sync: used by the scheduled data logger to ingest intervals.
   * - GET /range: retrieve intervals with optional filters and paging.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/sync") {
      return this.handleSync();
    } else if (request.method === "GET" && url.pathname === "/range") {
      return this.handleRangeRequest(url);
    }

    return new Response("Not Found", { status: 404 });
  }

  /**
   * The orchestrated data ingestion used by the logger worker:
   * fetch from AEMO and store missing intervals.
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
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
    } catch (err) {
      const msg = `AEMO API fetch failed: ${(err as Error).message}`;
      this.log("ERROR", msg);
      return new Response(msg, { status: 500 });
    }
    if (!resp.ok) {
      const errText = await resp.text();
      const msg = `AEMO API error ${resp.status}: ${errText}`;
      this.log("WARN", msg);
      return new Response(msg, { status: 500 });
    }

    this.log("INFO", "Step 2: Checking the AEMO data for earliest and latest intervals...");
    let data: AemoApiResponse;
    try {
      data = (await resp.json()) as AemoApiResponse;
    } catch (err) {
      const msg = `Invalid JSON in AEMO response: ${(err as Error).message}`;
      this.log("ERROR", msg);
      return new Response(msg, { status: 500 });
    }

    if (!Array.isArray(data["5MIN"])) {
      const msg = `Missing or invalid "5MIN" array in AEMO data.`;
      this.log("WARN", msg);
      return new Response(msg, { status: 500 });
    }

    this.log("INFO", "Parsing intervals (forcing Brisbane offset if needed)...");
    const intervals = data["5MIN"]
      .map((item) => this.recordToInterval(item))
      .filter((rec) => rec !== null) as AemoInterval[];

    if (!intervals.length) {
      const msg = "No intervals parsed from AEMO data. Giving up.";
      this.log("WARN", msg);
      return new Response(msg, { status: 200 });
    }

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

    const regionIds = [...new Set(intervals.map((i) => i.regionid))];
    this.log(
      "DEBUG",
      `Earliest (ms): ${earliest}, latest (ms): ${latest}, Regions: ${JSON.stringify(regionIds)}`
    );

    if (!regionIds.length) {
      const msg = "No region IDs found in AEMO data. Aborting.";
      this.log("WARN", msg);
      return new Response(msg, { status: 200 });
    }

    this.log("INFO", "Step 5: Checking the DB for existing records...");
    const placeholders: string = regionIds.map(() => "?").join(", ");
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

    const existingKeys: Set<string> = new Set();
    for (const row of existingCursor) {
      existingKeys.add(`${row.settlement_ts}-${row.regionid}`);
    }

    this.log(
      "DEBUG",
      `Found ${existingKeys.size} unique records in the chosen ms-range & region set.`
    );

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
   * Handle GET /range for data retrieval. Query parameters:
   *   lastSec: number (if provided, returns data [nowMs - lastSec..nowMs], must be <= 604800)
   *   start: ms
   *   end: ms
   *   regionid: string
   *   limit: number of records to return (for paging, defaults to 100 if not specified)
   *   offset: offset to begin records (for paging, defaults to 0 if not specified)
   *
   * If lastSec is provided, it overrides start/end. Data is returned in descending order.
   * If start/end are provided, data is returned in ascending order by timestamp.
   * If no param is provided, returns the latest records (descending order) up to `limit`.
   */
  private async handleRangeRequest(url: URL): Promise<Response> {
    try {
      // Parse paging parameters
      const limitParamRaw = url.searchParams.get("limit");
      const offsetParamRaw = url.searchParams.get("offset");
      let limit = parseInt(limitParamRaw ?? "100", 10);
      let offset = parseInt(offsetParamRaw ?? "0", 10);
      if (Number.isNaN(limit) || limit <= 0) limit = 100;
      if (Number.isNaN(offset) || offset < 0) offset = 0;
      this.log("DEBUG", `Paging with limit=${limit}, offset=${offset}`);

      const nowMs = Date.now();
      const lastSecParam = url.searchParams.get("lastSec");
      const startParam = url.searchParams.get("start");
      const endParam = url.searchParams.get("end");
      const regionParam = url.searchParams.get("regionid");

      // If lastSec is provided, ensure no start/end is present, and do descending by default.
      if (lastSecParam) {
        if (startParam || endParam) {
          return new Response(
            JSON.stringify({ error: "Cannot combine lastSec with start or end." }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        const lastSec = parseInt(lastSecParam, 10);
        if (isNaN(lastSec) || lastSec <= 0) {
          return new Response(JSON.stringify({ error: "Invalid lastSec." }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        if (lastSec > 604800) {
          return new Response(JSON.stringify({ error: "Requested range too large." }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        const startMs = nowMs - lastSec * 1000;
        const endMs = nowMs;
        // Descending for lastSec
        return this.queryRange(startMs, endMs, regionParam, false, limit, offset);
      }

      // If start or end is present, both must be
      if (startParam || endParam) {
        if (!startParam || !endParam) {
          return new Response(
            JSON.stringify({ error: "Must supply both start and end or neither." }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        const startMs = parseInt(startParam, 10);
        const endMs = parseInt(endParam, 10);
        if (isNaN(startMs) || isNaN(endMs)) {
          return new Response(JSON.stringify({ error: "Invalid start or end." }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        if (endMs < startMs) {
          return new Response(JSON.stringify({ error: "end must be >= start." }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        if ((endMs - startMs) > 604800000) {
          return new Response(JSON.stringify({ error: "Requested range too large." }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        // Ascending for explicit start/end range
        return this.queryRange(startMs, endMs, regionParam, true, limit, offset);
      }

      // No params at all => return the most recent records, descending
      return this.queryLatestRecords(regionParam, limit, offset);
    } catch (err) {
      this.log("ERROR", `handleRangeRequest error: ${String(err)}`);
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /**
   * Retrieve rows from the database between startMs and endMs, with optional region filter,
   * ordering ascending or descending as specified. Applies limit/offset for paging.
   *
   * @param {number} startMs The lower bound of the timestamp range (inclusive).
   * @param {number} endMs The upper bound of the timestamp range (inclusive).
   * @param {string|null} regionParam Optional region ID filter.
   * @param {boolean} asc If true, order by settlement_ts ascending; else descending.
   * @param {number} limit The maximum rows to return (paging).
   * @param {number} offset The row offset to begin returning data (paging).
   * @return {Response} JSON response with the retrieved rows or an error.
   */
  private queryRange(
    startMs: number,
    endMs: number,
    regionParam: string | null,
    asc: boolean,
    limit: number,
    offset: number
  ): Response {
    try {
      // Correct the earlier 'ASC' duplication bug to support ascending/descending
      const orderBy = asc ? "ASC" : "DESC";
      let query = `
        SELECT settlement_ts, regionid, region, rrp, totaldemand, periodtype,
               netinterchange, scheduledgeneration, semischeduledgeneration, apcflag
        FROM aemo_five_min_data
        WHERE settlement_ts >= ? AND settlement_ts <= ?
      `;
      const values: (number | string)[] = [startMs, endMs];

      if (regionParam) {
        query += " AND regionid = ?";
        values.push(regionParam);
      }

      query += ` ORDER BY settlement_ts ${orderBy} LIMIT ? OFFSET ?`;
      values.push(limit, offset);

      this.log("DEBUG", JSON.stringify({ query, values }));
      const rows = this.sql.exec<IntervalRecord>(query, ...values);
      this.log("DEBUG", `Fetched ${rows.length} record(s) from queryRange.`);
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      this.log("ERROR", `queryRange error: ${String(err)}`);
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /**
   * Retrieve the most recent records across all regions (unless filtered by regionParam),
   * ordered by descending timestamp. Applies the provided limit and offset for paging.
   *
   * @param {string|null} regionParam Optional region ID filter.
   * @param {number} limit The maximum rows to return (paging).
   * @param {number} offset The row offset to begin returning data (paging).
   * @return {Response} JSON response with the retrieved rows or an error.
   */
  private queryLatestRecords(
    regionParam: string | null,
    limit: number,
    offset: number
  ): Response {
    try {
      let query = `
        SELECT settlement_ts, regionid, region, rrp, totaldemand, periodtype,
               netinterchange, scheduledgeneration, semischeduledgeneration, apcflag
        FROM aemo_five_min_data
      `;
      const values: (number | string)[] = [];

      if (regionParam) {
        query += " WHERE regionid = ?";
        values.push(regionParam);
      }

      query += ` ORDER BY settlement_ts DESC LIMIT ? OFFSET ?`;
      values.push(limit, offset);

      this.log("DEBUG", JSON.stringify({ query, values }));
      const rows = this.sql.exec<IntervalRecord>(query, ...values);
      this.log("DEBUG", `Fetched ${rows.length} record(s) from queryLatestRecords.`);
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      this.log("ERROR", `queryLatestRecords error: ${String(err)}`);
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /** Convert a raw record from AEMO to an AemoInterval. */
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
      totaldemand: item.TOTALDEMAND !== undefined ? parseFloat(String(item.TOTALDEMAND)) : null,
      periodtype: item.PERIODTYPE !== undefined ? String(item.PERIODTYPE) : null,
      netinterchange: item.NETINTERCHANGE !== undefined ? parseFloat(String(item.NETINTERCHANGE)) : null,
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
      apcflag: item.APCFLAG !== undefined ? parseFloat(String(item.APCFLAG)) : null,
    };
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
   * Append +10:00 if no timezone is specified, parse, return ms.
   */
  private parseLocalBrisbaneMs(dateStr: string): number {
    const hasOffsetRegex = /[Zz]|[\+\-]\d{2}:?\d{2}(\s*\(.*\))?$/;
    let adjusted = dateStr.trim();

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
   * Log a message at the specified log level if the level is >= configured level.
   */
  private log(level: LogLevel, message: string): void {
    if (getLogPriority(level) >= this.logLevel) {
      console.log(`[${level}] ${message}`);
    }
  }
}