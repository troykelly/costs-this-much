/**
 * @fileoverview Durable Object that regularly fetches ELEC_NEM_SUMMARY data (including FCAS info
 * from the same JSON response) and stores it in a generic table for future retail pricing calculations.
 *
 * Endpoints:
 *  - POST /sync
 *    --> Fetches JSON from `${AEMO_API_URL}/${AEMO_DATA_SUMMARY}` which is expected to include:
 *        {
 *          "ELEC_NEM_SUMMARY": [...],
 *          "ELEC_NEM_SUMMARY_PRICES": [...],
 *          "ELEC_NEM_SUMMARY_MARKET_NOTICE": [...]
 *        }
 *    --> Merges data from ELEC_NEM_SUMMARY (energy/demand) with FCAS fields from ELEC_NEM_SUMMARY_PRICES
 *        by matching region IDs. Stores combined intervals in "market_interval_data".
 *  - GET /range
 *    --> Retrieves stored intervals with optional filters (lastSec, start/end, regionid) plus paging.
 *  - POST /testInsertThenRead
 *    --> Inserts a sample debug row, then queries it back.
 *
 * Note: The user specifically wishes to remove references to AEMO_DATA_SUMMARY_PRICES in the config.
 *       However, the response from the single endpoint (ELEC_NEM_SUMMARY) also includes
 *       "ELEC_NEM_SUMMARY_PRICES" in the JSON. We simply parse that from the returned data,
 *       merging the values as FCAS fields (e.g. RAISEREGRRP => raise_reg_price).
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
 * Environment definition for the AemoData Durable Object, referencing the TOML variables:
 *  - AEMO_API_URL (e.g. https://visualisations.aemo.com.au/aemo/apps/api/report)
 *  - AEMO_DATA_SUMMARY (e.g. "ELEC_NEM_SUMMARY")
 *  - LOG_LEVEL (optional)
 *
 * The user has requested removing references to AEMO_DATA_SUMMARY_PRICES in the environment,
 * but the returned data from the single endpoint also includes FCAS info in "ELEC_NEM_SUMMARY_PRICES."
 * We will parse that from the returned JSON and merge it without a separate environment variable.
 */
export interface AemoDataEnv {
  /**
   * Base URL for the AEMO data, e.g. https://visualisations.aemo.com.au/aemo/apps/api/report
   */
  AEMO_API_URL: string;

  /**
   * The data set identifier for AEMO summary data, e.g. ELEC_NEM_SUMMARY.
   * The user-provided JSON also includes "ELEC_NEM_SUMMARY_PRICES" in the same response.
   */
  AEMO_DATA_SUMMARY: string;

  /**
   * Optional environment-based log level: "DEBUG", "INFO", "WARN", or "ERROR".
   */
  LOG_LEVEL?: string;
}

