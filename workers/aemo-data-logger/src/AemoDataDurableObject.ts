/**
 * @fileoverview Durable Object that stores AEMO intervals in a Cloudflare SQL-backed storage.
 *
 * IMPORTANT: AEMO data is typically UTC+10 (Brisbane time) for settlement,
 * and this DO stores timestamps in milliseconds (ms).
 *
 * Endpoints:
 *   • POST /sync — For scheduled ingestion of data from AEMO.
 *   • GET /range — For client-based data retrieval, with optional filters.
 *   • POST /testInsertThenRead — For debugging only; inserts a row, then queries.
 *
 * This version adds:
 *   1. Even more robust debug logging — including logs for SQL queries,
 *      bound variables, and row counts.
 *   2. Additional constructor debug to verify table existence, row counts,
 *      and first/last records in the table.
 *   3. If no rows return from queries, a min/max boundary check is performed
 *      to understand if the table is truly empty, or if filter conditions
 *      exclude all data.
 *   4. A new “/testInsertThenRead” endpoint to debug direct insert+read flow.
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

/**
 * Environment for AemoData DO, referencing environment variables.
 */
export interface AemoDataEnv {
  AEMO_API_URL: string;     // e.g. "https://visualisations.aemo.com.au/aemo/apps/api/report/5MIN"
  AEMO_API_HEADERS: string; // JSON string of headers: '{"Accept":"application/json"}'
  LOG_LEVEL?: string;       // e.g. "DEBUG", "INFO", ...
}

/**
 * Record type for the "aemo_five_min_data" table. Timestamps in ms.
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

/**
 * Data structure for a single 5-minute interval from AEMO,
 * after conversion to ms-based timestamps.
 */
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
 * Shape of the AEMO JSON response. We mainly care about the "5MIN" array.
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
    SEMISCHEduledGENERATION?: string | number;   // Potential duplicates/typos
    SEMISCHEduledGENERATION?: string | number;
    SEMISCHEduledGENERATION?: string | number;
    SEMISCHEduledGENERATION?: string | number;
    SEMISCHECHEDULEDGENERATION?: string | number;
    APCFLAG?: string | number;
  }[];
}

export class AemoData implements DurableObject {
  private readonly sql: SqlStorage;
  private readonly logLevel: number;
  private readonly env: AemoDataEnv;

