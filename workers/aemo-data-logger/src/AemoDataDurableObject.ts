/**
 * @fileoverview Durable Object that stores electricity market intervals from AEMO's API.
 * The table schema is kept generic to accommodate expansions (e.g., other markets or additional fields).
 *
 * Endpoints:  
 *   1. POST /sync  
 *      - Fetches from AEMO_DATA_SUMMARY (e.g. "ELEC_NEM_SUMMARY"),  
 *      - Fetches from AEMO_DATA_5MIN (e.g. "5MIN") with AEMO_DATA_5MIN_BODY (JSON),  
 *      - Fetches from AEMO_DATA_CUMUL_PRICE (e.g. "NEM_DASHBOARD_CUMUL_PRICE").  
 *      - Stores each dataset separately in the same table, tagged by market_name or a relevant field.  
 *   2. GET /range  
 *      - Retrieves intervals from the table with optional filters: lastSec, start/end, regionid, paging.  
 *   3. POST /testInsertThenRead  
 *      - Debug route: inserts a simple row, then queries back.  
 *
 * No dynamic headers are included—this code uses simple JSON requests.
 */

import type {
  DurableObjectState,
  DurableObject,
  SqlStorage,
  SqlStorageValue,
} from "@cloudflare/workers-types";

/** Log levels in ascending severity order. */
type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "NONE";

/** Converts a log level string into a numeric priority. */
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
 * Defines the environment variables as specified in the TOML:
 *   - AEMO_API_URL: Base URL (e.g. "https://visualisations.aemo.com.au/aemo/apps/api/report")
 *   - AEMO_DATA_SUMMARY: e.g. "ELEC_NEM_SUMMARY"
 *   - AEMO_DATA_5MIN: e.g. "5MIN"
 *   - AEMO_DATA_5MIN_BODY: e.g. '{"timeScale":["30MIN"]}'
 *   - AEMO_DATA_CUMUL_PRICE: e.g. "NEM_DASHBOARD_CUMUL_PRICE"
 *   - LOG_LEVEL: optional
 *
 */
export interface AemoDataEnv {
  AEMO_API_URL: string;
  AEMO_DATA_SUMMARY: string;
  AEMO_DATA_5MIN: string;     
  AEMO_DATA_5MIN_BODY: string;
  AEMO_DATA_CUMUL_PRICE: string;
  LOG_LEVEL?: string;
}

/**
 * Schema for the table "market_interval_data". Each row includes:
 *   - settlement_ts as ms UTC
 *   - regionid, region, market_name, plus example “price_status” etc.
 * Fields are left flexible to allow extension.
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
 * Minimal example row shape for the data sets we fetch.
 */
interface SimpleIntervalRow {
  settlement_ts: number;
  regionid: string;
  region: string;
  market_name: string;
  energy_price: number | null;
}

/**
 * Durable Object storing intervals from multiple AEMO endpoints,
 */
export class AemoData implements DurableObject {
  private readonly sql: SqlStorage;
  private readonly env: AemoDataEnv;
  private readonly logLevel: number;

