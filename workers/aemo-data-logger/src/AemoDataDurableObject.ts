/**
 * @fileoverview Durable Object that stores electricity market intervals (initially AEMO's NEM data),
 * including energy price, FCAS components, demand, and other information needed for future retail
 * price calculations. The table schema is designed to be non-AEMO specific, so it can be extended
 * to other markets (e.g. WEM, WA, NT, etc.).
 *
 * Endpoints:
 *   • POST /sync — Fetches ELEC_NEM_SUMMARY (energy/demand) and ELEC_NEM_SUMMARY_PRICES (FCAS) from
 *       the AEMO endpoints, merges them, then stores them in the DB.
 *   • GET /range — Retrieves stored intervals with optional paging/filters.
 *   • POST /testInsertThenRead — Simple debug route: inserts a sample row, then queries it back.
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

/**
 * Environment definition for the AemoData Durable Object, matching the TOML-defined
 * variables for forming AEMO endpoints (AEMO_API_URL, AEMO_DATA_SUMMARY, etc.).
 * References to AEMO headers have been removed—this example does not dynamically
 * set them, as the user specifically requested to omit them.
 */
export interface AemoDataEnv {
  /**
   * Base URL for the AEMO data service, e.g.:
   *   "https://visualisations.aemo.com.au/aemo/apps/api/report"
   */
  AEMO_API_URL: string;

  /**
   * Data set identifiers for AEMO:
   *   e.g. "ELEC_NEM_SUMMARY", "ELEC_NEM_SUMMARY_PRICES", etc.
   */
  AEMO_DATA_SUMMARY: string;            // e.g. "ELEC_NEM_SUMMARY"
  AEMO_DATA_SUMMARY_PRICES: string;     // e.g. "ELEC_NEM_SUMMARY_PRICES"
  AEMO_DATA_SUMMARY_MARKET_NOTICE?: string; 
  AEMO_DATA_5MIN?: string;            
  AEMO_DATA_CUMUL_PRICE?: string;      

  /**
   * Optional environment-based log level: "DEBUG", "INFO", "WARN", or "ERROR".
   */
  LOG_LEVEL?: string;
}

/**
 * Row schema for "market_interval_data". Using ms-based timestamps for settlement,
 * plus region, demand, net interchange, plus 10 FCAS fields for future calculations.
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
 * Combined data from ELEC_NEM_SUMMARY & ELEC_NEM_SUMMARY_PRICES, with
 * further expansions for additional markets if needed.
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

/**
 * AemoData Durable Object: merges intervals from AEMO's summary and prices endpoints and
 * stores them. Also provides read endpoints for data retrieval, plus a debug route.
 */
export class AemoData implements DurableObject {
  private readonly sql: SqlStorage;
  private readonly env: AemoDataEnv;
  private readonly logLevel: number;

  constructor(private readonly state: DurableObjectState, env: AemoDataEnv) {
    this.sql = state.storage.sql;
    this.env = env;
    this.logLevel = getLogPriority(env.LOG_LEVEL ?? "WARN");

    // Initialize DB if needed
    try {
      this.log("DEBUG", "Checking existence of market_interval_data table.");
      this.sql.exec("SELECT 1 FROM market_interval_data LIMIT 1;");
      this.log("DEBUG", "Table market_interval_data verified to exist.");
    } catch (err) {
      this.log("INFO", `Creating DB table & indexes: ${String(err)}`);
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

    this.log("INFO", `AemoData DO created. LOG_LEVEL="${env.LOG_LEVEL ?? "WARN"}".`);
  }

  /**
   * Router for incoming fetch requests.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.log("DEBUG", `Method=${request.method}, Path=${url.pathname}`);

    if (request.method === "POST" && url.pathname === "/sync") {
      return this.handleSync();
    } else if (request.method === "GET" && url.pathname === "/range") {
      return this.handleRangeRequest(url);
    } else if (request.method === "POST" && url.pathname === "/testInsertThenRead") {
      return this.handleTestInsertThenRead();
    }

    return new Response("Not Found", { status: 404 });
  }

  /**
   * handleSync - fetches ELEC_NEM_SUMMARY and ELEC_NEM_SUMMARY_PRICES from
   * their respective endpoints, merges them by region, and stores them in DB.
   */
  private async handleSync(): Promise<Response> {
    this.log("INFO", "Starting sync from AEMO endpoints for summary & prices...");

    const summaryUrl = `${this.env.AEMO_API_URL}/${this.env.AEMO_DATA_SUMMARY}`;
    const pricesUrl = `${this.env.AEMO_API_URL}/${this.env.AEMO_DATA_SUMMARY_PRICES}`;

    let summaryData: unknown;
    let pricesData: unknown;

    // Fetch ELEC_NEM_SUMMARY
    try {
      this.log("DEBUG", `Fetching summary from: ${summaryUrl}`);
      const summaryResp = await fetch(summaryUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json"
        }
      });
      if (!summaryResp.ok) {
        throw new Error(`Failure from summary endpoint. status=${summaryResp.status}`);
      }
      summaryData = await summaryResp.json();
    } catch (err) {
      const msg = `Summary fetch failed => ${String(err)}`;
      this.log("ERROR", msg);
      return new Response(msg, { status: 500 });
    }

