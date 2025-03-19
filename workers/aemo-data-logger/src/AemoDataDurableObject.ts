/**
 * @fileoverview Durable Object that stores AEMO intervals in a Cloudflare SQL-based backend.
 *
 * IMPORTANT: AEMO data is typically UTC+10 (Brisbane time) for settlement,
 * and this DO stores timestamps in milliseconds (ms).
 *
 * This version includes endpoints for data retrieval:
 *   - POST /sync: used by the scheduled data logger to ingest intervals.
 *   - GET /range: retrieve intervals with optional filters (start/end, lastSec, regionid) and paging (limit/offset).
 *
 * Changes in this version:
 * 1. More robust debug logging has been added throughout:
 *    - Queries are logged in detail (SQL + bound values).
 *    - Number of returned rows is explicitly counted and logged.
 *    - If zero rows are returned, a debug query is performed to check the min & max timestamps in the table.
 * 2. Additional checks in no-variable scenarios. If "no parameters" are passed, /data now fetches the latest records
 *    in descending order. If no records are returned, additional debug logs show the overall data boundaries.
 * 3. The openapi.yaml is updated to reflect the new endpoint capabilities and clarify paging usage.
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
      return 99; // 'NONE' or unknown
  }
}

/** Environment bindings declared in wrangler.*.toml for a SQLite DO. */
export interface AemoDataEnv {
  AEMO_API_URL: string;       // e.g. "https://visualisations.aemo.com.au/aemo/apps/api/report/5MIN"
  AEMO_API_HEADERS: string;   // JSON string of headers, e.g. '{"Accept":"application/json"}'
  LOG_LEVEL?: string;         // If set to "DEBUG" or "INFO", logs more details about the process
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
 * Shape of the AEMO 5-minute data JSON response. We primarily need the "5MIN" array.
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
    SEMISCHEduledGENERATION?: string | number;          // Potential mismatch in data fields
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

    // Check for table existence; if not present, create.
    try {
      this.log("DEBUG", "Attempting to verify existence of aemo_five_min_data table.");
      this.sql.exec("SELECT 1 FROM aemo_five_min_data LIMIT 1;");
      this.log("DEBUG", "Table aemo_five_min_data found. Skipping creation step.");
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
   * Main fetch router:
   * - POST /sync => handleSync (cron-based ingestion)
   * - GET /range => handleRangeRequest (client data queries)
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.log("DEBUG", `fetch called with method=${request.method}, pathname=${url.pathname}`);

    if (request.method === "POST" && url.pathname === "/sync") {
      return this.handleSync();
    } else if (request.method === "GET" && url.pathname === "/range") {
      return this.handleRangeRequest(url);
    }

    this.log("DEBUG", "No matching route found in AemoDataDurableObject.");
    return new Response("Not Found", { status: 404 });
  }

  /**
   * handleSync - invoked by the scheduled data worker (POST /sync)
   * Steps:
   *   1. Fetch data from AEMO
   *   2. Parse intervals (converting local Brisbane time to epoch ms if needed)
   *   3. Detect earliest & latest timestamps, check DB for existing records
   *   4. Insert any missing intervals
   */
  private async handleSync(): Promise<Response> {
    this.log("INFO", "handleSync: Step 1: Attempting to download AEMO data...");

    // Prepare request
    const requestBody = { timeScale: ["5MIN"] };
    const headers = this.parseHeaders(this.env.AEMO_API_HEADERS);
    this.log("DEBUG", `handleSync: Request headers: ${JSON.stringify(headers)}`);
    this.log("DEBUG", `handleSync: Request body: ${JSON.stringify(requestBody)}`);

    // Fetch from AEMO
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
      const msg = `handleSync: AEMO API fetch failed: ${(err as Error).message}`;
      this.log("ERROR", msg);
      return new Response(msg, { status: 500 });
    }

    if (!resp.ok) {
      const errText = await resp.text();
      const msg = `handleSync: AEMO API error ${resp.status}: ${errText}`;
      this.log("WARN", msg);
      return new Response(msg, { status: 500 });
    }

    // Parse data
    this.log("INFO", "handleSync: Step 2: Checking the AEMO data for earliest and latest intervals...");
    let data: AemoApiResponse;
    try {
      data = (await resp.json()) as AemoApiResponse;
    } catch (err) {
      const msg = `handleSync: Invalid JSON in AEMO response: ${(err as Error).message}`;
      this.log("ERROR", msg);
      return new Response(msg, { status: 500 });
    }