  constructor(private readonly state: DurableObjectState, env: AemoDataEnv) {
    this.sql = state.storage.sql;
    this.env = env;
    this.logLevel = getLogPriority(env.LOG_LEVEL ?? "WARN");

    // Check or create DB table
    try {
      this.log("DEBUG", "Checking table existence: market_interval_data");
      this.sql.exec("SELECT 1 FROM market_interval_data LIMIT 1;");
      this.log("DEBUG", "Table market_interval_data exists.");
    } catch (err) {
      this.log("INFO", `Table missing; creating. Error => ${String(err)}`);
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
        CREATE INDEX idx_market_data_ts ON market_interval_data (settlement_ts);
        CREATE INDEX idx_market_data_region ON market_interval_data (regionid, settlement_ts);
      `);
    }

    this.log("INFO", `AemoData DO created. LOG_LEVEL=${env.LOG_LEVEL ?? "WARN"}`);
  }

  /**
   * Routing for fetch requests:
   *   - POST /sync => handleSync
   *   - GET /range => handleRangeRequest
   *   - POST /testInsertThenRead => handleTestInsertThenRead
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.log("DEBUG", `Method=${request.method} Path=${url.pathname}`);

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
   * handleSync:
   *   - Fetches data from AEMO_DATA_SUMMARY (GET)
   *   - Fetches data from AEMO_DATA_5MIN (POST, with body from AEMO_DATA_5MIN_BODY)
   *   - Fetches data from AEMO_DATA_CUMUL_PRICE (GET)
   *   - Stores each dataset in the DB with different market_name or tagging
   */
  private async handleSync(): Promise<Response> {
    this.log("INFO", "Starting sync from AEMO_DATA_SUMMARY, AEMO_DATA_5MIN, AEMO_DATA_CUMUL_PRICE");

    // 1) Fetch from AEMO_DATA_SUMMARY
    const summaryUrl = `${this.env.AEMO_API_URL}/${this.env.AEMO_DATA_SUMMARY}`;
    let summaryData: any[] = [];
    try {
      const resp = await fetch(summaryUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json"
        }
      });
      if (!resp.ok) {
        throw new Error(`AEMO_DATA_SUMMARY fetch failed => status=${resp.status}`);
      }
      const jsonData = await resp.json();
      if (Array.isArray(jsonData)) {
        summaryData = jsonData;
      }
      this.log("DEBUG", `Fetched summary: got ${summaryData.length} record(s)`);
    } catch (err) {
      const msg = `Error fetching AEMO_DATA_SUMMARY => ${(err as Error).message}`;
      this.log("ERROR", msg);
      return new Response(msg, { status: 500 });
    }

    // 2) Fetch from AEMO_DATA_5MIN with a POST body from AEMO_DATA_5MIN_BODY
    const fiveMinUrl = `${this.env.AEMO_API_URL}/${this.env.AEMO_DATA_5MIN}`;
    let fiveMinData: any[] = [];
    try {
      const resp = await fetch(fiveMinUrl, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json"
        },
        body: this.env.AEMO_DATA_5MIN_BODY
      });
      if (!resp.ok) {
        throw new Error(`AEMO_DATA_5MIN fetch failed => status=${resp.status}`);
      }
      const jsonData = await resp.json();
      // Expect possibly an object with "5MIN" array? The user didn't specify exact structure, so store raw
      if (Array.isArray(jsonData)) {
        fiveMinData = jsonData;
      } else if (Array.isArray(jsonData["5MIN"])) {
        fiveMinData = jsonData["5MIN"];
      }
      this.log("DEBUG", `Fetched 5MIN: got ${fiveMinData.length} record(s)`);
    } catch (err) {
      const msg = `Error fetching AEMO_DATA_5MIN => ${(err as Error).message}`;
      this.log("ERROR", msg);
      return new Response(msg, { status: 500 });
    }

    // 3) Fetch from AEMO_DATA_CUMUL_PRICE
    const cumulUrl = `${this.env.AEMO_API_URL}/${this.env.AEMO_DATA_CUMUL_PRICE}`;
    let cumulData: any[] = [];
    try {
      const resp = await fetch(cumulUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json"
        }
      });
      if (!resp.ok) {
        throw new Error(`AEMO_DATA_CUMUL_PRICE fetch failed => status=${resp.status}`);
      }
      const jsonData = await resp.json();
      if (Array.isArray(jsonData)) {
        cumulData = jsonData;
      }
      this.log("DEBUG", `Fetched cumul price: got ${cumulData.length} record(s)`);
    } catch (err) {
      const msg = `Error fetching AEMO_DATA_CUMUL_PRICE => ${(err as Error).message}`;
      this.log("ERROR", msg);
      return new Response(msg, { status: 500 });
    }

    // Store them. We'll store each set with different market_name tags for demonstration.
    const insertedSummary = this.storeIntervals(summaryData, "NEM_SUMMARY");
    const inserted5min = this.storeIntervals(fiveMinData, "NEM_5MIN");
    const insertedCumul = this.storeIntervals(cumulData, "NEM_CUMUL");

    const resultMsg = `Synced data => summaryInserted=${insertedSummary}, fiveMinInserted=${inserted5min}, cumulInserted=${insertedCumul}`;
    this.log("INFO", resultMsg);
    return new Response(resultMsg, { status: 200 });
  }

  /**
   * Helper method to parse and insert intervals into the DB, using a specified market_name tag.
   * In actual usage, you might carefully parse each record's fields. For now, we store minimal data.
   */
  private storeIntervals(data: any[], marketName: string): number {
    let insertedCount = 0;
    for (const record of data) {
      // We'll assume each record has a "REGIONID" and "PRICE" plus a "SETTLEMENTDATE"
      const regionid = String(record.REGIONID || "").trim();
      if (!regionid) {
        continue;
      }
      const settlementMs = this.parseLocalBrisbaneMs(record.SETTLEMENTDATE);
      if (Number.isNaN(settlementMs)) {
        continue;
      }
      // We'll store "energy_price" from "PRICE" if present
      const energyPrice = record.PRICE ?? null;

      // Insert ignoring duplicates
      const res = this.sql.exec(`
        INSERT INTO market_interval_data (
          settlement_ts,
          regionid,
          region,
          market_name,
          energy_price
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (settlement_ts, regionid, market_name)
        DO NOTHING
      `,
      settlementMs,
      regionid,
      regionid,
      marketName,
      energyPrice);

      insertedCount += res.rowsWritten;
    }
    return insertedCount;
  }

  /**
   * GET /range => optional lastSec or start/end => queries intervals with paging.
   */
  private async handleRangeRequest(url: URL): Promise<Response> {
    try {
      let limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
      if (Number.isNaN(limit) || limit <= 0) limit = 100;
      let offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
      if (Number.isNaN(offset) || offset < 0) offset = 0;

      const regionParam = url.searchParams.get("regionid");
      const lastSecParam = url.searchParams.get("lastSec");
      const startParam = url.searchParams.get("start");
      const endParam = url.searchParams.get("end");
      const nowMs = Date.now();

      if (lastSecParam) {
        if (startParam || endParam) {
          return new Response(JSON.stringify({ error: "Cannot combine lastSec with start/end." }),
            { status: 400, headers: { "content-type": "application/json" } });
        }
        const lastSec = Number.parseInt(lastSecParam, 10);
        if (Number.isNaN(lastSec) || lastSec <= 0) {
          return new Response(JSON.stringify({ error: "Invalid lastSec." }),
            { status: 400, headers: { "content-type": "application/json" } });
        }
        if (lastSec > 604800) {
          return new Response(JSON.stringify({ error: "Requested range too large." }),
            { status: 400, headers: { "content-type": "application/json" } });
        }
        const from = nowMs - lastSec * 1000;
        return this.queryRange(from, nowMs, regionParam, false, limit, offset);
      }

      if (startParam || endParam) {
        if (!startParam || !endParam) {
          return new Response(JSON.stringify({ error: "Must provide both start/end or neither." }),
            { status: 400, headers: { "content-type": "application/json" } });
        }
        const startMs = Number.parseInt(startParam, 10);
        const endMs = Number.parseInt(endParam, 10);
        if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
          return new Response(JSON.stringify({ error: "Invalid start or end." }),
            { status: 400, headers: { "content-type": "application/json" } });
        }
        if (endMs < startMs) {
          return new Response(JSON.stringify({ error: "end must be >= start." }),
            { status: 400, headers: { "content-type": "application/json" } });
        }
        if (endMs - startMs > 604800000) {
          return new Response(JSON.stringify({ error: "Requested range too large." }),
            { status: 400, headers: { "content-type": "application/json" } });
        }
        return this.queryRange(startMs, endMs, regionParam, true, limit, offset);
      }

      // No param => fetch latest for each region
      return this.queryLatestRecords(regionParam, limit, offset);

    } catch (err) {
      const msg = `handleRangeRequest => ${String(err)}`;
      this.log("ERROR", msg);
      return new Response(JSON.stringify({ error: msg }),
        { status: 500, headers: { "content-type": "application/json" } });
    }
  }

  /**
   * Debug route: /testInsertThenRead => inserts a row, then queries top 5.
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
          energy_price
        )
        VALUES (?, ?, ?, ?, ?)
      `,
      uniqueTs,
      "DEBUG_REGION",
      "DEBUG_REGION",
      "DEBUG_TEST",
      999.99);

      const rows = this.sql.exec<MarketIntervalRecord>(`
        SELECT settlement_ts, regionid, region, market_name, energy_price
        FROM market_interval_data
        ORDER BY settlement_ts DESC
        LIMIT 5
      `).toArray();

      const mapped = rows.map(r => ({
        settlement: r.settlement_ts ? new Date(r.settlement_ts).toISOString() : null,
        regionid: r.regionid,
        region: r.region,
        market_name: r.market_name,
        energy_price: r.energy_price
      }));

      return new Response(JSON.stringify({
        message: "Inserted debug row, now reading top 5 by settlement_ts:",
        inserted: new Date(uniqueTs).toISOString(),
        rows: mapped
      }), { status: 200, headers: { "content-type": "application/json" } });
    } catch (err) {
      const msg = `testInsertThenRead => ${String(err)}`;
      this.log("ERROR", msg);
      return new Response(JSON.stringify({ error: msg }),
        { status: 500, headers: { "content-type": "application/json" } });
    }
  }

