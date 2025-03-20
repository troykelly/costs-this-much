/**
 * @fileoverview CostsThisMuch.ts - Provides a production-ready client library for interacting
 * with the CostsThisMuch API. It handles:
 *
 * 1. Session management with short-lived access tokens and refresh tokens:
 *    - login(clientId) => obtains and stores access_token + refresh_token
 *    - automatic refresh when the access token expires (or if a 401 response occurs).
 *
 * 2. Local data storage in the browser's IndexedDB for offline and efficient retrieval:
 *    - fetchAndStoreLastWeek(), fetchAndStoreRange(), and fetchAndStoreLatest() methods query
 *      the API (with paging) and store intervals in a well-defined table in IndexedDB.
 *    - getLocalDataInRange() retrieves intervals from IndexedDB for a specified time range.
 *
 * 3. Automatic paging: The library reads the API's pagination headers and continues fetching
 *    until all pages are retrieved.
 *
 * 4. Usage in either web code or a service worker context. The library is self-contained but
 *    can be adapted as needed.
 *
 * Basic Usage:
 * ---------------------------------------------------------------------------------
 *   import { CostsThisMuch } from './CostsThisMuch';
 *
 *   async function main(): Promise<void> {
 *     const client = new CostsThisMuch({
 *       apiBaseUrl: 'https://api.coststhismuch.au',
 *     });
 *
 *     // Initialize the IndexedDB structure
 *     await client.initialize();
 *
 *     // Log in with your known client ID from the system
 *     await client.login('YOUR_CLIENT_ID');
 *
 *     // Now you can fetch & store data
 *     await client.fetchAndStoreLastWeek();
 *
 *     // Retrieve a time range from local DB
 *     const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
 *     const now = Date.now();
 *     const localData = await client.getLocalDataInRange(twoDaysAgo, now);
 *     console.log('Retrieved intervals:', localData);
 *
 *     // If your access token expires, the client automatically refreshes behind the scenes,
 *     // as long as you still have a valid refresh token in session.
 *   }
 * ---------------------------------------------------------------------------------
 *
 * Author: Troy Kelly <troy@troykelly.com>
 * Created: 20 March 2025
 */

const DB_NAME = 'aemo_intervals_db';
/**
 * Increased DB_VERSION to 2 to migrate to a more "table-like" structure with columns & indexes.
 */
const DB_VERSION = 2;
const OBJECT_STORE_NAME = 'interval_records';

/**
 * IntervalRecord describes the structure stored in IndexedDB and
 * retrieved from the API's /data endpoint.
 */
export interface IntervalRecord {
  /**
   * Settlement time in ISO8601 format. e.g. "2025-03-20T12:34:56Z"
   */
  settlement: string | null;

  /**
   * The region identifier (e.g. "NSW1", "QLD1", etc.).
   */
  regionid: string | null;

  /**
   * Region display name if provided (may be null).
   */
  region: string | null;

  /**
   * Regional reference price (RRP) in $/MWh for that interval.
   */
  rrp: number | null;

  /**
   * Total demand (MW) at that interval or null if unknown.
   */
  totaldemand: number | null;

  /**
   * Period type (e.g. "ENERGY") or null if unknown.
   */
  periodtype: string | null;

  /**
   * Net interchange (MW) or null if unknown.
   */
  netinterchange: number | null;

  /**
   * Scheduled generation (MW) or null.
   */
  scheduledgeneration: number | null;

  /**
   * Semi-scheduled generation (MW) or null.
   */
  semischeduledgeneration: number | null;

  /**
   * APC flag or null if not set.
   */
  apcflag: number | null;
}

/**
 * Options for creating a CostsThisMuch client instance.
 */
export interface CostsThisMuchOptions {
  /**
   * Base URL for the CostsThisMuch API (e.g. "https://api.coststhismuch.au")
   */
  apiBaseUrl: string;
}

/**
 * Internal interface to store the session info (access/refresh tokens).
 */
interface SessionInfo {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  clientId: string;
}

interface PaginatedRequestParams {
  startMs?: number;
  endMs?: number;
  lastSec?: number;
  regionid?: string;
  limit?: number;
  offset?: number;
  ascending?: boolean;
}

