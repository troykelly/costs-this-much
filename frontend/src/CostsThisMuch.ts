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
 *      the API (with paging) and store intervals in IndexedDB.
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
const DB_VERSION = 1;
const OBJECT_STORE_NAME = 'interval_records';

//
// ------------------- Type Definitions ---------------------
//

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
 * Defines the structure of tokens returned by /token and /refresh endpoints.
 */
interface TokenResponse {
  token_type: string;
  access_token: string;
  expires_in: number;
  refresh_token?: string; // Present in /token responses
}

/**
 * Options for creating an CostsThisMuch.
 */
export interface CostsThisMuchOptions {
  /**
   * Base URL for the CostsThisMuch API, e.g. "https://api.coststhismuch.au"
   */
  apiBaseUrl: string;
}

/**
 * Internal interface to store the session info (access/refresh tokens).
 */
interface SessionInfo {
  accessToken: string;
  accessTokenExpiresAt: number; // epoch in seconds
  refreshToken: string;
  refreshTokenExpiresAt: number; // epoch in seconds (approx, if provided)
  clientId: string;
}

interface PaginatedRequestParams {
  startMs?: number;
  endMs?: number;
  lastSec?: number;
  regionid?: string; // optional region
  limit?: number;
  offset?: number;
  ascending?: boolean;
}

//
// ------------------- Main Class ---------------------
//

/**
 * CostsThisMuch - A library to fetch and store data from the
 * CostsThisMuch API in IndexedDB, and provide local queries,
 * with automated session management (short-lived token + refresh token).
 */
export class CostsThisMuch {
  // IndexedDB management
  private dbPromise: Promise<IDBDatabase> | null = null;

  // API base
  private readonly apiBaseUrl: string;

  // Session info is kept in memory. If you want persistence, store it in localStorage.
  private session: SessionInfo | null = null;

  /**
   * Constructs a new CostsThisMuch instance.
   *
   * @param {CostsThisMuchOptions} options Configuration options for the client.
   */
  constructor(options: CostsThisMuchOptions) {
    this.apiBaseUrl = options.apiBaseUrl;
  }