  constructor(
    private readonly state: DurableObjectState,
    env: AemoDataEnv
  ) {
    this.sql = state.storage.sql;
    this.env = env;

    // Determine the configured log level.
    const levelString = env.LOG_LEVEL ?? "WARN";
    this.logLevel = getLogPriority(levelString);

    // Check if our table exists. If not, create it. Then run debug checks.
    try {
      this.log("DEBUG", "Attempting to verify existence of aemo_five_min_data table.");
      this.sql.exec("SELECT 1 FROM aemo_five_min_data LIMIT 1;");
      this.log("DEBUG", "Table aemo_five_min_data found. Skipping creation step.");
    } catch (err) {
      this.log("INFO", `Creating table & indexes - reason: ${String(err)}`);
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

    // Log table stats for debugging (row counts, first & last records).
    this.debugTableStatus();

    this.log("INFO", `AemoData DO constructed with LOG_LEVEL="${levelString}".`);
  }

  /**
   * Adds debug logs about table existence, row counts, first & last record.
   * Also inserts a dummy row on each call.
   */
  private debugTableStatus(): void {
    try {
      // Insert a dummy row each time this debug function is called.
      const nowMs = Date.now();
      this.sql.exec(
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
        nowMs,
        "DEBUG_ENTRY",
        "DEBUG_REGION",
        0,
        null,
        null,
        null,
        null,
        null,
        null
      );
      this.log("DEBUG", `debugTableStatus: Inserted dummy row at ts=${nowMs}`);

      // Count total rows
      const countQuery = `SELECT COUNT(*) AS total_count FROM aemo_five_min_data;`;
      const countResult = this.sql.exec<{ total_count: number }>(countQuery);
      let rowCount = 0;
      if (Array.isArray(countResult) && countResult.length > 0 && countResult[0].total_count !== null) {
        rowCount = countResult[0].total_count;
      }
      this.log("DEBUG", `debugTableStatus: totalCount=${rowCount}`);

      // Log first record
      if (rowCount > 0) {
        const firstRowArray = this.sql.exec<IntervalRecord>(
          `SELECT * FROM aemo_five_min_data ORDER BY settlement_ts ASC LIMIT 1;`
        );
        if (firstRowArray.length > 0) {
          this.log("DEBUG", "debugTableStatus: First row in table => " + JSON.stringify(firstRowArray[0]));
        }

        // Log last record
        const lastRowArray = this.sql.exec<IntervalRecord>(
          `SELECT * FROM aemo_five_min_data ORDER BY settlement_ts DESC LIMIT 1;`
        );
        if (lastRowArray.length > 0) {
          this.log("DEBUG", "debugTableStatus: Last row in table => " + JSON.stringify(lastRowArray[0]));
        }
      }
    } catch (err) {
      this.log("ERROR", `debugTableStatus: Unable to query table stats => ${String(err)}`);
    }
  }

  /**
   * Router for fetch requests:
   *  - POST /sync => handleSync
   *  - GET /range => handleRangeRequest
   *  - POST /testInsertThenRead => handleTestInsertThenRead (direct debug)
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.log("DEBUG", `fetch called with method=${request.method}, pathname=${url.pathname}`);

    if (request.method === "POST" && url.pathname === "/sync") {
      return this.handleSync();
    } else if (request.method === "GET" && url.pathname === "/range") {
      return this.handleRangeRequest(url);
    } else if (request.method === "POST" && url.pathname === "/testInsertThenRead") {
      return this.handleTestInsertThenRead();
    }

    this.log("DEBUG", "No matching route found in AemoDataDurableObject.");
    return new Response("Not Found", { status: 404 });
  }

  /**
   * handleSync - handles scheduled ingestion from AEMO.
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
      const msg = `handleSync: AEMO API fetch failed => ${(err as Error).message}`;
      this.log("ERROR", msg);
      return new Response(msg, { status: 500 });
    }

    if (!resp.ok) {
      const errText = await resp.text();
      const msg = `handleSync: AEMO API error => status=${resp.status}, body=${errText}`;
      this.log("WARN", msg);
      return new Response(msg, { status: 500 });
    }

    // Try JSON parse
    this.log("INFO", "handleSync: Step 2: Checking the AEMO data for intervals...");
    let data: AemoApiResponse;
    try {
      data = (await resp.json()) as AemoApiResponse;
    } catch (err) {
      const msg = `handleSync: invalid JSON => ${(err as Error).message}`;
      this.log("ERROR", msg);
      return new Response(msg, { status: 500 });
    }

    if (!Array.isArray(data["5MIN"])) {
      const msg = `handleSync: no valid "5MIN" array in response.`;
      this.log("WARN", msg);
      return new Response(msg, { status: 500 });
    }

    // Convert to intervals
    this.log("INFO", "handleSync: parse intervals (Brisbane offset as needed)...");
    const intervals: AemoInterval[] = data["5MIN"]
      .map((item) => this.recordToInterval(item))
      .filter(Boolean) as AemoInterval[];

    if (!intervals.length) {
      const msg = `handleSync: no intervals found; skipping.`;
      this.log("WARN", msg);
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
      const msg = "handleSync: found NaN timestamps. aborting insertion.";
      this.log("ERROR", msg);
      return new Response(msg, { status: 500 });
    }

    this.log(
      "DEBUG",
      `handleSync: earliest=${earliest}, latest=${latest}, totalIntervals=${intervals.length}`
    );

    // Identify region IDs
    const regionIds = [...new Set(intervals.map((i) => i.regionid))];
    if (!regionIds.length) {
      const msg = "handleSync: intervals have no region IDs. skipping.";
      this.log("WARN", msg);
      return new Response(msg, { status: 200 });
    }
    this.log("DEBUG", `handleSync: regionIds=${JSON.stringify(regionIds)}`);

    // Get existing records
    this.log("INFO", "handleSync: checking DB for existing intervals in that range...");
    const placeholders: string = regionIds.map(() => "?").join(", ");
    const selectSql = `
      SELECT settlement_ts, regionid
      FROM aemo_five_min_data
      WHERE settlement_ts >= ? AND settlement_ts <= ?
        AND regionid IN (${placeholders})
    `;
    const existingRows = this.sql.exec<IntervalRecord>(
      selectSql,
      earliest,
      latest,
      ...regionIds
    );
    const existingKeys = new Set<string>();
    for (const row of existingRows) {
      existingKeys.add(`${row.settlement_ts}-${row.regionid}`);
    }
    this.log(
      "DEBUG",
      `handleSync: found ${existingKeys.size} existing intervals in [${earliest},${latest}].`
    );

    // Insert missing
    const missing: AemoInterval[] = [];
    for (const iv of intervals) {
      const k = `${iv.settlement_ts}-${iv.regionid}`;
      if (!existingKeys.has(k)) {
        missing.push(iv);
      }
    }
    this.log("DEBUG", `handleSync: missingCount=${missing.length}`);

    let insertedCount = 0;
    for (const iv of missing) {
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

    const msg = `handleSync: done. intervalsParsed=${intervals.length}, newlyInserted=${insertedCount}`;
    this.log("INFO", msg);
    return new Response(msg, { status: 200 });
  }

  /**
   * handleRangeRequest => servicing GET /range to retrieve intervals with optional filters:
   *   - lastSec => descending
   *   - start/end => ascending
   *   - regionid => optional
   *   - limit/offset => paging
   * if no parameters, fetch the latest intervals in descending order.
   */
  private async handleRangeRequest(url: URL): Promise<Response> {
    this.log("DEBUG", "handleRangeRequest: invoked.");

    try {
      // parse paging info
      const limitParam = url.searchParams.get("limit");
      const offsetParam = url.searchParams.get("offset");
      let limit = parseInt(limitParam ?? "100", 10);
      let offset = parseInt(offsetParam ?? "0", 10);
      if (Number.isNaN(limit) || limit <= 0) limit = 100;
      if (Number.isNaN(offset) || offset < 0) offset = 0;

      this.log("DEBUG", `handleRangeRequest: limit=${limit}, offset=${offset}`);

      const lastSecParam = url.searchParams.get("lastSec");
      const startParam = url.searchParams.get("start");
      const endParam = url.searchParams.get("end");
      const regionParam = url.searchParams.get("regionid");
      const nowMs = Date.now();

      this.log("DEBUG", 
        `handleRangeRequest: lastSec=${lastSecParam}, start=${startParam}, end=${endParam}, regionid=${regionParam}`
      );

      // If lastSec => override start/end
      if (lastSecParam) {
        if (startParam || endParam) {
          const msg = "Cannot combine lastSec with start or end.";
          this.log("DEBUG", `handleRangeRequest error: ${msg}`);
          return new Response(JSON.stringify({ error: msg }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        const lastSec = parseInt(lastSecParam, 10);
        if (Number.isNaN(lastSec) || lastSec <= 0) {
          const msg = "Invalid lastSec.";
          this.log("DEBUG", `handleRangeRequest error: ${msg}`);
          return new Response(JSON.stringify({ error: msg }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        if (lastSec > 604800) {
          const msg = "Requested range too large.";
          this.log("DEBUG", `handleRangeRequest error: ${msg}`);
          return new Response(JSON.stringify({ error: msg }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        const startMs = nowMs - lastSec * 1000;
        const endMs = nowMs;
        this.log("DEBUG", `handleRangeRequest: lastSec => startMs=${startMs}, endMs=${endMs}`);
        return this.queryRange(startMs, endMs, regionParam, false, limit, offset);
      }

      // If start/end => both required => ascending
      if (startParam || endParam) {
        if (!startParam || !endParam) {
          const msg = "Must supply both start and end or neither.";
          this.log("DEBUG", `handleRangeRequest error: ${msg}`);
          return new Response(JSON.stringify({ error: msg }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        const startMs = parseInt(startParam, 10);
        const endMs = parseInt(endParam, 10);
        if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
          const msg = "Invalid start or end.";
          this.log("DEBUG", `handleRangeRequest error: ${msg}`);
          return new Response(JSON.stringify({ error: msg }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        if (endMs < startMs) {
          const msg = "end must be >= start.";
          this.log("DEBUG", `handleRangeRequest error: ${msg}`);
          return new Response(JSON.stringify({ error: msg }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        if (endMs - startMs > 604800000) {
          const errMsg = "Requested range too large.";
          this.log("DEBUG", `handleRangeRequest error: ${errMsg}`);
          return new Response(JSON.stringify({ error: errMsg }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        this.log("DEBUG", `handleRangeRequest: explicit => startMs=${startMs}, endMs=${endMs}`);
        return this.queryRange(startMs, endMs, regionParam, true, limit, offset);
      }

      // No param => fetch latest (descending).
      this.log("DEBUG", "handleRangeRequest: no parameters => calling queryLatestRecords (desc).");
      return this.queryLatestRecords(regionParam, limit, offset);

    } catch (err) {
      this.log("ERROR", `handleRangeRequest error => ${String(err)}`);
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /**
   * Debug-only route: /testInsertThenRead
   * Inserts a brand-new row with a random settlement_ts, then immediately queries.
   * Returns the newly fetched rows, so you can confirm direct read works in one request.
   */
  private async handleTestInsertThenRead(): Promise<Response> {
    try {
      // Insert a brand-new row every time
      const uniqueTs = Date.now() + Math.floor(Math.random() * 100000);
      const region = "DEBUG_MANUAL";
      const rrp = 999.99;

      this.sql.exec(
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
      `,
        uniqueTs,
        region,
        "TEST_REGION",
        rrp,
        0,
        "DEBUG_PERIOD",
        null,
        null,
        null,
        null
      );

      // Immediately select rows (you can adjust as needed)
      const result = this.sql.exec<IntervalRecord>(
        `
        SELECT settlement_ts, regionid, region, rrp
        FROM aemo_five_min_data
        ORDER BY settlement_ts DESC
        LIMIT 5
      `
      );

      return new Response(JSON.stringify({
        message: "Inserted one row, now reading top 5 rows by settlement_ts:",
        insertedTs: uniqueTs,
        rows: result,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    } catch (err) {
      this.log("ERROR", `handleTestInsertThenRead error => ${String(err)}`);
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /**
   * queryRange: returns rows for settlement_ts in [startMs..endMs], optional region filter,
   * ordering asc/desc. If 0 rows => logs min & max boundary.
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
        this.log("DEBUG", "queryRange: No rows => running debugMinMax.");
        this.debugMinMax();
      } else {
        const sample = result[0];
        this.log("DEBUG", `queryRange: sampleRow => ${JSON.stringify(sample)}`);
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      this.log("ERROR", `queryRange error => ${String(err)}`);
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /**
   * queryLatestRecords: fetches the most recent record for every unique regionid,
   * or if regionParam is provided, the most recent record for that specific regionid.
   * If 0 rows => logs min & max for debug.
   */
  private queryLatestRecords(
    regionParam: string | null,
    limit: number,
    offset: number
  ): Response {
    try {
      let query = `
        SELECT t.settlement_ts, t.regionid, t.region, t.rrp, t.totaldemand,
               t.periodtype, t.netinterchange, t.scheduledgeneration,
               t.semischeduledgeneration, t.apcflag
        FROM aemo_five_min_data t
        JOIN (
          SELECT regionid, MAX(settlement_ts) AS max_ts
          FROM aemo_five_min_data
          GROUP BY regionid
        ) sub ON t.regionid = sub.regionid AND t.settlement_ts = sub.max_ts
      `;
      const values: (number | string)[] = [];

      if (regionParam) {
        query += " WHERE t.regionid = ?";
        values.push(regionParam);
      }
      query += ` ORDER BY t.settlement_ts DESC LIMIT ? OFFSET ?`;
      values.push(limit, offset);

      this.log("DEBUG", `queryLatestRecords: Final SQL="${query.trim()}"`);
      this.log("DEBUG", `queryLatestRecords: Values=${JSON.stringify(values)}`);

      const result = this.sql.exec<IntervalRecord>(query, ...values);
      const rowCount = Array.isArray(result) ? result.length : 0;
      this.log("DEBUG", `queryLatestRecords: retrieved ${rowCount} row(s).`);

      if (rowCount === 0) {
        this.log("DEBUG", "queryLatestRecords: 0 rows => debugMinMax run.");
        this.debugMinMax();
      } else {
        const sample = result[0];
        this.log("DEBUG", `queryLatestRecords: sampleRow => ${JSON.stringify(sample)}`);
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      this.log("ERROR", `queryLatestRecords error => ${String(err)}`);
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /**
   * recordToInterval: convert an AEMO '5MIN' record into an AemoInterval object.
   * If parse fails => logs and returns null.
   */
  private recordToInterval(item: AemoApiResponse["5MIN"][number]): AemoInterval | null {
    const tsMs = this.parseLocalBrisbaneMs(item.SETTLEMENTDATE);
    if (Number.isNaN(tsMs)) {
      this.log("ERROR", `recordToInterval: invalid date parse => "${item.SETTLEMENTDATE}" => NaN`);
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
      apcflag: item.APCFLAG !== undefined
        ? parseFloat(String(item.APCFLAG))
        : null,
    };
  }

  /**
   * parseHeaders => parse from environment to record<string, string>, ignoring errors.
   */
  private parseHeaders(raw: string): Record<string, string> {
    try {
      return raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  /**
   * parseLocalBrisbaneMs => forcibly appends +10:00 if no timezone found,
   * then parse. Returns ms or NaN if parse fails.
   */
  private parseLocalBrisbaneMs(dateStr: string): number {
    const hasOffsetRegex = /[Zz]|[\+\-]\d{2}:?\d{2}(\s*\(.*\))?$/;
    let adjusted = dateStr.trim();
    if (!hasOffsetRegex.test(adjusted)) {
      adjusted += "+10:00";
    }

    const ms = Date.parse(adjusted);
    if (Number.isNaN(ms)) {
      this.log("ERROR", `parseLocalBrisbaneMs: parse failed => original="${dateStr}", adjusted="${adjusted}"`);
      return NaN;
    }
    return ms;
  }

  /**
   * debugMinMax => logs min, max, and total count from the entire table.
   * Also inserts a dummy row on each call.
   */
  private debugMinMax(): void {
    try {
      // Insert a dummy row each time this debug function is called.
      const nowMs = Date.now();
      this.sql.exec(
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
        nowMs,
        "DEBUG_ENTRY",
        "DEBUG_REGION",
        0,
        null,
        null,
        null,
        null,
        null,
        null
      );
      this.log("DEBUG", `debugMinMax: Inserted dummy row at ts=${nowMs}`);

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
          `debugMinMax: Table boundaries => totalCount=${cnt}, min_ts=${min_ts}, max_ts=${max_ts}`
        );
      } else {
        this.log("DEBUG", "debugMinMax: boundary query returned no rows; table likely empty.");
      }
    } catch (err) {
      this.log("ERROR", `debugMinMax: error => ${String(err)}`);
    }
  }

  /**
   * Logging helper => logs if level is within threshold.
   */
  private log(level: LogLevel, message: string): void {
    if (getLogPriority(level) >= this.logLevel) {
      console.log(`[${level}] ${message}`);
    }
  }
}