/**
 * The main class providing methods to:
 *   1) Login & maintain session.
 *   2) Fetch & store data intervals from the /data API to IndexedDB.
 *   3) Retrieve intervals from local IndexedDB for offline usage or for live display.
 *
 * By default, you can:
 *   const client = new CostsThisMuch({ apiBaseUrl: 'https://api.example.com' });
 *   await client.initialize();
 *   await client.login('some_client_id');
 *
 *   // Then fetch data
 *   await client.fetchAndStoreLastWeek();
 *   // ... get intervals locally
 *   const someData = await client.getLocalDataInRange(...);
 */
export class CostsThisMuch {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private readonly apiBaseUrl: string;
  private session: SessionInfo | null = null;

  // Internal timer ID for auto-updating, if started via autoInitializeAndSync().
  private autoRefreshIntervalId: number | undefined;

  /**
   * Constructs a new CostsThisMuch instance with the given configuration.
   *
   * @param {CostsThisMuchOptions} options The configuration for the client, including apiBaseUrl.
   */
  constructor(options: CostsThisMuchOptions) {
    this.apiBaseUrl = options.apiBaseUrl;
  }

  /**
   * Initialises the IndexedDB structure (creates object store if not present,
   * or updates it to a well-defined table with columns/indexes if DB_VERSION changed).
   *
   * @return {Promise<void>}
   */
  public async initialize(): Promise<void> {
    if (this.dbPromise) {
      // Already initialised.
      await this.dbPromise;
      return;
    }
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const openReq = indexedDB.open(DB_NAME, DB_VERSION);

      openReq.onupgradeneeded = () => {
        const db = openReq.result;

        // If an older store exists, delete it so we can create a new well-defined structure.
        if (db.objectStoreNames.contains(OBJECT_STORE_NAME)) {
          db.deleteObjectStore(OBJECT_STORE_NAME);
        }

        // Create a new object store with an auto-increment primary key, plus indexes for columns.
        // We'll use a unique composite index on [settlement, regionid] to avoid duplicates.
        const store = db.createObjectStore(OBJECT_STORE_NAME, {
          keyPath: 'id',
          autoIncrement: true
        });

        // Index for settlement alone (string ISO8601). Used for time-based range queries.
        store.createIndex('settlement_idx', 'settlement', { unique: false });

        // Composite index on [settlement, regionid] ensures data uniqueness for that combination.
        store.createIndex('settlement_region_idx', ['settlement', 'regionid'], { unique: true });

        // Index for regionid if needed for quick region lookups.
        store.createIndex('regionid_idx', 'regionid', { unique: false });
      };

      openReq.onsuccess = () => {
        resolve(openReq.result);
      };
      openReq.onerror = () => {
        reject(openReq.error);
      };
    });
    await this.dbPromise;
  }

  /**
   * Logs in to the CostsThisMuch API using a known client ID. Stores access/refresh tokens for usage.
   *
   * @param {string} clientId The known valid client ID.
   * @return {Promise<void>}
   */
  public async login(clientId: string): Promise<void> {
    const url = new URL('/token', this.apiBaseUrl);
    const body = { client_id: clientId };

    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Login failed (status=${resp.status}). Response: ${txt}`);
    }
    const data = await resp.json() as {
      token_type: string;
      access_token: string;
      expires_in: number;
      refresh_token: string;
    };

    if (!data.access_token || !data.refresh_token || !data.expires_in) {
      throw new Error('Malformed token response from /token');
    }
    const nowSec = Math.floor(Date.now() / 1000);

    // We'll assume a default refresh of 14 days if not given explicitly in the response.
    const defaultRefreshExpirySec = nowSec + 14 * 24 * 3600;

    this.session = {
      accessToken: data.access_token,
      accessTokenExpiresAt: nowSec + data.expires_in,
      refreshToken: data.refresh_token,
      refreshTokenExpiresAt: defaultRefreshExpirySec,
      clientId,
    };
  }

  /**
   * Clears the current session tokens from memory.
   */
  public logout(): void {
    this.session = null;
  }

  /**
   * Fetches all intervals from the past week from our /data API,
   * storing them in IndexedDB as rows in the newly defined table.
   *
   * @return {Promise<void>}
   */
  public async fetchAndStoreLastWeek(): Promise<void> {
    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    await this.fetchAndStoreRange(oneWeekAgo, now);
  }

  /**
   * Fetches intervals for the provided [startMs..endMs] range,
   * automatically following pagination, and stores them in IndexedDB.
   *
   * @param {number} startMs Start time in ms
   * @param {number} endMs End time in ms
   * @return {Promise<void>}
   */
  public async fetchAndStoreRange(startMs: number, endMs: number): Promise<void> {
    const ascending = true;
    const baseParams: PaginatedRequestParams = {
      startMs,
      endMs,
      limit: 100,
      offset: 0,
      ascending,
    };
    await this.fetchAllPagesAndStore(baseParams);
  }

  /**
   * Fetches and stores the latest intervals from the current time minus lastSec (by default 2h).
   *
   * @param {number} lastSec The number of seconds to look back. Default=7200 (2 hours).
   * @return {Promise<void>}
   */
  public async fetchAndStoreLatest(lastSec = 7200): Promise<void> {
    await this.fetchAllPagesAndStore({ lastSec, limit: 100, offset: 0 });
  }

  /**
   * Retrieves locally-stored intervals from the IndexedDB, selecting those whose settlement
   * time is in [startMs..endMs] (ISO8601), inclusive, sorted in ascending order by settlement time.
   *
   * @param {number} startMs Start time in ms
   * @param {number} endMs End time in ms
   * @return {Promise<IntervalRecord[]>} The matching intervals from local DB, sorted ascending by settlement.
   */
  public async getLocalDataInRange(startMs: number, endMs: number): Promise<IntervalRecord[]> {
    const db = await this.ensureDb();
    return new Promise<IntervalRecord[]>((resolve, reject) => {
      const tx = db.transaction(OBJECT_STORE_NAME, 'readonly');
      const store = tx.objectStore(OBJECT_STORE_NAME);
      const index = store.index('settlement_idx');

      /**
       * Convert numeric ms to ISO8601. We store the data as an ISO8601 string, so we do
       * an IDBKeyRange bound from e.g. "2025-03-20T00:00:00.000Z" to "2025-03-27T00:00:00.000Z".
       */
      const startIso = new Date(startMs).toISOString();
      const endIso = new Date(endMs).toISOString();
      const range = IDBKeyRange.bound(startIso, endIso, false, false);

      const request = index.openCursor(range);
      const results: IntervalRecord[] = [];

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          results.push(cursor.value as IntervalRecord);
          cursor.continue();
        } else {
          // Sort by settlement ascending (ISO8601 lexicographic also works, but let's be certain).
          results.sort((a, b) => {
            const da = a.settlement ? Date.parse(a.settlement) : 0;
            const db = b.settlement ? Date.parse(b.settlement) : 0;
            return da - db;
          });
          resolve(results);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Helper method to open or reuse the IndexedDB connection.
   */
  private async ensureDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      await this.initialize();
      if (!this.dbPromise) {
        throw new Error('Failed to open IndexedDB database.');
      }
    }
    return this.dbPromise as Promise<IDBDatabase>;
  }

  /**
   * Loops over pages from the /data endpoint with the given parameters, writing them into IndexedDB
   * until X-Has-Next-Page == false.
   */
  private async fetchAllPagesAndStore(baseParams: PaginatedRequestParams): Promise<void> {
    let offset = 0;
    let hasNextPage = true;

    while (hasNextPage) {
      const response = await this.authenticatedFetchData(baseParams, offset);
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`API Error. Status=${response.status} Details=${text}`);
      }
      const data = (await response.json()) as IntervalRecord[];
      const newOffset = offset + data.length;

      await this.storeInIndexedDb(data);

      const xHasNext = response.headers.get('X-Has-Next-Page');
      hasNextPage = xHasNext === 'true';
      offset = newOffset;
    }
  }

  /**
   * Executes a GET /data? ... request with the provided parameters, using an Authorization Bearer token.
   * Automated refresh if 401 returned.
   */
  private async authenticatedFetchData(params: PaginatedRequestParams, offset: number): Promise<Response> {
    const url = new URL('/data', this.apiBaseUrl);
    if (typeof params.lastSec === 'number') {
      url.searchParams.set('lastSec', String(params.lastSec));
    }
    if (typeof params.startMs === 'number') {
      url.searchParams.set('start', String(params.startMs));
    }
    if (typeof params.endMs === 'number') {
      url.searchParams.set('end', String(params.endMs));
    }
    if (params.regionid) {
      url.searchParams.set('regionid', params.regionid);
    }
    const limit = params.limit ?? 100;
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    // 'ascending' is handled server-side if start/end are present; no param needed beyond that.

    await this.ensureValidAccessToken();

    const attempt = await this.fetchWithToken(url.toString(), {
      method: 'GET',
    });

    if (attempt.status === 401) {
      const refreshedOk = await this.tryRefreshTokens();
      if (!refreshedOk) {
        throw new Error('Access token expired and refresh token is invalid or expired. Please login again.');
      }
      // retry
      return this.fetchWithToken(url.toString(), { method: 'GET' });
    }

    return attempt;
  }

  /**
   * Low-level: fetch with the current access token. No auto-refresh here.
   */
  private async fetchWithToken(resource: string, init: RequestInit): Promise<Response> {
    if (!this.session) {
      throw new Error('No session is active. Must call login() first.');
    }
    const headers: HeadersInit = init.headers ?? {};
    headers['Authorization'] = `Bearer ${this.session.accessToken}`;
    init.headers = headers;
    return fetch(resource, init);
  }

  /**
   * Ensures the current access token is valid (not expired). If expired, tries to refresh automatically.
   */
  private async ensureValidAccessToken(): Promise<void> {
    if (!this.session) {
      throw new Error('No session is active. Must call login() first.');
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec < this.session.accessTokenExpiresAt) {
      return;
    }

    // otherwise, attempt refresh
    const ok = await this.tryRefreshTokens();
    if (!ok) {
      throw new Error('Access token expired and refresh token is invalid or expired. Please login again.');
    }
  }

  /**
   * Attempts a refresh token flow. On success, updates session with new short-lived token info.
   */
  private async tryRefreshTokens(): Promise<boolean> {
    if (!this.session) {
      return false;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec >= this.session.refreshTokenExpiresAt) {
      return false;
    }

    const url = new URL('/refresh', this.apiBaseUrl);
    const body = { refresh_token: this.session.refreshToken };
    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      return false;
    }
    const data = await resp.json() as Partial<{
      token_type: string;
      access_token: string;
      expires_in: number;
      refresh_token: string;
    }>;
    if (!data.access_token || !data.expires_in) {
      return false;
    }
    const now = Math.floor(Date.now() / 1000);
    this.session.accessToken = data.access_token;
    this.session.accessTokenExpiresAt = now + data.expires_in;

    // if a new refresh token is present
    if (data.refresh_token) {
      this.session.refreshToken = data.refresh_token;
      this.session.refreshTokenExpiresAt = now + (14 * 24 * 3600);
    }

    return true;
  }

  /**
   * Writes an array of intervals to IndexedDB using object store columns. Duplicate entries
   * (same settlement and regionid) will be updated due to the settlement_region_idx unique constraint.
   */
  private async storeInIndexedDb(records: IntervalRecord[]): Promise<void> {
    if (!records.length) {
      return;
    }
    const db = await this.ensureDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OBJECT_STORE_NAME, 'readwrite');
      const store = tx.objectStore(OBJECT_STORE_NAME);

      for (const rec of records) {
        // We rely on the unique composite index [settlement, regionid] to prevent duplicates
        // or to update if the same record is inserted again. We use put(), which either adds
        // or overwrites the existing row that matches the unique index constraints.
        store.put(rec);
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Convenience method to do the entire flow: initialize + login + fetch last 7 days,
   * then set a repeating timer every 5 minutes to fetch the latest ~2h data from the API.
   *
   * @param {string} clientId The known valid client ID for login.
   */
  public async autoInitializeAndSync(clientId: string): Promise<void> {
    await this.initialize();
    await this.login(clientId);
    // Preload the last seven days
    await this.fetchAndStoreLastWeek();

    // Now maintain updates for the last 2 hours every 5 mins
    this.autoRefreshIntervalId = window.setInterval(() => {
      this.fetchAndStoreLatest(7200).catch((err) => {
        console.error('Auto refresh error:', err);
      });
    }, 5 * 60 * 1000);
  }

  /**
   * Optionally stop the auto-updater if desired. If you never called autoInitializeAndSync(),
   * you don't need to call this.
   */
  public stopAutoSync(): void {
    if (this.autoRefreshIntervalId) {
      clearInterval(this.autoRefreshIntervalId);
      this.autoRefreshIntervalId = undefined;
    }
  }
}