/**
 * @fileoverview Durable Object that stores electricity market intervals (initially AEMO's NEM data),
 * including energy price, FCAS components, demand, and other properties needed for retail price
 * calculations. The table schema is designed to be non-AEMO specific, enabling extension to other
 * Australian or international markets in future.
 *
 * Endpoints:
 *   • POST /sync — For scheduled ingestion of data from AEMO (ELEC_NEM_SUMMARY, ELEC_NEM_SUMMARY_PRICES).
 *   • GET /range — For client-based data retrieval, with optional filters.
 *   • POST /testInsertThenRead — For debugging only; inserts a row, then queries.
 *
 * This refactor replaces the old "aemo_five_min_data" table with "market_interval_data," storing
 * the richer set of fields (including FCAS components) from AEMO's ELEC_NEM_SUMMARY and
 * ELEC_NEM_SUMMARY_PRICES. By design, these columns can be reused for other markets, such as WEM, WA, NT, etc.
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
 * Environment for AemoData DO, referencing environment variables. The additional fields
 * allow for constructing distinct AEMO endpoints to fetch summary data, FCAS prices, etc.
 */
export interface AemoDataEnv {
  // Base URL for AEMO's data service, e.g. "https://visualisations.aemo.com.au/aemo/apps/api/report"
  AEMO_API_URL: string;

  // Specific endpoints or identifiers for different data sets:
  // e.g. "ELEC_NEM_SUMMARY", "ELEC_NEM_SUMMARY_PRICES", "ELEC_NEM_SUMMARY_MARKET_NOTICE", etc.
  AEMO_DATA_SUMMARY: string;                  // e.g. "ELEC_NEM_SUMMARY"
  AEMO_DATA_SUMMARY_PRICES: string;           // e.g. "ELEC_NEM_SUMMARY_PRICES"
  AEMO_DATA_SUMMARY_MARKET_NOTICE?: string;   // e.g. "ELEC_NEM_SUMMARY_MARKET_NOTICE"
  AEMO_DATA_5MIN?: string;                    // e.g. "5MIN"
  AEMO_DATA_CUMUL_PRICE?: string;             // e.g. "NEM_DASHBOARD_CUMUL_PRICE"

  // JSON string containing HTTP headers for requests to AEMO's API, e.g. '{"Accept":"application/json"}'
  AEMO_API_HEADERS: string;

  // Optional environment-based log level: "DEBUG", "INFO", "WARN", or "ERROR".
  LOG_LEVEL?: string;
}

/**
 * Record type for the "market_interval_data" table. Timestamps in ms.
 * The table is designed to store enough fields for potential
 * electricity market expansions beyond AEMO NEM data.
 */
export interface MarketIntervalRecord extends Record<string, SqlStorageValue> {
  settlement_ts: number;
  regionid: string;
  region: string | null;
  market_name: string;
  energy_price: number | null;
  price_status: string | null;
  apc_flag: number | null;
  market_suspended_flag: number | null;
  total_demand: number | null;
  net_interchange: number | null;
  scheduled_generation: number | null;
  semischeduled_generation: number | null;
  interconnector_flows: string | null;
  raise_reg_price: number | null;
  lower_reg_price: number | null;
  raise_1sec_price: number | null;
  raise_6sec_price: number | null;
  raise_60sec_price: number | null;
  raise_5min_price: number | null;
  lower_1sec_price: number | null;
  lower_6sec_price: number | null;
  lower_60sec_price: number | null;
  lower_5min_price: number | null;
}

/**
 * Represents a single merged record from ELEC_NEM_SUMMARY and ELEC_NEM_SUMMARY_PRICES,
 * plus any expansions for additional markets in future.
 */