    if (!Array.isArray(data["5MIN"])) {
      const msg = `handleSync: Missing or invalid "5MIN" array in AEMO data.`;
      this.log("WARN", msg);
      return new Response(msg, { status: 500 });
    }

    // Convert to intervals
    this.log("INFO", "handleSync: Parsing intervals (forcing Brisbane offset if needed)...");
    const intervals: AemoInterval[] = data["5MIN"]
      .map((item) => this.recordToInterval(item))
      .filter((iv) => iv !== null) as AemoInterval[];

    if (!intervals.length) {
      const msg = "handleSync: No intervals parsed from AEMO data. Giving up.";
      this.log("WARN", msg);
      return new Response(msg, { status: 200 });
    }

    // Determine earliest & latest
    let earliest = intervals[0].settlement_ts;
    let latest = intervals[0].settlement_ts;
    for (const iv of intervals) {
      if (iv.settlement_ts < earliest) earliest = iv.settlement_ts;
      if (iv.settlement_ts > latest) latest = iv.settlement_ts;
    }

    if (Number.isNaN(earliest) || Number.isNaN(latest)) {
      const msg = "handleSync: One or more settlement_ts values were NaN. Aborting.";
      this.log("ERROR", msg);
      return new Response(msg, { status: 500 });
    }
    this.log(
      "DEBUG",
      `handleSync: earliest=${earliest}, latest=${latest}, totalParsedIntervals=${intervals.length}`
    );

    // Identify region IDs
    const regionIds = [...new Set(intervals.map((i) => i.regionid))];
    this.log("DEBUG", `handleSync: regionIds=${JSON.stringify(regionIds)}`);

    if (!regionIds.length) {
      const msg = "handleSync: No region IDs found in AEMO data. Aborting.";
      this.log("WARN", msg);
      return new Response(msg, { status: 200 });
    }

    // Check for existing records in that date range & region set
    this.log("INFO", "handleSync: Step 5: Checking the DB for existing records...");
    const placeholders: string = regionIds.map(() => "?").join(", ");
    const selectSql = `
      SELECT settlement_ts, regionid
      FROM aemo_five_min_data
      WHERE settlement_ts >= ? AND settlement_ts <= ?
        AND regionid IN (${placeholders})
    `;
    this.log("DEBUG", `handleSync: Checking existing records with query=${selectSql}`);

    const existingRows = this.sql.exec<IntervalRecord>(
      selectSql,
      earliest,
      latest,
      ...regionIds
    );

    const existingKeys: Set<string> = new Set();
    for (const r of existingRows) {
      const combo = `${r.settlement_ts}-${r.regionid}`;
      existingKeys.add(combo);
    }
    this.log(
      "DEBUG",
      `handleSync: foundExisting=${existingKeys.size}, in timeframe [${earliest},${latest}] region set.`
    );

    // Build list of missing intervals
    this.log("INFO", "handleSync: Step 6: Figure out missing intervals...");
    const missingIntervals: AemoInterval[] = [];
    for (const iv of intervals) {
      const key = `${iv.settlement_ts}-${iv.regionid}`;
      if (!existingKeys.has(key)) {
        missingIntervals.push(iv);
      }
    }
    this.log("DEBUG", `handleSync: missingCount=${missingIntervals.length}`);