/**
 * Row structure in "market_interval_data". Timestamps in ms (UTC).
 * Fields allow for storing both the "ELEC_NEM_SUMMARY" data plus the FCAS
 * details from "ELEC_NEM_SUMMARY_PRICES."
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

  // FCAS related fields:
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
 * Combined record shape from ELEC_NEM_SUMMARY + FCAS fields (NEM_SUMMARY_PRICES).
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
 * AemoData DO: fetches data from AEMO_DATA_SUMMARY endpoint (which internally includes
 * ELEC_NEM_SUMMARY + ELEC_NEM_SUMMARY_PRICES arrays in the JSON) and stores the merges.
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
      this.log("DEBUG", "Checking existence of market_interval_data table...");
      this.sql.exec("SELECT 1 FROM market_interval_data LIMIT 1;");
      this.log("DEBUG", "Table market_interval_data exists.");
    } catch (err) {
      this.log("INFO", `Creating table market_interval_data => ${String(err)}`);
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

    this.log("INFO", `AemoData DO constructed. LOG_LEVEL="${env.LOG_LEVEL ?? "WARN"}"`);
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
   * handleSync => fetches from a single endpoint (AEMO_DATA_SUMMARY),
   * which internally includes "ELEC_NEM_SUMMARY" + "ELEC_NEM_SUMMARY_PRICES" in the JSON.
   * Then merges them by region, storing the intervals.
   */
  private async handleSync(): Promise<Response> {
    this.log("INFO", "Syncing from AEMO_DATA_SUMMARY to store intervals with FCAS data if present.");

    const url = `${this.env.AEMO_API_URL}/${this.env.AEMO_DATA_SUMMARY}`;
    let dataJson: any;

    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json"
        }
      });
      if (!resp.ok) {
        throw new Error(`Fetch from AEMO_DATA_SUMMARY failed => status=${resp.status}`);
      }
      dataJson = await resp.json();
    } catch (err) {
      const msg = `handleSync => fetch error: ${(err as Error).message}`;
      this.log("ERROR", msg);
      return new Response(msg, { status: 500 });
    }

    if (typeof dataJson !== "object" || !dataJson.ELEC_NEM_SUMMARY || !dataJson.ELEC_NEM_SUMMARY_PRICES) {
      const msg = "handleSync => JSON missing ELEC_NEM_SUMMARY or ELEC_NEM_SUMMARY_PRICES arrays.";
      this.log("ERROR", msg);
      return new Response(msg, { status: 500 });
    }

    const summaryArr = Array.isArray(dataJson.ELEC_NEM_SUMMARY) ? dataJson.ELEC_NEM_SUMMARY : [];
    const pricesArr = Array.isArray(dataJson.ELEC_NEM_SUMMARY_PRICES) ? dataJson.ELEC_NEM_SUMMARY_PRICES : [];

    if (!summaryArr.length) {
      const msg = "ELEC_NEM_SUMMARY is empty. Nothing to store.";
      this.log("WARN", msg);
      return new Response(msg, { status: 200 });
    }

    // Build a region => FCAS map from ELEC_NEM_SUMMARY_PRICES
    const fcasMap = new Map<string, any>();
    for (const p of pricesArr) {
      const regionKey = String(p.REGIONID || "").trim();
      if (regionKey) {
        fcasMap.set(regionKey, p);
      }
    }

    // Merge each ELEC_NEM_SUMMARY row with FCAS row by region
    const mergedRows: CombinedIntervalRow[] = [];
    for (const row of summaryArr) {
      const regionId = String(row.REGIONID || "").trim();
      if (!regionId) {
        continue;
      }
      const settlementMs = this.parseLocalBrisbaneMs(row.SETTLEMENTDATE);
      if (Number.isNaN(settlementMs)) {
        this.log("ERROR", `Invalid settlement date => ${row.SETTLEMENTDATE}`);
        continue;
      }
      const fcas = fcasMap.get(regionId) || {};

      mergedRows.push({
        settlement_ts: settlementMs,
        regionid: regionId,
        region: regionId,
        market_name: "NEM",
        energy_price: row.PRICE ?? null,
        price_status: row.PRICE_STATUS ?? null,
        apc_flag: row.APCFLAG ?? null,
        market_suspended_flag: row.MARKETSUSPENDEDFLAG ?? null,
        total_demand: row.TOTALDEMAND ?? null,
        net_interchange: row.NETINTERCHANGE ?? null,
        scheduled_generation: row.SCHEDULEDGENERATION ?? null,
        semischeduled_generation: row.SEMISCHEDULEDGENERATION ?? null,
        interconnector_flows: row.INTERCONNECTORFLOWS ?? null,

        // FCAS from the matching region (if any):
        raise_reg_price: fcas.RAISEREGRRP ?? null,
        lower_reg_price: fcas.LOWERREGRRP ?? null,
        raise_1sec_price: fcas.RAISE1SECRRP ?? null,
        raise_6sec_price: fcas.RAISE6SECRRP ?? null,
        raise_60sec_price: fcas.RAISE60SECRRP ?? null,
        raise_5min_price: fcas.RAISE5MINRRP ?? null,
        lower_1sec_price: fcas.LOWER1SECRRP ?? null,
        lower_6sec_price: fcas.LOWER6SECRRP ?? null,
        lower_60sec_price: fcas.LOWER60SECRRP ?? null,
        lower_5min_price: fcas.LOWER5MINRRP ?? null
      });
    }

    if (!mergedRows.length) {
      const msg = "ELEC_NEM_SUMMARY data found, but no valid intervals. Possibly all region IDs empty.";
      this.log("WARN", msg);
      return new Response(msg, { status: 200 });
    }

    // Deduplicate insertion by checking existing keys
    let earliest = mergedRows[0].settlement_ts;
    let latest = mergedRows[0].settlement_ts;
    for (const m of mergedRows) {
      if (m.settlement_ts < earliest) earliest = m.settlement_ts;
      if (m.settlement_ts > latest) latest = m.settlement_ts;
    }

    const regionIds = [...new Set(mergedRows.map(m => m.regionid))];
    if (!regionIds.length) {
      const msg = "No region IDs found in final merged rows. Skipping insertion.";
      this.log("WARN", msg);
      return new Response(msg, { status: 200 });
    }

    const placeholders = regionIds.map(() => "?").join(", ");
    const existingSql = `
      SELECT settlement_ts, regionid, market_name
      FROM market_interval_data
      WHERE settlement_ts >= ? AND settlement_ts <= ?
        AND regionid IN (${placeholders})
        AND market_name = 'NEM'
    `;
    const existingRows = this.sql.exec(existingSql, earliest, latest, ...regionIds).toArray();
    const existingKeys = new Set<string>();
    for (const e of existingRows) {
      existingKeys.add(`${e.settlement_ts}-${e.regionid}-${e.market_name}`);
    }

    let insertedCount = 0;
    for (const m of mergedRows) {
      const key = `${m.settlement_ts}-${m.regionid}-${m.market_name}`;
      if (existingKeys.has(key)) {
        continue;
      }

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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (settlement_ts, regionid, market_name)
        DO NOTHING
      `,
      m.settlement_ts,
      m.regionid,
      m.region,
      m.market_name,
      m.energy_price,
      m.price_status,
      m.apc_flag,
      m.market_suspended_flag,
      m.total_demand,
      m.net_interchange,
      m.scheduled_generation,
      m.semischeduled_generation,
      m.interconnector_flows,
      m.raise_reg_price,
      m.lower_reg_price,
      m.raise_1sec_price,
      m.raise_6sec_price,
      m.raise_60sec_price,
      m.raise_5min_price,
      m.lower_1sec_price,
      m.lower_6sec_price,
      m.lower_60sec_price,
      m.lower_5min_price);

      insertedCount += res.rowsWritten;
    }

    const msg = `Sync successful. intervalsFetched=${mergedRows.length}, inserted=${insertedCount}`;
    this.log("INFO", msg);
    return new Response(msg, { status: 200 });
  }

  /**
   * GET /range => optional lastSec or start/end => queries intervals from the DB with paging.
   */
  private async handleRangeRequest(url: URL): Promise<Response> {
    try {
      const limitParam = url.searchParams.get("limit") ?? "100";
      const offsetParam = url.searchParams.get("offset") ?? "0";
      let limit = parseInt(limitParam, 10);
      let offset = parseInt(offsetParam, 10);
      if (Number.isNaN(limit) || limit <= 0) limit = 100;
      if (Number.isNaN(offset) || offset < 0) offset = 0;

      const lastSecParam = url.searchParams.get("lastSec");
      const startParam = url.searchParams.get("start");
      const endParam = url.searchParams.get("end");
      const regionParam = url.searchParams.get("regionid") || null;
      const nowMs = Date.now();

      // If lastSec => override start/end
      if (lastSecParam) {
        if (startParam || endParam) {
          return new Response(JSON.stringify({ error: "Cannot combine lastSec with start/end." }),
            { status: 400, headers: { "content-type": "application/json" } });
        }
        const lastSec = parseInt(lastSecParam, 10);
        if (Number.isNaN(lastSec) || lastSec <= 0) {
          return new Response(JSON.stringify({ error: "Invalid lastSec." }),
            { status: 400, headers: { "content-type": "application/json" } });
        }
        const maxSec = 7 * 24 * 3600; // e.g. 7 days
        if (lastSec > maxSec) {
          return new Response(JSON.stringify({ error: "Requested range too large." }),
            { status: 400, headers: { "content-type": "application/json" } });
        }
        const from = nowMs - lastSec * 1000;
        const to = nowMs;
        return this.queryRange(from, to, regionParam, false, limit, offset);
      }

      // If start/end => both required => ascending
      if (startParam || endParam) {
        if (!startParam || !endParam) {
          return new Response(JSON.stringify({ error: "Must provide both start and end or neither." }),
            { status: 400, headers: { "content-type": "application/json" } });
        }
        const startMs = parseInt(startParam, 10);
        const endMs = parseInt(endParam, 10);
        if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
          return new Response(JSON.stringify({ error: "Invalid start or end." }),
            { status: 400, headers: { "content-type": "application/json" } });
        }
        if (endMs < startMs) {
          return new Response(JSON.stringify({ error: "end must be >= start." }),
            { status: 400, headers: { "content-type": "application/json" } });
        }
        const maxRange = 7 * 24 * 3600 * 1000; // e.g. 7 days in ms
        if (endMs - startMs > maxRange) {
          return new Response(JSON.stringify({ error: "Requested range too large." }),
            { status: 400, headers: { "content-type": "application/json" } });
        }
        return this.queryRange(startMs, endMs, regionParam, true, limit, offset);
      }

      // No param => fetch the single most recent interval per region, descending
      return this.queryLatestRecords(regionParam, limit, offset);

    } catch (err) {
      const msg = `handleRangeRequest => ${String(err)}`;
      this.log("ERROR", msg);
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /**
   * Debug route: /testInsertThenRead => inserts a row, queries it back for demonstration.
   */
  private async handleTestInsertThenRead(): Promise<Response> {
    try {
      const uniqueTs = Date.now() + Math.floor(Math.random() * 100000);

      // Insert a minimal row
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

      // Query top 5
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

      const respBody = {
        message: "Inserted debug row, now reading top 5 rows by settlement_ts:",
        inserted: new Date(uniqueTs).toISOString(),
        rows: mapped
      };
      return new Response(JSON.stringify(respBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      const msg = `testInsertThenRead => ${String(err)}`;
      this.log("ERROR", msg);
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /**
   * queryRange => returns intervals in [startMs..endMs], optional region filter,
   * ordering asc/desc, plus pagination headers.
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
        countSql += " AND regionid = ?";
        countVals.push(regionParam);
      }

      const countArr = this.sql.exec<{ total_count: number }>(countSql, ...countVals).toArray();
      let totalCount = 0;
      if (countArr.length && typeof countArr[0].total_count === "number") {
        totalCount = countArr[0].total_count;
      }

      // Data
      const orderDir = asc ? "ASC" : "DESC";
      let query = `
        SELECT settlement_ts, regionid, region, market_name, energy_price
        FROM market_interval_data
        WHERE settlement_ts >= ? AND settlement_ts <= ?
      `;
      const vals = [startMs, endMs];
      if (regionParam) {
        query += " AND regionid = ?";
        vals.push(regionParam);
      }
      query += ` ORDER BY settlement_ts ${orderDir} LIMIT ? OFFSET ?`;
      vals.push(limit, offset);

      const rows = this.sql.exec<SimpleIntervalRow>(query, ...vals).toArray();
      const mapped = rows.map(r => ({
        settlement: r.settlement_ts ? new Date(r.settlement_ts).toISOString() : null,
        regionid: r.regionid,
        region: r.region,
        market_name: r.market_name,
        energy_price: r.energy_price
      }));

      // Pagination
      const resp = new Response(JSON.stringify(mapped), {
        status: 200,
        headers: { "content-type": "application/json" },
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
      const msg = `queryRange => ${String(err)}`;
      this.log("ERROR", msg);
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /**
   * queryLatestRecords => fetches a single most recent row for each region, or
   * only for one region if regionParam is set, plus pagination.
   */
  private queryLatestRecords(
    regionParam: string | null | undefined,
    limit: number,
    offset: number
  ): Response {
    try {
      // Count how many distinct "latest" entries
      let countSql = `
        SELECT COUNT(*) as total_count FROM (
          SELECT regionid, settlement_ts
          FROM market_interval_data t
          JOIN (
            SELECT regionid AS sub_region, MAX(settlement_ts) AS sub_max
            FROM market_interval_data
            GROUP BY regionid
          ) sub
            ON t.regionid = sub.sub_region
           AND t.settlement_ts = sub.sub_max
      `;
      const countVals: string[] = [];
      if (regionParam) {
        countSql += " WHERE t.regionid = ?";
        countVals.push(regionParam);
      }
      countSql += ` ) alias`;

      const countRows = this.sql.exec<{ total_count: number }>(countSql, ...countVals).toArray();
      let totalCount = 0;
      if (countRows.length && typeof countRows[0].total_count === "number") {
        totalCount = countRows[0].total_count;
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
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /**
   * parseLocalBrisbaneMs => forcibly appends +10:00 if no timezone found, then parse.
   */
  private parseLocalBrisbaneMs(dateStr: string): number {
    const raw = (dateStr ?? "").trim();
    const offsetRegex = /[Zz]|[\+\-]\d{2}:?\d{2}/;
    const final = offsetRegex.test(raw) ? raw : `${raw}+10:00`;
    const ms = Date.parse(final);
    if (Number.isNaN(ms)) {
      this.log("ERROR", `parseLocalBrisbaneMs => cannot parse dateStr="${dateStr}" => final="${final}"`);
      return NaN;
    }
    return ms;
  }

  /**
   * Logging helper => prints if level is within threshold.
   */
  private log(level: LogLevel, msg: string): void {
    if (getLogPriority(level) >= this.logLevel) {
      console.log(`[${level}] ${msg}`);
    }
  }
}