  /**
   * Initializes the IndexedDB database, creating an object store if needed.
   *
   * @return {Promise<void>} Resolves once the DB is open and ready.
   */
  public async initialize(): Promise<void> {
    if (this.dbPromise) {
      // already initialized
      await this.dbPromise;
      return;
    }
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const openReq = indexedDB.open(DB_NAME, DB_VERSION);
      openReq.onupgradeneeded = () => {
        const db = openReq.result;
        if (!db.objectStoreNames.contains(OBJECT_STORE_NAME)) {
          const store = db.createObjectStore(OBJECT_STORE_NAME, {
            keyPath: ['settlement', 'regionid'],
          });
          // Optionally create indexes for time-based queries
          store.createIndex('settlement_idx', 'settlement', { unique: false });
        }
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
   * Initiates a session by calling /token with the provided client ID.
   * This obtains an access_token (short-lived) and a refresh_token,
   * which are then handled automatically by the library.
   *
   * @param {string} clientId The known valid client ID from your system.
   * @throws Error if the token endpoint fails or no tokens are returned.
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
    const data = await resp.json() as TokenResponse;
    if (!data.access_token || !data.refresh_token || !data.expires_in) {
      throw new Error('Malformed token response from /token');
    }
    const nowSec = Math.floor(Date.now() / 1000);

    // We'll store the refresh token expiry as now + 14 days by default if the server doesn't give us an explicit value
    // In many systems, /token = 14 days or so. This is just a typical assumption.
    // If you have an official "refresh token expiry" from the server, parse it. Otherwise we do 14 days from now.
    const defaultRefreshExpirySec = nowSec + 14 * 24 * 3600;

    this.session = {
      accessToken: data.access_token,
      accessTokenExpiresAt: nowSec + data.expires_in,
      refreshToken: data.refresh_token ?? '',
      refreshTokenExpiresAt: defaultRefreshExpirySec,
      clientId,
    };
  }

  /**
   * Log out (clear the current session from memory). The user will need to call
   * login(clientId) again or store the session externally if they want to keep it.
   */
  public logout(): void {
    this.session = null;
  }

  /**
   * Fetches all intervals from the past week from the API (using start/end in ascending),
   * storing them in IndexedDB. This method uses paging until the entire range is fetched.
   *
   * @return {Promise<void>}
   */
  public async fetchAndStoreLastWeek(): Promise<void> {
    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    await this.fetchAndStoreRange(oneWeekAgo, now);
  }

  /**
   * Fetches and stores intervals from the API for the specified time range,
   * automatically following pages. Replaces the direct "GET /data?start=xxx&end=xxx".
   *
   * @param {number} startMs The start time in ms since epoch UTC.
   * @param {number} endMs The end time in ms since epoch UTC.
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
   * Fetches the "latest" data from the API for some small window (e.g., last 1-2 hours)
   * and appends it to IndexedDB. The recommended usage: "lastSec=7200" for 2 hours, etc.
   *
   * @param {number} lastSec The number of seconds to look back from the current time. Default=7200.
   * @return {Promise<void>}
   */
  public async fetchAndStoreLatest(lastSec = 7200): Promise<void> {
    await this.fetchAllPagesAndStore({ lastSec, limit: 100, offset: 0 });
  }

  /**
   * Retrieves records from local IndexedDB that fall within the specified
   * time range [startMs..endMs], inclusive. The data is sorted ascending by settlement time.
   *
   * @param {number} startMs Start of range in ms since epoch UTC.
   * @param {number} endMs End of range in ms since epoch UTC.
   * @return {Promise<IntervalRecord[]>} The locally stored intervals, if any.
   */
  public async getLocalDataInRange(
    startMs: number,
    endMs: number
  ): Promise<IntervalRecord[]> {
    const db = await this.ensureDb();
    return new Promise<IntervalRecord[]>((resolve, reject) => {
      const tx = db.transaction(OBJECT_STORE_NAME, 'readonly');
      const store = tx.objectStore(OBJECT_STORE_NAME);
      const index = store.index('settlement_idx');

      // We'll convert times to ISO strings (since settlement is stored in ISO).
      const startDateIso = new Date(startMs).toISOString();
      const endDateIso = new Date(endMs).toISOString();

      const range = IDBKeyRange.bound(startDateIso, endDateIso, false, false);
      const request = index.openCursor(range);
      const results: IntervalRecord[] = [];

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          results.push(cursor.value as IntervalRecord);
          cursor.continue();
        } else {
          // sort by ascending settlement
          results.sort((a, b) => {
            const dateA = a.settlement ? Date.parse(a.settlement) : 0;
            const dateB = b.settlement ? Date.parse(b.settlement) : 0;
            return dateA - dateB;
          });
          resolve(results);
        }
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  /**
   * Ensures the DB is open, returning a reference. Called internally before
   * performing any IDB operations. If needed, it triggers "initialize()".
   *
   * @return {Promise<IDBDatabase>} The IDBDatabase instance.
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
   * Internally loops over pages from the API with the given parameters (start/end or lastSec),
   * storing each page in IndexedDB until we've fetched all pages (X-Has-Next-Page == false).
   *
   * @param {PaginatedRequestParams} baseParams The base query parameters.
   * @return {Promise<void>}
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
      const data = await response.json() as IntervalRecord[];
      const newOffset = offset + data.length;

      // Store the data in IDB
      await this.storeInIndexedDb(data);

      // Check paging headers
      const xHasNext = response.headers.get('X-Has-Next-Page');
      hasNextPage = xHasNext === 'true';

      offset = newOffset;
    }
  }

  /**
   * The actual fetch call to /data with the given parameters, using an Authorization Bearer token,
   * automatically refreshing if needed. Additional error handling ensures the token remains valid.
   *
   * @param {PaginatedRequestParams} params The query parameters for /data.
   * @param {number} offset The offset for the paging.
   * @return {Promise<Response>}
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

    // Attempt to ensure a valid access token. If it fails, we throw.
    await this.ensureValidAccessToken();

    // Now do the fetch with the current access token.
    const attempt = await this.fetchWithToken(url.toString(), {
      method: 'GET',
    });

    // If we get a 401 -> try a forced refresh once and then repeat the request
    if (attempt.status === 401) {
      const refreshedOk = await this.tryRefreshTokens();
      if (!refreshedOk) {
        throw new Error('Access token expired and refresh token is invalid or expired. Please login again.');
      }
      // Retry once
      return this.fetchWithToken(url.toString(), { method: 'GET' });
    }

    return attempt;
  }

  /**
   * Makes a fetch call with the current access token. No auto-refresh. Lower-level.
   *
   * @param {string} resource Full URL string.
   * @param {RequestInit} init
   * @return {Promise<Response>}
   */
  private async fetchWithToken(resource: string, init: RequestInit): Promise<Response> {
    if (!this.session) {
      throw new Error('No session is active. You must call login(...) first.');
    }
    const headers: HeadersInit = init.headers ?? {};
    headers['Authorization'] = `Bearer ${this.session.accessToken}`;
    init.headers = headers;

    return fetch(resource, init);
  }

  /**
   * Ensures that the current access token is valid (has not expired). If it's expired,
   * tries to refresh automatically. If refresh fails, we remain with an invalid session.
   *
   * @return {Promise<void>}
   * @throws Error if no session is present or refresh is not possible.
   */
  private async ensureValidAccessToken(): Promise<void> {
    if (!this.session) {
      throw new Error('No session is active. You must call login(...) first.');
    }
    const nowSec = Math.floor(Date.now() / 1000);

    if (nowSec < this.session.accessTokenExpiresAt) {
      return; // still valid
    }

    // Otherwise, attempt to refresh
    const ok = await this.tryRefreshTokens();
    if (!ok) {
      throw new Error('Access token expired and refresh token is invalid or expired. Please login again.');
    }
  }

  /**
   * Attempts to refresh the access token using the stored refresh token. On success,
   * updates this.session with the new short-lived token details. If it fails, returns false.
   *
   * @return {Promise<boolean>} True if refresh succeeded, false if not.
   */
  private async tryRefreshTokens(): Promise<boolean> {
    if (!this.session) {
      return false;
    }
    // If the refresh token is expired, we can't do anything
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec >= this.session.refreshTokenExpiresAt) {
      return false;
    }

    const url = new URL('/refresh', this.apiBaseUrl);
    const body = {
      refresh_token: this.session.refreshToken,
    };
    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      return false;
    }
    const data = await resp.json() as Partial<TokenResponse>;
    if (!data.access_token || !data.expires_in) {
      return false;
    }

    // success
    this.session.accessToken = data.access_token;
    const now = Math.floor(Date.now() / 1000);
    this.session.accessTokenExpiresAt = now + data.expires_in;

    // The refresh call might not return a new refresh token. If it does, update:
    if (data.refresh_token) {
      this.session.refreshToken = data.refresh_token;
      // We assume the same ~14 day approach for new refresh, or it might differ in the future if the server supports that.
      this.session.refreshTokenExpiresAt = now + (14 * 24 * 3600);
    }
    return true;
  }

  /**
   * Stores a chunk of IntervalRecord objects into IndexedDB, skipping duplicates
   * or overwriting as needed (this depends on the object store's key path).
   *
   * @param {IntervalRecord[]} records An array of intervals from the API or externally formed data.
   * @return {Promise<void>}
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
        store.put(rec);
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}