    // Insert missing intervals
    let insertedCount = 0;
    this.log("INFO", "handleSync: Step 7: Insert missing records...");
    for (const iv of missingIntervals) {
      const cursor = this.sql.exec(
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
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    const msg = `handleSync: Sync complete. intervalsParsed=${intervals.length}, insertedNew=${insertedCount}`;
    this.log("INFO", msg);
    return new Response(msg, { status: 200 });
  }

  /**
   * handleRangeRequest: GET /range for data retrieval.
   * Query parameters:
   *   - lastSec: number => returns data [nowMs - lastSec .. nowMs], descending
   *   - start,end: ms range => ascending
   *   - regionid: (optional) filter
   *   - limit/offset: paging
   * If no parameters => returns the most recent records in descending order.
   */
  private async handleRangeRequest(url: URL): Promise<Response> {
    this.log("DEBUG", "handleRangeRequest: processing /range endpoint call.");

    try {
      // Extract paging
      const limitParamRaw = url.searchParams.get("limit");
      const offsetParamRaw = url.searchParams.get("offset");
      let limit = parseInt(limitParamRaw ?? "100", 10);
      let offset = parseInt(offsetParamRaw ?? "0", 10);
      if (Number.isNaN(limit) || limit <= 0) limit = 100;
      if (Number.isNaN(offset) || offset < 0) offset = 0;
      this.log("DEBUG", `handleRangeRequest: Using limit=${limit}, offset=${offset}`);

      const nowMs = Date.now();
      const lastSecParam = url.searchParams.get("lastSec");
      const startParam = url.searchParams.get("start");
      const endParam = url.searchParams.get("end");
      const regionParam = url.searchParams.get("regionid");
      this.log(
        "DEBUG",
        `handleRangeRequest: lastSec=${lastSecParam}, start=${startParam}, end=${endParam}, regionid=${regionParam}`
      );

      // If lastSec => descending
      if (lastSecParam) {
        if (startParam || endParam) {
          const errorMsg = "Cannot combine lastSec with start or end.";
          this.log("DEBUG", `handleRangeRequest error: ${errorMsg}`);
          return new Response(JSON.stringify({ error: errorMsg }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        const lastSec = parseInt(lastSecParam, 10);
        if (Number.isNaN(lastSec) || lastSec <= 0) {
          const errorMsg = "Invalid lastSec.";
          this.log("DEBUG", `handleRangeRequest error: ${errorMsg}`);
          return new Response(JSON.stringify({ error: errorMsg }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        if (lastSec > 604800) {
          const errorMsg = "Requested range too large.";
          this.log("DEBUG", `handleRangeRequest error: ${errorMsg}`);
          return new Response(JSON.stringify({ error: errorMsg }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        const startMs = nowMs - lastSec * 1000;
        const endMs = nowMs;
        this.log("DEBUG", `handleRangeRequest: lastSec => startMs=${startMs}, endMs=${endMs}`);
        return this.queryRange(startMs, endMs, regionParam, false, limit, offset);
      }

      // If either start or end => both required => ascending
      if (startParam || endParam) {
        if (!startParam || !endParam) {
          const errorMsg = "Must supply both start and end or neither.";
          this.log("DEBUG", `handleRangeRequest error: ${errorMsg}`);
          return new Response(JSON.stringify({ error: errorMsg }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        const startMs = parseInt(startParam, 10);
        const endMs = parseInt(endParam, 10);
        if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
          const errorMsg = "Invalid start or end.";
          this.log("DEBUG", `handleRangeRequest error: ${errorMsg}`);
          return new Response(JSON.stringify({ error: errorMsg }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        if (endMs < startMs) {
          const errorMsg = "end must be >= start.";
          this.log("DEBUG", `handleRangeRequest error: ${errorMsg}`);
          return new Response(JSON.stringify({ error: errorMsg }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        if (endMs - startMs > 604800000) {
          const errorMsg = "Requested range too large.";
          this.log("DEBUG", `handleRangeRequest error: ${errorMsg}`);
          return new Response(JSON.stringify({ error: errorMsg }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        this.log("DEBUG", `handleRangeRequest: explicit => startMs=${startMs}, endMs=${endMs}`);
        return this.queryRange(startMs, endMs, regionParam, true, limit, offset);
      }

      // No parameters => return the most recent records (descending)
      this.log("DEBUG", "handleRangeRequest: no parameters => returning latest records desc.");
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
   * queryRange: retrieve intervals from startMs..endMs. If asc=true => ascending,
   * else => descending. regionParam filters by region if provided. limit/offset for paging.
   *
   * - If results are zero, attempt a fallback debug query to show min & max timestamps
   *   in the entire table, to help diagnose timing issues.
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

      this.log("DEBUG", `queryRange: Final SQL="${query.trim()}"`);
      this.log("DEBUG", `queryRange: Values=${JSON.stringify(values)}`);

      const result = this.sql.exec<IntervalRecord>(query, ...values);
      const rowCount = Array.isArray(result) ? result.length : 0;
      this.log("DEBUG", `queryRange: Retrieved ${rowCount} row(s).`);

      if (rowCount === 0) {
        this.log("DEBUG", "queryRange: No rows returned => performing debug boundary check.");
        this.debugMinMax();
      } else {
        // Sample row
        const sample = result[0];
        this.log(
          "DEBUG",
          `queryRange: sampleRow => settlement_ts=${sample.settlement_ts}, regionid=${sample.regionid}, rrp=${sample.rrp}`
        );
      }

      return new Response(JSON.stringify(result), {
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
   * queryLatestRecords: fetch the latest intervals across all regions
   * (or filtered by region), descending by settlement_ts.
   * Also logs debug info about min & max if rowCount=0, for troubleshooting.
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

      this.log("DEBUG", `queryLatestRecords: Final SQL="${query.trim()}"`);
      this.log("DEBUG", `queryLatestRecords: Values=${JSON.stringify(values)}`);

      const result = this.sql.exec<IntervalRecord>(query, ...values);
      const rowCount = Array.isArray(result) ? result.length : 0;
      this.log("DEBUG", `queryLatestRecords: retrieved ${rowCount} row(s).`);

      if (rowCount === 0) {
        this.log("DEBUG", "queryLatestRecords: No rows => performing debug boundary check.");
        this.debugMinMax();
      } else {
        // Sample row
        const sample = result[0];
        this.log(
          "DEBUG",
          `queryLatestRecords: sampleRow => settlement_ts=${sample.settlement_ts}, regionid=${sample.regionid}, rrp=${sample.rrp}`
        );
      }

      return new Response(JSON.stringify(result), {
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

  /**
   * recordToInterval: convert an AEMO 5MIN record into a typed AemoInterval object.
   * If date parse fails => logs error and returns null.
   */
  private recordToInterval(item: AemoApiResponse["5MIN"][number]): AemoInterval | null {
    const tsMs = this.parseLocalBrisbaneMs(item.SETTLEMENTDATE);
    if (Number.isNaN(tsMs)) {
      this.log(
        "ERROR",
        `recordToInterval: invalid date parse for "${item.SETTLEMENTDATE}". got NaN.`
      );
      return null;
    }

    return {
      settlementdate: item.SETTLEMENTDATE,
      settlement_ts: tsMs,
      regionid: item.REGIONID,
      rrp: parseFloat(String(item.RRP)),
      totaldemand: item.TOTALDEMAND !== undefined ? parseFloat(String(item.TOTALDEMAND)) : null,
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
   * parseHeaders: parse environment variable with safe fallback if JSON is invalid.
   */
  private parseHeaders(raw: string): Record<string, string> {
    try {
      return raw.trim() ? JSON.parse(raw) : {};
    } catch {
      // fallback if invalid JSON
      return {};
    }
  }

  /**
   * parseLocalBrisbaneMs: if no timezone is specified, forcibly append +10:00
   * then parse as UTC. returns ms epoch time or NaN if invalid.
   */
  private parseLocalBrisbaneMs(dateStr: string): number {
    const hasOffsetRegex = /[Zz]|[\+\-]\d{2}:?\d{2}(\s*\(.*\))?$/;
    let adjusted = dateStr.trim();
    if (!hasOffsetRegex.test(adjusted)) {
      adjusted += "+10:00";
    }

    const ms = Date.parse(adjusted);
    if (Number.isNaN(ms)) {
      this.log(
        "ERROR",
        `parseLocalBrisbaneMs: failed parse => original="${dateStr}" adjusted="${adjusted}"`
      );
      return NaN;
    }
    return ms;
  }

  /**
   * debugMinMax: runs a quick query to find min and max of settlement_ts in the entire table,
   * logs them for diagnosing out-of-range queries or data.
   */
  private debugMinMax(): void {
    try {
      const boundaryRows = this.sql.exec<{
        min_ts: number | null;
        max_ts: number | null;
        cnt: number | null;
      }>(`
        SELECT MIN(settlement_ts) AS min_ts,
               MAX(settlement_ts) AS max_ts,
               COUNT(*) AS cnt
        FROM aemo_five_min_data
      `);
      if (boundaryRows.length > 0) {
        const { min_ts, max_ts, cnt } = boundaryRows[0];
        this.log(
          "DEBUG",
          `debugMinMax: Table boundaries => count=${cnt}, min_ts=${min_ts}, max_ts=${max_ts}`
        );
      } else {
        this.log("DEBUG", "debugMinMax: boundary query returned no rows at all, table may be empty.");
      }
    } catch (err) {
      this.log(
        "ERROR",
        `debugMinMax: error retrieving min/max => ${String(err)}`
      );
    }
  }

  /**
   * Logging helper: logs at the given level if within configured threshold.
   */
  private log(level: LogLevel, message: string): void {
    if (getLogPriority(level) >= this.logLevel) {
      console.log(`[${level}] ${message}`);
    }
  }
}