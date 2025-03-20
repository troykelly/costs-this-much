/**
 * @fileoverview serviceWorkerRoot.ts
 *
 * A service worker script intended to be served from the root domain (e.g. VITE_APP_URL).
 * It manages:
 *   1) Retrieving and maintaining 7 days of intervals from our own API (using full pagination).
 *   2) Storing intervals in IndexedDB so subdomain pages can query up-to-date data.
 *   3) Responding to postMessage requests from subdomains for GET_INTERVALS (and optionally STORE_INTERVALS).
 *
 * Usage:
 *   - On install, fetch the last 7 days from the API with pagination. Automatically store in IndexedDB.
 *   - Subdomain pages register this service worker from (import.meta.env.VITE_APP_URL + '/sw.js'),
 *     then query data via postMessage.
 *
 * Author: Troy Kelly (troy@troykelly.com)
 * Created: 20 March 2025
 */

declare let self: ServiceWorkerGlobalScope;

interface ServiceWorkerGlobalScope extends Worker {
  addEventListener(
    type: 'install' | 'activate' | 'message' | 'fetch' | string,
    listener: (event: any) => void
  ): void;
}

/**
 * IntervalRecord
 */
interface IntervalRecord {
  settlement: string | null;
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

interface MessageEventData {
  requestId: string;
  command: 'STORE_INTERVALS' | 'GET_INTERVALS';
  payload?: any;
}

/**
 * Constants for the IndexedDB usage below.
 */
const DB_NAME = 'costsThisMuchGlobalDB';
const DB_VERSION = 1;
const STORE_NAME = 'intervals';

/**
 * Base URL for the new API, read from the environment variable (Vite).
 * Example: VITE_API_URL = 'https://api.coststhismuch.au' or 'http://localhost:8787'
 */
const API_BASE_URL = import.meta.env.VITE_API_URL || '';

/**
 * On install, we fetch the last 7 days from the new API with full pagination
 * to ensure we have a complete set in IndexedDB.
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await self.skipWaiting();
      const now = Date.now();
      const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
      await fetchAndStoreRange(oneWeekAgo, now).catch((err) => {
        // You could log or ignore errors here
        console.error('SW install - fetch 7 days failed:', err);
      });
    })()
  );
});

/**
 * Activate event ensures the service worker becomes the controlling worker.
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * Fetch event: Not used for offline caching. We rely on message-based access.
 */
self.addEventListener('fetch', (_event) => {
  // No fetch override is provided here. 
});

/**
 * Message event: The interface for subdomains to retrieve or store intervals.
 */
self.addEventListener('message', async (evt: MessageEvent) => {
  const data = evt.data as MessageEventData;
  if (!data || !data.command || !data.requestId) {
    return;
  }

  try {
    switch (data.command) {
      case 'STORE_INTERVALS': {
        const records = data.payload as IntervalRecord[];
        await storeIntervals(records);
        evt.source?.postMessage?.({
          requestId: data.requestId,
          status: 'ok',
          storedCount: records.length
        });
        break;
      }

      case 'GET_INTERVALS': {
        if (!data.payload || typeof data.payload.startMs !== 'number' || typeof data.payload.endMs !== 'number') {
          throw new Error('Invalid GET_INTERVALS payload');
        }
        const { startMs, endMs } = data.payload;
        const intervals = await getIntervalsInRange(startMs, endMs);
        evt.source?.postMessage?.({
          requestId: data.requestId,
          status: 'ok',
          intervals
        });
        break;
      }

      default:
        throw new Error(`Unknown command: ${data.command}`);
    }
  } catch (err: any) {
    evt.source?.postMessage?.({
      requestId: data.requestId,
      status: 'error',
      message: err?.message || String(err)
    });
  }
});

/**
 * Open (or upgrade) the global IndexedDB instance.
 */
async function openGlobalDB(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function () {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: 'id',
          autoIncrement: true
        });
        // For quick time-range queries.
        store.createIndex('settlement_idx', 'settlement', { unique: false });
        // Composite uniqueness by settlement+regionid.
        store.createIndex('settlement_region_idx', ['settlement', 'regionid'], { unique: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Store intervals in the global IDB. Duplicates based on settlement+regionid are updated.
 */
async function storeIntervals(records: IntervalRecord[]): Promise<void> {
  if (!records || !records.length) return;
  const db = await openGlobalDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  for (const rec of records) {
    store.put(rec);
  }
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Retrieve intervals whose settlement is in [startMs..endMs].
 */
async function getIntervalsInRange(startMs: number, endMs: number): Promise<IntervalRecord[]> {
  const db = await openGlobalDB();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const idx = store.index('settlement_idx');

  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const range = IDBKeyRange.bound(startIso, endIso, false, false);

  const results: IntervalRecord[] = [];
  return new Promise<IntervalRecord[]>((resolve, reject) => {
    const cursorReq = idx.openCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        results.push(cursor.value as IntervalRecord);
        cursor.continue();
      } else {
        results.sort((a, b) => {
          const da = a.settlement ? Date.parse(a.settlement) : 0;
          const db = b.settlement ? Date.parse(b.settlement) : 0;
          return da - db;
        });
        resolve(results);
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

/**
 * Fetch intervals from [startMs..endMs] with pagination, store in IDB.
 */
async function fetchAndStoreRange(startMs: number, endMs: number): Promise<void> {
  let offset = 0;
  let hasNextPage = true;

  while (hasNextPage) {
    const url = new URL('/data', API_BASE_URL);
    url.searchParams.set('start', String(startMs));
    url.searchParams.set('end', String(endMs));
    url.searchParams.set('limit', '100');
    url.searchParams.set('offset', String(offset));
    // Ascending by settlement
    const resp = await fetch(url.toString());
    if (!resp.ok) {
      const txt = await resp.text();
      console.error('API error fetching intervals:', txt);
      throw new Error(`Failed to fetch intervals (status=${resp.status})`);
    }
    const data = (await resp.json()) as IntervalRecord[];
    if (!data || !Array.isArray(data)) {
      throw new Error('Response did not contain an array of intervals.');
    }
    await storeIntervals(data);

    const xHasNext = resp.headers.get('X-Has-Next-Page');
    hasNextPage = xHasNext === 'true';
    offset += data.length;
  }
}