    // Fetch ELEC_NEM_SUMMARY_PRICES
    try {
      this.log("DEBUG", `Fetching summary prices from: ${pricesUrl}`);
      const pricesResp = await fetch(pricesUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json"
        }
      });
      if (!pricesResp.ok) {
        throw new Error(`Failure from summary-prices endpoint. status=${pricesResp.status}`);
      }
      pricesData = await pricesResp.json();
    } catch (err) {
      const msg = `SummaryPrices fetch failed => ${String(err)}`;
      this.log("ERROR", msg);
      return new Response(msg, { status: 500 });
    }

    // Combine data
    const data = {
      ELEC_NEM_SUMMARY: Array.isArray(summaryData) ? summaryData : [],
      ELEC_NEM_SUMMARY_PRICES: Array.isArray(pricesData) ? pricesData : []
    };
    if (!data.ELEC_NEM_SUMMARY.length || !data.ELEC_NEM_SUMMARY_PRICES.length) {
      const msg = "Merged data missing arrays or found empty arrays for summary/prices.";
      this.log("WARN", msg);
      return new Response(msg, { status: 200 });
    }

    // Build mapping from ELEC_NEM_SUMMARY_PRICES => region => FCAS data
    const fcasMap = new Map<string, any>();
    for (const item of data.ELEC_NEM_SUMMARY_PRICES) {
      const region = String((item as any).REGIONID || "").trim();
      if (region) {
        fcasMap.set(region, item);
      }
    }

    // Merge the summary intervals with FCAS info
    const combinedRows: CombinedIntervalRow[] = [];
    for (const s of data.ELEC_NEM_SUMMARY) {
      const regionid = String((s as any).REGIONID || "").trim();
      if (!regionid) continue;

      const settlementMs = this.parseLocalBrisbaneMs((s as any).SETTLEMENTDATE);
      if (Number.isNaN(settlementMs)) {
        this.log("ERROR", `Invalid SETTLEMENTDATE => "${(s as any).SETTLEMENTDATE}"`);
        continue;
      }

      const fc = fcasMap.get(regionid) || {};
      combinedRows.push({
        settlement_ts: settlementMs,
        regionid,
        region: regionid,
        market_name: "NEM",
        energy_price: (s as any).PRICE ?? null,
        price_status: (s as any).PRICE_STATUS ?? null,
        apc_flag: (s as any).APCFLAG ?? null,
        market_suspended_flag: (s as any).MARKETSUSPENDEDFLAG ?? null,
        total_demand: (s as any).TOTALDEMAND ?? null,
        net_interchange: (s as any).NETINTERCHANGE ?? null,
        scheduled_generation: (s as any).SCHEDULEDGENERATION ?? null,
        semischeduled_generation: (s as any).SEMISCHEDULEDGENERATION ?? null,
        interconnector_flows: (s as any).INTERCONNECTORFLOWS ?? null,

        raise_reg_price: fc.RAISEREGRRP ?? null,
        lower_reg_price: fc.LOWERREGRRP ?? null,
        raise_1sec_price: fc.RAISE1SECRRP ?? null,
        raise_6sec_price: fc.RAISE6SECRRP ?? null,
        raise_60sec_price: fc.RAISE60SECRRP ?? null,
        raise_5min_price: fc.RAISE5MINRRP ?? null,
        lower_1sec_price: fc.LOWER1SECRRP ?? null,
        lower_6sec_price: fc.LOWER6SECRRP ?? null,
        lower_60sec_price: fc.LOWER60SECRRP ?? null,
        lower_5min_price: fc.LOWER5MINRRP ?? null
      });
    }

    if (!combinedRows.length) {
      const msg = "No intervals found after merging ELEC_NEM_SUMMARY with ELEC_NEM_SUMMARY_PRICES.";
      this.log("WARN", msg);
      return new Response(msg, { status: 200 });
    }

    // We want to deduplicate based on settlement_ts, regionid, market_name
    let earliest = combinedRows[0].settlement_ts;
    let latest = combinedRows[0].settlement_ts;
    for (const row of combinedRows) {
      if (row.settlement_ts < earliest) earliest = row.settlement_ts;
      if (row.settlement_ts > latest) latest = row.settlement_ts;
    }
    const regionIds = [...new Set(combinedRows.map(r => r.regionid))];
    if (!regionIds.length) {
      const msg = "No valid region IDs found in merged intervals.";
      this.log("WARN", msg);
      return new Response(msg, { status: 200 });
    }

    const placeholders = regionIds.map(() => "?").join(", ");
    const sqlQuery = `
      SELECT settlement_ts, regionid, market_name
      FROM market_interval_data
      WHERE settlement_ts >= ?
        AND settlement_ts <= ?
        AND regionid IN (${placeholders})
        AND market_name = 'NEM'
    `;
    const existingRows = this.sql.exec(sqlQuery, earliest, latest, ...regionIds).toArray();
    const existingKeys = new Set<string>();
    for (const row of existingRows) {
      existingKeys.add(`${row.settlement_ts}-${row.regionid}-${row.market_name}`);
    }

    // Filter out existing ones
    const toInsert = combinedRows.filter(r => {
      const key = `${r.settlement_ts}-${r.regionid}-${r.market_name}`;
      return !existingKeys.has(key);
    });

    let insertedCount = 0;
    for (const r of toInsert) {
      const res = this.sql.exec(`
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
      insertedCount += res.rowsWritten;
    }

    const msg = `Completed sync. intervalsParsed=${combinedRows.length}, newlyInserted=${insertedCount}`;
    this.log("INFO", msg);
    return new Response(msg, { status: 200 });
  }

  /**
   * GET /range => retrieves data within a time window (or lastSec).
   */
  private async handleRangeRequest(url: URL): Promise<Response> {
    try {
      let limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
      let offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
      if (Number.isNaN(limit) || limit <= 0) limit = 100;
      if (Number.isNaN(offset) || offset < 0) offset = 0;

      const lastSecParam = url.searchParams.get("lastSec");
      const startParam = url.searchParams.get("start");
      const endParam = url.searchParams.get("end");
      const regionParam = url.searchParams.get("regionid");
      const nowMs = Date.now();

      // lastSec overrides start/end
      if (lastSecParam) {
        if (startParam || endParam) {
          return new Response(
            JSON.stringify({ error: "Cannot combine lastSec with start or end." }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        const lastSec = Number.parseInt(lastSecParam, 10);
        if (Number.isNaN(lastSec) || lastSec <= 0) {
          return new Response(
            JSON.stringify({ error: "Invalid lastSec." }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        if (lastSec > 604800) {
          return new Response(
            JSON.stringify({ error: "Requested range too large." }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        const from = nowMs - lastSec * 1000;
        const to = nowMs;
        return this.queryRange(from, to, regionParam, false, limit, offset);
      }

      // If start/end => both required
      if (startParam || endParam) {
        if (!startParam || !endParam) {
          return new Response(
            JSON.stringify({ error: "Must supply both start and end or neither." }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        const startMs = Number.parseInt(startParam, 10);
        const endMs = Number.parseInt(endParam, 10);
        if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
          return new Response(
            JSON.stringify({ error: "Invalid start or end." }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        if (endMs < startMs) {
          return new Response(
            JSON.stringify({ error: "end must be >= start." }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        if (endMs - startMs > 604800000) {
          return new Response(
            JSON.stringify({ error: "Requested range too large." }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        return this.queryRange(startMs, endMs, regionParam, true, limit, offset);
      }

      // No param => fetch most recent record for each region
      return this.queryLatestRecords(regionParam, limit, offset);

    } catch (err) {
      return new Response(
        JSON.stringify({ error: String(err) }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }
  }

  /**
   * Debug route: /testInsertThenRead => inserts a row, then queries the top 5.
   */
  private async handleTestInsertThenRead(): Promise<Response> {
    try {
      const uniqueTs = Date.now() + Math.floor(Math.random() * 100000);
      this.sql.exec(`
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
        "DEBUG_MANUAL",
        "DEBUG_MANUAL",
        "NEM",
        999.99,
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

      const resultArr = this.sql.exec<MarketIntervalRecord>(`
        SELECT settlement_ts, regionid, region, market_name, energy_price, price_status
        FROM market_interval_data
        ORDER BY settlement_ts DESC
        LIMIT 5
      `).toArray();

      const rows = resultArr.map(r => ({
        settlement: r.settlement_ts ? new Date(r.settlement_ts).toISOString() : null,
        regionid: r.regionid,
        region: r.region,
        market_name: r.market_name,
        energy_price: r.energy_price,
        price_status: r.price_status
      }));

      return new Response(JSON.stringify({
        message: "Inserted a row; top 5 rows by settlement_ts:",
        inserted: new Date(uniqueTs).toISOString(),
        rows
      }), { status: 200, headers: { "content-type": "application/json" } });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: String(err) }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }
  }

  /**
   * queryRange: returns rows in [startMs..endMs], optionally filtering by region,
   * ordered ascending/descending. Returns JSON plus pagination headers.
   */
  private queryRange(
    startMs: number,
    endMs: number,
    regionParam: string | null | undefined,
    asc: boolean,
    limit: number,
    offset: number
  ): Response {
    try {
      // Count query
      let countSql = `
        SELECT COUNT(*) as total_count
        FROM market_interval_data
        WHERE settlement_ts >= ? AND settlement_ts <= ?
          AND market_name = 'NEM'
      `;
      const countVals: (number | string)[] = [startMs, endMs];
      if (regionParam) {
        countSql += ` AND regionid = ?`;
        countVals.push(regionParam);
      }

      const countArr = this.sql.exec<{ total_count: number }>(countSql, ...countVals).toArray();
      let totalCount = 0;
      if (countArr.length > 0 && typeof countArr[0].total_count === "number") {
        totalCount = countArr[0].total_count;
      }

      // Data query
      const orderBy = asc ? "ASC" : "DESC";
      let mainSql = `
        SELECT settlement_ts, regionid, region, market_name,
               energy_price, price_status, apc_flag, market_suspended_flag,
               total_demand, net_interchange, scheduled_generation,
               semischeduled_generation, interconnector_flows,
               raise_reg_price, lower_reg_price,
               raise_1sec_price, raise_6sec_price, raise_60sec_price,
               raise_5min_price, lower_1sec_price,
               lower_6sec_price, lower_60sec_price, lower_5min_price
        FROM market_interval_data
        WHERE settlement_ts >= ? AND settlement_ts <= ?
          AND market_name = 'NEM'
      `;
      const mainVals: (number | string)[] = [startMs, endMs];
      if (regionParam) {
        mainSql += ` AND regionid = ?`;
        mainVals.push(regionParam);
      }
      mainSql += ` ORDER BY settlement_ts ${orderBy} LIMIT ? OFFSET ?`;
      mainVals.push(limit, offset);

      const rows = this.sql.exec<MarketIntervalRecord>(mainSql, ...mainVals).toArray();

      const mapped = rows.map(r => ({
        settlement: r.settlement_ts ? new Date(r.settlement_ts).toISOString() : null,
        regionid: r.regionid,
        region: r.region,
        market_name: r.market_name,
        energy_price: r.energy_price,
        price_status: r.price_status,
        apc_flag: r.apc_flag,
        market_suspended_flag: r.market_suspended_flag,
        total_demand: r.total_demand,
        net_interchange: r.net_interchange,
        scheduled_generation: r.scheduled_generation,
        semischeduled_generation: r.semischeduled_generation,
        interconnector_flows: r.interconnector_flows,
        raise_reg_price: r.raise_reg_price,
        lower_reg_price: r.lower_reg_price,
        raise_1sec_price: r.raise_1sec_price,
        raise_6sec_price: r.raise_6sec_price,
        raise_60sec_price: r.raise_60sec_price,
        raise_5min_price: r.raise_5min_price,
        lower_1sec_price: r.lower_1sec_price,
        lower_6sec_price: r.lower_6sec_price,
        lower_60sec_price: r.lower_60sec_price,
        lower_5min_price: r.lower_5min_price
      }));

      // Pagination
      const resp = new Response(JSON.stringify(mapped), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
      const pageNumber = Math.floor(offset / limit) + 1;
      const totalPages = Math.ceil(totalCount / limit);

      resp.headers.set("X-Page", pageNumber.toString());
      resp.headers.set("X-Limit", limit.toString());
      resp.headers.set("X-Total-Count", totalCount.toString());
      resp.headers.set("X-Total-Pages", totalPages.toString());
      resp.headers.set("X-Has-Next-Page", String(pageNumber < totalPages));

      return resp;
    } catch (err) {
      return new Response(
        JSON.stringify({ error: String(err) }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }
  }

  /**
   * queryLatestRecords: returns the most recent record for each region
   * (or only one region if specified), in descending date order. Also uses
   * pagination headers.
   */
  private queryLatestRecords(
    regionParam: string | null | undefined,
    limit: number,
    offset: number
  ): Response {
    try {
      // Counting
      let countSql = `
        SELECT COUNT(*) as total_count FROM (
          SELECT regionid, settlement_ts
          FROM market_interval_data t
          JOIN (
            SELECT regionid AS sub_region, MAX(settlement_ts) AS sub_max
            FROM market_interval_data
            WHERE market_name = 'NEM'
            GROUP BY regionid
          ) sub ON t.regionid = sub.sub_region AND t.settlement_ts = sub.sub_max
          WHERE t.market_name = 'NEM'
      `;
      const countVals: string[] = [];
      if (regionParam) {
        countSql += ` AND t.regionid = ?`;
        countVals.push(regionParam);
      }
      countSql += ` ) alias`;

      const countArr = this.sql.exec<{ total_count: number }>(countSql, ...countVals).toArray();
      let totalCount = 0;
      if (countArr.length && typeof countArr[0].total_count === "number") {
        totalCount = countArr[0].total_count;
      }

      // Fetch data
      let mainSql = `
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
          SELECT regionid AS sub_region, MAX(settlement_ts) AS sub_max
          FROM market_interval_data
          WHERE market_name = 'NEM'
          GROUP BY regionid
        ) sub ON t.regionid = sub.sub_region AND t.settlement_ts = sub.sub_max
        WHERE t.market_name = 'NEM'
      `;
      const mainVals: string[] = [];
      if (regionParam) {
        mainSql += " AND t.regionid = ?";
        mainVals.push(regionParam);
      }
      mainSql += " ORDER BY t.settlement_ts DESC LIMIT ? OFFSET ?";
      mainVals.push(limit.toString(), offset.toString());

      const rowArr = this.sql.exec<MarketIntervalRecord>(mainSql, ...mainVals).toArray();
      const mapped = rowArr.map(r => ({
        settlement: r.settlement_ts ? new Date(r.settlement_ts).toISOString() : null,
        regionid: r.regionid,
        region: r.region,
        market_name: r.market_name,
        energy_price: r.energy_price,
        price_status: r.price_status,
        apc_flag: r.apc_flag,
        market_suspended_flag: r.market_suspended_flag,
        total_demand: r.total_demand,
        net_interchange: r.net_interchange,
        scheduled_generation: r.scheduled_generation,
        semischeduled_generation: r.semischeduled_generation,
        interconnector_flows: r.interconnector_flows,
        raise_reg_price: r.raise_reg_price,
        lower_reg_price: r.lower_reg_price,
        raise_1sec_price: r.raise_1sec_price,
        raise_6sec_price: r.raise_6sec_price,
        raise_60sec_price: r.raise_60sec_price,
        raise_5min_price: r.raise_5min_price,
        lower_1sec_price: r.lower_1sec_price,
        lower_6sec_price: r.lower_6sec_price,
        lower_60sec_price: r.lower_60sec_price,
        lower_5min_price: r.lower_5min_price
      }));

      const resp = new Response(JSON.stringify(mapped), {
        status: 200,
        headers: { "content-type": "application/json" }
      });

      // Pagination
      const pageNumber = Math.floor(offset / limit) + 1;
      const totalPages = Math.ceil(totalCount / limit);

      resp.headers.set("X-Page", pageNumber.toString());
      resp.headers.set("X-Limit", limit.toString());
      resp.headers.set("X-Total-Count", totalCount.toString());
      resp.headers.set("X-Total-Pages", totalPages.toString());
      resp.headers.set("X-Has-Next-Page", String(pageNumber < totalPages));

      return resp;
    } catch (err) {
      return new Response(
        JSON.stringify({ error: String(err) }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }
  }

  /**
   * parseLocalBrisbaneMs => forcibly appends +10:00 if no timezone found, then parse.
   * Returns ms or NaN if parse fails. This helps normalise settlement times from AEMO,
   * which are often displayed in local time.
   */
  private parseLocalBrisbaneMs(dateStr: string): number {
    const trimmed = (dateStr || "").trim();
    const hasOffsetRegex = /[Zz]|[\+\-]\d{2}:?\d{2}/;
    const withOffset = hasOffsetRegex.test(trimmed) ? trimmed : `${trimmed}+10:00`;
    const ms = Date.parse(withOffset);
    if (Number.isNaN(ms)) {
      this.log("ERROR", `parseLocalBrisbaneMs failed. input="${dateStr}" => appended="${withOffset}"`);
      return NaN;
    }
    return ms;
  }

  /**
   * Logging wrapper => logs if level is within threshold.
   */
  private log(level: LogLevel, msg: string): void {
    if (getLogPriority(level) >= this.logLevel) {
      console.log(`[${level}] ${msg}`);
    }
  }
}