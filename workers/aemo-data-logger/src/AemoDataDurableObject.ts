/**
 * @fileoverview The Durable Object that stores AEMO intervals in a SQL backend.
 * This is scaffolding code showing how to structure a DO with the new Cloudflare
 * SQL Storage API for Durable Objects.
 */
import type { DurableObjectState } from '@cloudflare/workers-types';

export class AemoDataDurableObject {
  state: DurableObjectState;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/sync' && request.method === 'POST') {
      return this.handleSync();
    }
    return new Response("Not found", { status: 404 });
  }

  // In the real code, you'd parse a list of missing intervals, fetch from AEMO,
  // then insert them. The below is just a stub example.
  private async handleSync(): Promise<Response> {
    try {
      // Example approach:
      // 1. Find the intervals we are missing from now-36h to now, using something like:
      //    let missing = this.getMissingIntervals();
      // 2. Get 36h data from AEMO
      // 3. Insert only if intervals are in the data and truly missing

      // For demonstration, let's do a trivial SQL usage example:
      const sql = this.state.storage.sql;
      // Create table if not present:
      sql.exec(`
        CREATE TABLE IF NOT EXISTS intervals (
          settlementdate TEXT PRIMARY KEY,
          regionid TEXT,
          rrp NUMERIC
        );
      `);

      // In real usage, you'd loop over the AEMO data intervals
      // and insert them if they do not exist. For example:
      // sql.exec(\`INSERT INTO intervals (settlementdate, regionid, rrp) VALUES (?,?,?)\`, dateStr, regionId, rrpVal);

      return new Response("Sync completed (stub).");
    } catch (err) {
      console.error("handleSync error:", err);
      return new Response("Sync failed: " + (err as Error).message, { status: 500 });
    }
  }
}