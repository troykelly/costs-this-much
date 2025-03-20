/**
 * @fileoverview AemoApiClient.ts - Provides a production-ready client library for interacting
 * with the CostsThisMuch API, managing data in the browser's IndexedDB for offline access
 * and efficient retrieval. This library can be integrated directly into your frontend code
 * or a service worker, providing:
 *
 * 1. Secure storage of fetched results in IndexedDB.
 * 2. Methods to retrieve the last week of data from the API and store it locally.
 * 3. Methods to query locally stored data by time ranges—similar to the API's /data endpoint.
 * 4. Support for paging until all results are fetched (the API sets paging headers).
 * 5. Methods for incrementally updating local storage with the most recent data.
 * 6. Configuration for Bearer token-based authentication (short-lived tokens).
 *
 * Usage Example:
 * ---------------------------------------------------------------------------
 *   import { AemoApiClient } from './AemoApiClient';
 *
 *   async function main(): Promise<void> {
 *     const client = new AemoApiClient({
 *       apiBaseUrl: 'https://api.coststhismuch.au',
 *     });
 *
 *     // Initialize the IndexedDB structure
 *     await client.initialize();
 *
 *     // Set your access token (obtained from the /token endpoint)
 *     client.setAccessToken('YOUR_SHORT_LIVED_JWT_HERE');
 *
 *     // Fetch the last week of data from the API, store in IndexedDB
 *     await client.fetchAndStoreLastWeek();
 *
 *     // Retrieve a time range from local DB
 *     const someStartTime = Date.now() - 2 * 24 * 60 * 60 * 1000; // 2 days ago
 *     const someEndTime = Date.now(); // now
 *     const localData = await client.getLocalDataInRange(someStartTime, someEndTime);
 *     console.log('Retrieved from local DB:', localData);
 *
 *     // Update with the most recent intervals (past hour or two) from the API
 *     await client.fetchAndStoreLatest();
 *   }
 * ---------------------------------------------------------------------------
 *
 * Author: Troy Kelly <troy@troykelly.com>
 * Created: 20 March 2025
 */

const DB_NAME = 'aemo_intervals_db';
const DB_VERSION = 1;
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
 * Options for creating an AemoApiClient.
 */
export interface AemoApiClientOptions {
  /**
   * Base URL for the costsThisMuch API, e.g. "https://api.coststhismuch.au"
   */
  apiBaseUrl: string;

  /**
   * Optional initial Bearer token to set.
   * If not provided, one can be set later via setAccessToken().
   */
  initialAccessToken?: string;
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

/**
 * AemoApiClient - A library to fetch and store data from the
 * costsThisMuch API in IndexedDB, and provide local queries.
 */
export class AemoApiClient {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private readonly apiBaseUrl: string;
  private accessToken: string | null = null;

  /**
   * Constructs a new AemoApiClient instance.
   *
   * @param {AemoApiClientOptions} options Configuration options for the client.
   */
  constructor(options: AemoApiClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl;
    if (options.initialAccessToken) {
      this.accessToken = options.initialAccessToken;
    }
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
   * Sets or updates the Bearer token to be used for all API requests.
   *
   * @param {string} token Short-lived JWT or similar.
   */
  public setAccessToken(token: string): void {
    this.accessToken = token;
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
          resolve(results.sort((a, b) => {
            const dateA = a.settlement ? Date.parse(a.settlement) : 0;
            const dateB = b.settlement ? Date.parse(b.settlement) : 0;
            return dateA - dateB;
          }));
        }
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
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
   * and appends it to IndexedDB. The recommended usage: "set lastSec=7200" for 2 hours,
   * though you can pick any suitable window.
   *
   * @param {number} lastSec The number of seconds to look back from the current server time.
   *     Defaults to 7200 (2 hours) if not specified.
   * @return {Promise<void>}
   */
  public async fetchAndStoreLatest(lastSec = 7200): Promise<void> {
    await this.fetchAllPagesAndStore({ lastSec, limit: 100, offset: 0 });
  }

  /**
   * Internally loops over pages from the API with the given parameters (start/end or lastSec),
   * storing each page in IndexedDB until we've fetched all pages (X-Has-Next-Page == false).
   *
   * @param {PaginatedRequestParams} baseParams The base query parameters (start/end, lastSec, limit=100, offset=0, etc.).
   * @return {Promise<void>}
   */
  private async fetchAllPagesAndStore(baseParams: PaginatedRequestParams): Promise<void> {
    let offset = 0;
    let hasNextPage = true;

    while (hasNextPage) {
      const response = await this.fetchDataApi({ ...baseParams, offset });
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
   * Perform the actual data fetch from the /data endpoint on the costsThisMuch API,
   * applying the provided query parameters. Expects a short-lived Bearer token set.
   *
   * @param {PaginatedRequestParams} params The query parameters to pass to /data.
   * @return {Promise<Response>} The raw fetch response, including headers for paging.
   */
  private async fetchDataApi(params: PaginatedRequestParams): Promise<Response> {
    if (!this.accessToken) {
      throw new Error('No access token set. Please call setAccessToken(...) first.');
    }
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
    if (typeof params.limit === 'number') {
      url.searchParams.set('limit', String(params.limit));
    }
    if (typeof params.offset === 'number') {
      url.searchParams.set('offset', String(params.offset));
    }
    // For an ascending fetch, we rely on start/end usage from the API. 
    // If there's no start/end, the server returns descending by default. 
    // We do not have an official "ascending" param in the server, so we won't handle it beyond that.

    return fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
      },
    });
  }

  /**
   * Stores a chunk of IntervalRecord objects into IndexedDB, skipping duplicates or overwriting as needed.
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

  /**
   * Ensures the DB is open, returning a reference. call initialize() first,
   * or rely on lazy initialization if not done yet.
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
}