interface CombinedIntervalRow {
  settlement_ts: number;
  regionid: string;
  region: string;
  market_name: string;
  energy_price: number | null;
  price_status: string | null;
  apc_flag: number | null;
  market_suspended_flag: number | null;
  total_demand: number | null;
  net_interchange: number | null;
  scheduled_generation: number | null;
  semischeduled_generation: number | null;
  interconnector_flows: string | null;
  raise_reg_price: number | null;
  lower_reg_price: number | null;
  raise_1sec_price: number | null;
  raise_6sec_price: number | null;
  raise_60sec_price: number | null;
  raise_5min_price: number | null;
  lower_1sec_price: number | null;
  lower_6sec_price: number | null;
  lower_60sec_price: number | null;
  lower_5min_price: number | null;
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

    const levelString = env.LOG_LEVEL ?? "WARN";
    this.logLevel = getLogPriority(levelString);

    // Create or verify table existence
    try {
      this.log("DEBUG", "Verifying existence of market_interval_data table.");
      this.sql.exec("SELECT 1 FROM market_interval_data LIMIT 1;");
      this.log("DEBUG", "Table market_interval_data found. Skipping creation step.");
    } catch (err) {
      this.log(
        "INFO",
        `Creating table & indexes for market_interval_data - reason: ${String(err)}`
      );
      this.sql.exec(`
        CREATE TABLE market_interval_data (
          settlement_ts             INTEGER NOT NULL,
          regionid                  TEXT    NOT NULL,
          region                    TEXT,
          market_name               TEXT    NOT NULL,
          energy_price              REAL,
          price_status              TEXT,
          apc_flag                  REAL,
          market_suspended_flag     REAL,
          total_demand              REAL,
          net_interchange           REAL,
          scheduled_generation      REAL,
          semischeduled_generation  REAL,
          interconnector_flows      TEXT,
          raise_reg_price           REAL,
          lower_reg_price           REAL,
          raise_1sec_price          REAL,
          raise_6sec_price          REAL,
          raise_60sec_price         REAL,
          raise_5min_price          REAL,
          lower_1sec_price          REAL,
          lower_6sec_price          REAL,
          lower_60sec_price         REAL,
          lower_5min_price          REAL,
          PRIMARY KEY (settlement_ts, regionid, market_name)
        );
        CREATE INDEX idx_market_data_ts
          ON market_interval_data (settlement_ts);
        CREATE INDEX idx_market_data_region
          ON market_interval_data (regionid, settlement_ts);
      `);
    }

