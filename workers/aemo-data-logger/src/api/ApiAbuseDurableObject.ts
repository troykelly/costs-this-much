/**
 * @fileoverview Durable Object that tracks requests to enforce rate limits
 * based on IP address, ASN, and a session ID. This helps prevent abuse by
 * constraining requests within a configurable window.
 *
 * The DO uses Cloudflare's new SQL-based storage. Each request is recorded,
 * and older entries are cleaned up. Queries are done to determine if the
 * current request exceeds the configured threshold.
 *
 * Environment variables needed:
 *  - RATE_LIMIT_MAX: maximum number of requests per window
 *  - RATE_LIMIT_WINDOW_SEC: size of the window in seconds
 */

import type {
  DurableObjectState,
  DurableObject,
  SqlStorage,
  SqlStorageValue,
} from "@cloudflare/workers-types";

/** Shape of a row in the 'api_abuse_tracking' table. */
interface AbuseRecord extends Record<string, SqlStorageValue> {
  ip: string;
  asn: string;
  session_id: string;
  ts: number;
}

/** Logging levels. */
type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "NONE";
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
 * The ApiAbuse DO is used to record and check requests for possible abuse.
 */
export class ApiAbuse implements DurableObject {
  private readonly sql: SqlStorage;
  private readonly logLevel: number;
  private readonly rateLimitMax: number;
  private readonly rateLimitWindowSec: number;

  constructor(private readonly state: DurableObjectState, env: Record<string, string>) {
    this.sql = state.storage.sql;

    // Configure log level from environment
    const configuredLevel = env.LOG_LEVEL ?? "WARN";
    this.logLevel = getLogPriority(configuredLevel);

    // Rate limit config
    this.rateLimitMax = parseInt(env.RATE_LIMIT_MAX ?? "60", 10);
    this.rateLimitWindowSec = parseInt(env.RATE_LIMIT_WINDOW_SEC ?? "60", 10);

    // Ensure the DB table exists
    try {
      this.sql.exec("SELECT 1 FROM api_abuse_tracking LIMIT 1;");
      this.log("DEBUG", "Table api_abuse_tracking exists.");
    } catch (err) {
      this.log("INFO", `Creating table api_abuse_tracking - reason: ${String(err)}`);
      this.sql.exec(`
        CREATE TABLE api_abuse_tracking (
          ip         TEXT NOT NULL,
          asn        TEXT NOT NULL,
          session_id TEXT NOT NULL,
          ts         INTEGER NOT NULL,
          PRIMARY KEY (ip, asn, session_id, ts)
        );
        CREATE INDEX idx_abuse_ip_asn_session 
          ON api_abuse_tracking (ip, asn, session_id);
        CREATE INDEX idx_abuse_ts
          ON api_abuse_tracking (ts);
      `);
    }
    this.log("INFO", `ApiAbuse DO constructed with LOG_LEVEL="${configuredLevel}".`);
  }

  /**
   * fetch() - handles POST /checkRate. Expects JSON with:
   *   ip: string,
   *   asn: string,
   *   session_id: string,
   *   nowMs: number
   * Returns JSON { allowed: boolean }
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // We only handle a single endpoint here
    if (request.method === "POST" && url.pathname === "/checkRate") {
      return this.handleCheckRate(request);
    }

    return new Response("Not Found", { status: 404 });
  }

  /**
   * handleCheckRate - checks if the request is under the configured limit.
   * If not, returns { allowed: false }. If under limit, records the request in
   * the database and returns { allowed: true }.
   */
  private async handleCheckRate(request: Request): Promise<Response> {
    let payload: {
      ip: string;
      asn: string;
      session_id: string;
      nowMs: number;
    };

    try {
      payload = await request.json();
    } catch (err) {
      this.log("ERROR", "Invalid JSON in handleCheckRate request.");
      return new Response(JSON.stringify({ allowed: false, error: "Bad JSON" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const { ip, asn, session_id, nowMs } = payload;
    if (!ip || !asn || !session_id || !nowMs) {
      this.log("ERROR", "Missing fields in handleCheckRate request.");
      return new Response(JSON.stringify({ allowed: false, error: "Missing fields" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    // Clean out old records
    const cutoff = nowMs - this.rateLimitWindowSec * 1000;
    this.sql.exec("DELETE FROM api_abuse_tracking WHERE ts < ?", cutoff);

    // Count how many requests are found in the window
    const countCursor = this.sql.exec<AbuseRecord>(
      `
      SELECT COUNT(*) AS cnt
      FROM api_abuse_tracking
      WHERE ip = ?
        AND asn = ?
        AND session_id = ?
        AND ts >= ?
      `,
      ip,
      asn,
      session_id,
      cutoff
    );

    let currentCount = 0;
    for (const row of countCursor) {
      if (typeof row["cnt"] === "number") {
        currentCount = row["cnt"];
      } else if (typeof row["cnt"] === "bigint") {
        currentCount = Number(row["cnt"]);
      }
    }

    if (currentCount >= this.rateLimitMax) {
      this.log("WARN", `Rate limit exceeded by ip=${ip}, asn=${asn}, session=${session_id}`);
      return new Response(JSON.stringify({ allowed: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // If within limit, record the new request
    this.sql.exec(
      `
      INSERT INTO api_abuse_tracking (ip, asn, session_id, ts)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (ip, asn, session_id, ts)
      DO NOTHING
      `,
      ip,
      asn,
      session_id,
      nowMs
    );

    this.log("DEBUG", `Check OK for ip=${ip}, asn=${asn}, session=${session_id}, count=${currentCount + 1}`);
    return new Response(JSON.stringify({ allowed: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  private log(level: LogLevel, message: string): void {
    if (getLogPriority(level) >= this.logLevel) {
      console.log(`[${level}] ${message}`);
    }
  }
}