  /**
   * queryRange => returns intervals in [startMs..endMs], optional region filter,
   * ordering asc/desc. Appends pagination headers. market_name = 'NEM' is not forced
   * here, since we store multiple sets (NEM_SUMMARY, NEM_5MIN, etc.).
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
      // Count
      let countSql = `
        SELECT COUNT(*) as total_count
        FROM market_interval_data
        WHERE settlement_ts >= ? AND settlement_ts <= ?
      `;
      const countVals: (number | string)[] = [startMs, endMs];
      if (regionParam) {
        countSql += ` AND regionid = ?`;
        countVals.push(regionParam);
      }

      const countArr = this.sql.exec<{ total_count: number }>(countSql, ...countVals).toArray();
      let totalCount = 0;
      if (countArr.length && typeof countArr[0].total_count === "number") {
        totalCount = countArr[0].total_count;
      }

      // Data
      const orderBy = asc ? "ASC" : "DESC";
      let query = `
        SELECT settlement_ts, regionid, region, market_name, energy_price
        FROM market_interval_data
        WHERE settlement_ts >= ? AND settlement_ts <= ?
      `;
      const vals: (number | string)[] = [startMs, endMs];
      if (regionParam) {
        query += ` AND regionid = ?`;
        vals.push(regionParam);
      }
      query += ` ORDER BY settlement_ts ${orderBy} LIMIT ? OFFSET ?`;
      vals.push(limit, offset);

      const rows = this.sql.exec<SimpleIntervalRow>(query, ...vals).toArray();

      const mapped = rows.map(r => ({
        settlement: r.settlement_ts ? new Date(r.settlement_ts).toISOString() : null,
        regionid: r.regionid,
        region: r.region,
        market_name: r.market_name,
        energy_price: r.energy_price
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
      const msg = `queryRange => ${String(err)}`;
      this.log("ERROR", msg);
      return new Response(JSON.stringify({ error: msg }),
        { status: 500, headers: { "content-type": "application/json" } });
    }
  }

  /**
   * queryLatestRecords => fetches the single most recent interval for each region,
   * or only for one region if provided. This is an example approach if you want
   * the latest snapshot rather than a range.
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
          SELECT regionid
          FROM market_interval_data t
          JOIN (
            SELECT regionid AS sub_region, MAX(settlement_ts) AS sub_max
            FROM market_interval_data
            GROUP BY regionid
          ) sub ON t.regionid = sub.sub_region AND t.settlement_ts = sub.sub_max
      `;
      const countVals: string[] = [];
      if (regionParam) {
        countSql += ` WHERE t.regionid = ?`;
        countVals.push(regionParam);
      }
      countSql += ` ) alias`;

      const countArr = this.sql.exec<{ total_count: number }>(countSql, ...countVals).toArray();
      let totalCount = 0;
      if (countArr.length && typeof countArr[0].total_count === "number") {
        totalCount = countArr[0].total_count;
      }

      // Data
      let query = `
        SELECT t.settlement_ts, t.regionid, t.region, t.market_name, t.energy_price
        FROM market_interval_data t
        JOIN (
          SELECT regionid AS sub_region, MAX(settlement_ts) AS sub_max
          FROM market_interval_data
          GROUP BY regionid
        ) sub ON t.regionid = sub.sub_region AND t.settlement_ts = sub.sub_max
      `;
      const vals: string[] = [];
      if (regionParam) {
        query += " WHERE t.regionid = ?";
        vals.push(regionParam);
      }
      query += ` ORDER BY t.settlement_ts DESC LIMIT ? OFFSET ?`;
      vals.push(limit.toString(), offset.toString());

      const rows = this.sql.exec<SimpleIntervalRow>(query, ...vals).toArray();
      const mapped = rows.map(r => ({
        settlement: r.settlement_ts ? new Date(r.settlement_ts).toISOString() : null,
        regionid: r.regionid,
        region: r.region,
        market_name: r.market_name,
        energy_price: r.energy_price
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
      const msg = `queryLatestRecords => ${String(err)}`;
      this.log("ERROR", msg);
      return new Response(JSON.stringify({ error: msg }),
        { status: 500, headers: { "content-type": "application/json" } });
    }
  }

  /**
   * parseLocalBrisbaneMs => forcibly appends +10:00 if no timezone found, then parse.
   * Returns ms or NaN if parse fails. 
   */
  private parseLocalBrisbaneMs(dateStr: string): number {
    const raw = (dateStr ?? "").trim();
    const offsetRegex = /[Zz]|[\+\-]\d{2}:?\d{2}/;
    const final = offsetRegex.test(raw) ? raw : `${raw}+10:00`;
    const ms = Date.parse(final);
    if (Number.isNaN(ms)) {
      this.log("ERROR", `parseLocalBrisbaneMs => cannot parse dateStr="${dateStr}" => withOffset="${final}"`);
      return NaN;
    }
    return ms;
  }

  /**
   * Logging helper => prints if log level is within threshold.
   */
  private log(level: LogLevel, msg: string): void {
    if (getLogPriority(level) >= this.logLevel) {
      console.log(`[${level}] ${msg}`);
    }
  }
}