    this.log("INFO", `AemoData DO constructed with LOG_LEVEL="${levelString}".`);
  }

  /**
   * Router for fetch requests:
   *  - POST /sync => handleSync
   *  - GET /range => handleRangeRequest
   *  - POST /testInsertThenRead => handleTestInsertThenRead
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
   * handleSync - loads summary data and prices data from individual endpoints,
   * merges them, then stores them in the database.
   */
  private async handleSync(): Promise<Response> {
    this.log("INFO", "handleSync: Starting retrieval of ELEC_NEM_SUMMARY & ELEC_NEM_SUMMARY_PRICES");

    // Build final endpoints
    const summaryUrl = `${this.env.AEMO_API_URL}/${this.env.AEMO_DATA_SUMMARY}`;
    const summaryPricesUrl = `${this.env.AEMO_API_URL}/${this.env.AEMO_DATA_SUMMARY_PRICES}`;
    const headers = this.parseHeaders(this.env.AEMO_API_HEADERS);

    let summaryData: any;
    let summaryPricesData: any;
    try {
      // Get the summary data
      this.log("DEBUG", `Fetching summary data from: ${summaryUrl}`);
      const sResp = await fetch(summaryUrl, {
        method: "GET",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
      });
      if (!sResp.ok) {
        const bodyText = await sResp.text();
        throw new Error(`Summary fetch error => status=${sResp.status}, body=${bodyText}`);
      }
      summaryData = await sResp.json();

      // Get the summary prices data
      this.log("DEBUG", `Fetching summary prices data from: ${summaryPricesUrl}`);
      const spResp = await fetch(summaryPricesUrl, {
        method: "GET",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
      });
      if (!spResp.ok) {
        const bodyText = await spResp.text();
        throw new Error(`Summary Prices fetch error => status=${spResp.status}, body=${bodyText}`);
      }
      summaryPricesData = await spResp.json();

    } catch (err) {
      const msg = `handleSync: Data fetch failed => ${(err as Error).message}`;
      this.log("ERROR", msg);
      return new Response(msg, { status: 500 });
    }

    // We'll combine them into a single object that mimics the user-provided example.
    const data = {
      ELEC_NEM_SUMMARY: Array.isArray(summaryData) ? summaryData : [],
      ELEC_NEM_SUMMARY_PRICES: Array.isArray(summaryPricesData) ? summaryPricesData : [],
      // If you want to fetch market notices too, you'd do similarly:
      // ELEC_NEM_SUMMARY_MARKET_NOTICE: ...
    };

    // Validate arrays
    if (!Array.isArray(data.ELEC_NEM_SUMMARY) || !Array.isArray(data.ELEC_NEM_SUMMARY_PRICES)) {
      const errMsg = "handleSync: Invalid arrays found in the combined data object.";
      this.log("ERROR", errMsg);
      return new Response(errMsg, { status: 500 });
    }

    this.log("INFO", "handleSync: Step 2: Merging data from ELEC_NEM_SUMMARY & ELEC_NEM_SUMMARY_PRICES");

    // Build region => FCAS map from ELEC_NEM_SUMMARY_PRICES
    const fcasMap = new Map<string, any>();
    for (const p of data.ELEC_NEM_SUMMARY_PRICES) {
      const region = String(p.REGIONID || "").trim();
      if (region) {
        fcasMap.set(region, p);
      }
    }

    // Merge to produce final CombinedIntervalRow
    const combinedRows: CombinedIntervalRow[] = [];
    for (const item of data.ELEC_NEM_SUMMARY) {
      const regionid = String(item.REGIONID || "").trim();
      if (!regionid) {
        continue;
      }
      const settlement_ts = this.parseLocalBrisbaneMs(item.SETTLEMENTDATE);
      if (Number.isNaN(settlement_ts)) {
        this.log("ERROR", `Invalid date parse => "${item.SETTLEMENTDATE}" => NaN`);
        continue;
      }
      const fc = fcasMap.get(regionid) || {};
      combinedRows.push({
        settlement_ts,
        regionid,
        region: regionid,
        market_name: "NEM",
        energy_price: item.PRICE ?? null,
        price_status: item.PRICE_STATUS ?? null,
        apc_flag: item.APCFLAG ?? null,
        market_suspended_flag: item.MARKETSUSPENDEDFLAG ?? null,
        total_demand: item.TOTALDEMAND ?? null,
        net_interchange: item.NETINTERCHANGE ?? null,
        scheduled_generation: item.SCHEDULEDGENERATION ?? null,
        semischeduled_generation: item.SEMISCHEDULEDGENERATION ?? null,
        interconnector_flows: item.INTERCONNECTORFLOWS ?? null,

        raise_reg_price: fc.RAISEREGRRP ?? null,
        lower_reg_price: fc.LOWERREGRRP ?? null,
        raise_1sec_price: fc.RAISE1SECRRP ?? null,
        raise_6sec_price: fc.RAISE6SECRRP ?? null,
        raise_60sec_price: fc.RAISE60SECRRP ?? null,
        raise_5min_price: fc.RAISE5MINRRP ?? null,
        lower_1sec_price: fc.LOWER1SECRRP ?? null,
        lower_6sec_price: fc.LOWER6SECRRP ?? null,
        lower_60sec_price: fc.LOWER60SECRRP ?? null,
        lower_5min_price: fc.LOWER5MINRRP ?? null,
      });
    }

    if (!combinedRows.length) {
      const msg = "handleSync: No valid intervals found after merging summary & prices.";
      this.log("WARN", msg);
      return new Response(msg, { status: 200 });
    }

    // Deduplicate by checking existing DB rows first
    let earliest = combinedRows[0].settlement_ts;
    let latest = combinedRows[0].settlement_ts;
    for (const row of combinedRows) {
      if (row.settlement_ts < earliest) earliest = row.settlement_ts;
      if (row.settlement_ts > latest) latest = row.settlement_ts;
    }

    const regionIds = [...new Set(combinedRows.map((r) => r.regionid))];
    const placeholders: string = regionIds.map(() => "?").join(", ");
    if (!regionIds.length) {
      const msg = "handleSync: intervals have no region IDs. skipping.";
      this.log("WARN", msg);
      return new Response(msg, { status: 200 });
    }

    const selectSql = `
      SELECT settlement_ts, regionid, market_name
      FROM market_interval_data
      WHERE settlement_ts >= ?
        AND settlement_ts <= ?
        AND regionid IN (${placeholders})
        AND market_name = 'NEM'
    `;
    const existingCursor = this.sql.exec(selectSql, earliest, latest, ...regionIds);
    const existingRows = existingCursor.toArray();
    const existingKeys = new Set<string>();
    for (const row of existingRows) {
      existingKeys.add(`${row.settlement_ts}-${row.regionid}-${row.market_name}`);
    }
    this.log("DEBUG", `Found ${existingKeys.size} existing intervals in [${earliest},${latest}].`);

    const missing: CombinedIntervalRow[] = [];
    for (const r of combinedRows) {
      const key = `${r.settlement_ts}-${r.regionid}-${r.market_name}`;
      if (!existingKeys.has(key)) {
        missing.push(r);
      }
    }
    this.log("DEBUG", `Missing row count to insert: ${missing.length}`);

    let insertedCount = 0;
    for (const r of missing) {
      const cursor = this.sql.exec(
        `
          INSERT INTO market_interval_data (
            settlement_ts,
            regionid,
            region,
            market_name,
            energy_price,
            price_status,
            apc_flag,
            market_suspended_flag,
            total_demand,
            net_interchange,
            scheduled_generation,
            semischeduled_generation,
            interconnector_flows,
            raise_reg_price,
            lower_reg_price,
            raise_1sec_price,
            raise_6sec_price,
            raise_60sec_price,
            raise_5min_price,
            lower_1sec_price,
            lower_6sec_price,
            lower_60sec_price,
            lower_5min_price
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (settlement_ts, regionid, market_name)
          DO NOTHING
        `,
        r.settlement_ts,
        r.regionid,
        r.region,
        r.market_name,
        r.energy_price,
        r.price_status,
        r.apc_flag,
        r.market_suspended_flag,
        r.total_demand,
        r.net_interchange,
        r.scheduled_generation,
        r.semischeduled_generation,
        r.interconnector_flows,
        r.raise_reg_price,
        r.lower_reg_price,
        r.raise_1sec_price,
        r.raise_6sec_price,
        r.raise_60sec_price,
        r.raise_5min_price,
        r.lower_1sec_price,
        r.lower_6sec_price,
        r.lower_60sec_price,
        r.lower_5min_price
      );
      insertedCount += cursor.rowsWritten;
    }

    const msg = `handleSync: done. intervalsParsed=${combinedRows.length}, newlyInserted=${insertedCount}`;
    this.log("INFO", msg);
    return new Response(msg, { status: 200 });
  }

  /**
   * handleRangeRequest => servicing GET /range to retrieve intervals with optional filters:
   *   - lastSec => descending
   *   - start/end => ascending
   *   - regionid => optional
   *   - limit/offset => paging
   * If no parameters, returns the most recent record for each region (descending).
   */
  private async handleRangeRequest(url: URL): Promise<Response> {
    this.log("DEBUG", "handleRangeRequest: invoked.");

    try {
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
      const regionParam = url.searchParams.get("regionid") || null;
      const nowMs = Date.now();

      this.log(
        "DEBUG",
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
        // compute range
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
        return this.queryRange(startMs, endMs, regionParam, true, limit, offset);
      }

      // No param => fetch the most recent record for each region in descending order.
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
   * Inserts a brand-new row with a random settlement_ts, then immediately queries
   * the top 5 rows. Returns the newly fetched rows for quick verification.
   */
  private async handleTestInsertThenRead(): Promise<Response> {
    try {
      // Insert a brand-new row
      const uniqueTs = Date.now() + Math.floor(Math.random() * 100000);
      const region = "DEBUG_MANUAL";
      const price = 999.99;

      this.sql.exec(
        `
        INSERT INTO market_interval_data (
          settlement_ts,
          regionid,
          region,
          market_name,
          energy_price,
          price_status,
          apc_flag,
          market_suspended_flag,
          total_demand,
          net_interchange,
          scheduled_generation,
          semischeduled_generation,
          interconnector_flows,
          raise_reg_price,
          lower_reg_price,
          raise_1sec_price,
          raise_6sec_price,
          raise_60sec_price,
          raise_5min_price,
          lower_1sec_price,
          lower_6sec_price,
          lower_60sec_price,
          lower_5min_price
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        uniqueTs,
        region,
        region,
        "NEM",
        price,
        "FIRM",
        0,
        0,
        0,
        0,
        0,
        0,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null
      );

      // Query the last 5
      const resultCursor = this.sql.exec<MarketIntervalRecord>(
        `
        SELECT settlement_ts, regionid, region, market_name,
               energy_price, price_status
        FROM market_interval_data
        ORDER BY settlement_ts DESC
        LIMIT 5
      `
      );
      const resultRaw = resultCursor.toArray();

      const result = resultRaw.map((row) => ({
        settlement: row.settlement_ts == null
          ? null
          : new Date(row.settlement_ts).toISOString(),
        regionid: row.regionid,
        region: row.region,
        market_name: row.market_name,
        energy_price: row.energy_price,
        price_status: row.price_status,
      }));

      return new Response(
        JSON.stringify(
          {
            message: "Inserted one row, now reading top 5 rows by settlement_ts:",
            inserted: new Date(uniqueTs).toISOString(),
            rows: result,
          },
          null,
          2
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
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
   * ordering asc/desc. Also sets pagination headers:
   *  X-Page, X-Limit, X-Total-Pages, X-Has-Next-Page, X-Total-Count
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
      let countQuery = `
        SELECT COUNT(*) as total_count
        FROM market_interval_data
        WHERE settlement_ts >= ? AND settlement_ts <= ?
          AND market_name = 'NEM'
      `;
      const countValues: (number | string)[] = [startMs, endMs];
      if (regionParam) {
        countQuery += " AND regionid = ?";
        countValues.push(regionParam);
      }

      const countCursor = this.sql.exec<{ total_count: number }>(
        countQuery,
        ...countValues
      );
      const countArr = countCursor.toArray();
      let totalCount = 0;
      if (countArr.length > 0 && typeof countArr[0].total_count === "number") {
        totalCount = countArr[0].total_count;
      }

      const orderBy = asc ? "ASC" : "DESC";
      let query = `
        SELECT
          settlement_ts,
          regionid,
          region,
          market_name,
          energy_price,
          price_status,
          apc_flag,
          market_suspended_flag,
          total_demand,
          net_interchange,
          scheduled_generation,
          semischeduled_generation,
          interconnector_flows,
          raise_reg_price,
          lower_reg_price,
          raise_1sec_price,
          raise_6sec_price,
          raise_60sec_price,
          raise_5min_price,
          lower_1sec_price,
          lower_6sec_price,
          lower_60sec_price,
          lower_5min_price
        FROM market_interval_data
        WHERE settlement_ts >= ? AND settlement_ts <= ?
          AND market_name = 'NEM'
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

      const resultCursor = this.sql.exec<MarketIntervalRecord>(query, ...values);
      const rowArr = resultCursor.toArray();
      const rowCount = rowArr.length;
      this.log("DEBUG", `queryRange: Retrieved ${rowCount} row(s).`);

      const transformed = rowArr.map((row) => ({
        settlement: row.settlement_ts == null
          ? null
          : new Date(row.settlement_ts).toISOString(),
        regionid: row.regionid,
        region: row.region,
        market_name: row.market_name,
        energy_price: row.energy_price,
        price_status: row.price_status,
        apc_flag: row.apc_flag,
        market_suspended_flag: row.market_suspended_flag,
        total_demand: row.total_demand,
        net_interchange: row.net_interchange,
        scheduled_generation: row.scheduled_generation,
        semischeduled_generation: row.semischeduled_generation,
        interconnector_flows: row.interconnector_flows,
        raise_reg_price: row.raise_reg_price,
        lower_reg_price: row.lower_reg_price,
        raise_1sec_price: row.raise_1sec_price,
        raise_6sec_price: row.raise_6sec_price,
        raise_60sec_price: row.raise_60sec_price,
        raise_5min_price: row.raise_5min_price,
        lower_1sec_price: row.lower_1sec_price,
        lower_6sec_price: row.lower_6sec_price,
        lower_60sec_price: row.lower_60sec_price,
        lower_5min_price: row.lower_5min_price,
      }));

      const resp = new Response(JSON.stringify(transformed), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

      const pageNumber = Math.floor(offset / limit) + 1;
      const totalPages = Math.ceil(totalCount / limit);

      resp.headers.set("X-Page", pageNumber.toString());
      resp.headers.set("X-Limit", limit.toString());
      resp.headers.set("X-Total-Count", totalCount.toString());
      resp.headers.set("X-Total-Pages", totalPages.toString());
      resp.headers.set("X-Has-Next-Page", (pageNumber < totalPages).toString());

      return resp;
    } catch (err) {
      this.log("ERROR", `queryRange error => ${String(err)}`);
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /**
   * queryLatestRecords: fetches the most recent record for every unique regionid (in the NEM)
   * or, if regionParam is provided, the most recent for that region only, returning them
   * in descending order by settlement_ts. Also sets pagination headers for consistency.
   */
  private queryLatestRecords(
    regionParam: string | null,
    limit: number,
    offset: number
  ): Response {
    try {
      let countSql = `
        SELECT COUNT(*) as total_count FROM (
          SELECT t.settlement_ts, t.regionid
          FROM market_interval_data t
          JOIN (
            SELECT regionid, MAX(settlement_ts) AS max_ts
            FROM market_interval_data
            WHERE market_name = 'NEM'
            GROUP BY regionid
          ) sub ON t.regionid = sub.regionid AND t.settlement_ts = sub.max_ts
          WHERE t.market_name = 'NEM'
      `;
      const countVals: string[] = [];
      if (regionParam) {
        countSql += " AND t.regionid = ?";
        countVals.push(regionParam);
      }
      countSql += ") alias";

      const countCursor = this.sql.exec<{ total_count: number }>(countSql, ...countVals);
      const countArr = countCursor.toArray();
      let totalCount = 0;
      if (countArr.length > 0 && typeof countArr[0].total_count === "number") {
        totalCount = countArr[0].total_count;
      }

      let query = `
        SELECT t.settlement_ts,
               t.regionid,
               t.region,
               t.market_name,
               t.energy_price,
               t.price_status,
               t.apc_flag,
               t.market_suspended_flag,
               t.total_demand,
               t.net_interchange,
               t.scheduled_generation,
               t.semischeduled_generation,
               t.interconnector_flows,
               t.raise_reg_price,
               t.lower_reg_price,
               t.raise_1sec_price,
               t.raise_6sec_price,
               t.raise_60sec_price,
               t.raise_5min_price,
               t.lower_1sec_price,
               t.lower_6sec_price,
               t.lower_60sec_price,
               t.lower_5min_price
        FROM market_interval_data t
        JOIN (
          SELECT regionid, MAX(settlement_ts) AS max_ts
          FROM market_interval_data
          WHERE market_name = 'NEM'
          GROUP BY regionid
        ) sub ON t.regionid = sub.regionid AND t.settlement_ts = sub.max_ts
        WHERE t.market_name = 'NEM'
      `;
      const values: string[] = [];
      if (regionParam) {
        query += " AND t.regionid = ?";
        values.push(regionParam);
      }
      query += ` ORDER BY t.settlement_ts DESC LIMIT ? OFFSET ?`;
      values.push(limit.toString(), offset.toString());

      this.log("DEBUG", `queryLatestRecords: Final SQL="${query.trim()}"`);
      this.log("DEBUG", `queryLatestRecords: Values=${JSON.stringify(values)}`);

      const resultCursor = this.sql.exec<MarketIntervalRecord>(query, ...values);
      const rowArr = resultCursor.toArray();
      const rowCount = rowArr.length;

      const transformed = rowArr.map((row) => ({
        settlement: row.settlement_ts == null
          ? null
          : new Date(row.settlement_ts).toISOString(),
        regionid: row.regionid,
        region: row.region,
        market_name: row.market_name,
        energy_price: row.energy_price,
        price_status: row.price_status,
        apc_flag: row.apc_flag,
        market_suspended_flag: row.market_suspended_flag,
        total_demand: row.total_demand,
        net_interchange: row.net_interchange,
        scheduled_generation: row.scheduled_generation,
        semischeduled_generation: row.semischeduled_generation,
        interconnector_flows: row.interconnector_flows,
        raise_reg_price: row.raise_reg_price,
        lower_reg_price: row.lower_reg_price,
        raise_1sec_price: row.raise_1sec_price,
        raise_6sec_price: row.raise_6sec_price,
        raise_60sec_price: row.raise_60sec_price,
        raise_5min_price: row.raise_5min_price,
        lower_1sec_price: row.lower_1sec_price,
        lower_6sec_price: row.lower_6sec_price,
        lower_60sec_price: row.lower_60sec_price,
        lower_5min_price: row.lower_5min_price,
      }));

      const resp = new Response(JSON.stringify(transformed), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

      const pageNumber = Math.floor(offset / limit) + 1;
      const totalPages = Math.ceil(totalCount / limit);

      resp.headers.set("X-Page", pageNumber.toString());
      resp.headers.set("X-Limit", limit.toString());
      resp.headers.set("X-Total-Count", totalCount.toString());
      resp.headers.set("X-Total-Pages", totalPages.toString());
      resp.headers.set("X-Has-Next-Page", (pageNumber < totalPages).toString());

      return resp;
    } catch (err) {
      this.log("ERROR", `queryLatestRecords error => ${String(err)}`);
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /**
   * parseLocalBrisbaneMs => forcibly appends +10:00 if no timezone found,
   * then parse. Returns ms or NaN if parse fails.
   */
  private parseLocalBrisbaneMs(dateStr: string): number {
    const hasOffsetRegex = /[Zz]|[\+\-]\d{2}:?\d{2}(\s*\(.*\))?$/;
    let adjusted = (dateStr || "").trim();
    if (!hasOffsetRegex.test(adjusted)) {
      adjusted += "+10:00"; // Assume Brisbane time
    }

    const ms = Date.parse(adjusted);
    if (Number.isNaN(ms)) {
      this.log(
        "ERROR",
        `parseLocalBrisbaneMs: parse failed => original="${dateStr}", adjusted="${adjusted}"`
      );
      return NaN;
    }
    return ms;
  }

  /**
   * parseHeaders => parse from environment to Record<string, string>, ignoring errors.
   */
  private parseHeaders(raw: string): Record<string, string> {
    try {
      return raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return {};
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