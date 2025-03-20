/**
 * Service Worker (sw.js)
 *
 * Fetches and stores the last 7 days of intervals from our custom API using full pagination,
 * storing them in IndexedDB. Subdomain or querystring-based pages can communicate via postMessage
 * to retrieve or store intervals in this shared database. The base domain for the API is taken
 * from "import.meta.env.VITE_API_URL" if available; otherwise defaults to empty string.
 *
 * Usage:
 *   - On install, fetch the last 7 days from the API with full pagination.
 *   - Subdomains (or local dev with querystring) postMessage { requestId, command: 'GET_INTERVALS', payload: {startMs, endMs}} 
 *     or 'STORE_INTERVALS' to this service worker to share data.
 */

// We rely on modern browsers to allow import.meta.env for environment variables:
const API_BASE_URL = (typeof import !== 'undefined' && import.meta && import.meta.env && import.meta.env.VITE_API_URL) || '';

const DB_NAME = 'costsThisMuchGlobalDB';
const DB_VERSION = 1;
const STORE_NAME = 'intervals';

// On install: fetch the last 7 days with pagination and store in IndexedDB
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await self.skipWaiting();
      const now = Date.now();
      const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
      try {
        await fetchAndStoreRange(oneWeekAgo, now);
      } catch (err) {
        console.error('SW install - failed to fetch 7 days:', err);
      }
    })()
  );
});

// Activate event: become the controlling service worker
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// We do not override fetch requests for offline; 
// all usage is via message-based communication.
self.addEventListener('fetch', () => {});

// Listen for messages from subdomains or local pages
self.addEventListener('message', async (evt) => {
  const data = evt.data;
  if (!data || !data.command || !data.requestId) {
    return;
  }

  try {
    switch (data.command) {
      case 'STORE_INTERVALS': {
        const records = data.payload;
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
  } catch (err) {
    evt.source?.postMessage?.({
      requestId: data.requestId,
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    });
  }
});

/**
 * Opens or upgrades the global IndexedDB instance.
 */
async function openGlobalDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function () {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: 'id',
          autoIncrement: true
        });
        store.createIndex('settlement_idx', 'settlement', { unique: false });
        store.createIndex('settlement_region_idx', ['settlement', 'regionid'], { unique: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Stores intervals in IndexedDB, updating duplicates based on settlement+regionid.
 */
async function storeIntervals(records) {
  if (!records || !records.length) return;
  const db = await openGlobalDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  for (const rec of records) {
    store.put(rec);
  }
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Retrieves intervals whose settlement in [startMs..endMs], sorted ascending by settlement.
 */
async function getIntervalsInRange(startMs, endMs) {
  const db = await openGlobalDB();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const idx = store.index('settlement_idx');

  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const range = IDBKeyRange.bound(startIso, endIso, false, false);

  const results = [];
  return new Promise((resolve, reject) => {
    const cursorReq = idx.openCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        // Sort ascending by settlement date
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
 * Fetch intervals from [startMs..endMs] in 100-record pages, store in IDB.
 */
async function fetchAndStoreRange(startMs, endMs) {
  let offset = 0;
  let hasNextPage = true;

  while (hasNextPage) {
    const url = new URL('/data', API_BASE_URL);
    url.searchParams.set('start', String(startMs));
    url.searchParams.set('end', String(endMs));
    url.searchParams.set('limit', '100');
    url.searchParams.set('offset', String(offset));

    const resp = await fetch(url.toString());
    if (!resp.ok) {
      const txt = await resp.text();
      console.error('API error fetching intervals:', txt);
      throw new Error(`Failed to fetch intervals (status=${resp.status})`);
    }
    const data = await resp.json();
    if (!Array.isArray(data)) {
      throw new Error('Response did not contain an array of intervals.');
    }

    await storeIntervals(data);

    // Check if server indicates another page
    const xHasNext = (resp.headers.get('X-Has-Next-Page') || '').trim().toLowerCase();
    hasNextPage = (xHasNext === 'true');
    offset += data.length;
  }
}