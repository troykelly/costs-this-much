/**
 * Service Worker (sw.js)
 *
 * This file is served as-is from the "public/" folder. Vite doesn't process it,
 * so "import.meta.env" won't work inside here.
 *
 * Instead, we wait for the main application to send us the API URL via postMessage.
 * Once we have that URL, we do the 7-day fetch. Meanwhile, the service worker can
 * still respond to GET_INTERVALS or STORE_INTERVALS messages with the same IndexedDB logic.
 */

let API_BASE_URL = '';  // Will be set via postMessage from main.tsx

const DB_NAME = 'costsThisMuchGlobalDB';
const DB_VERSION = 1;
const STORE_NAME = 'intervals';

/**
 * Handle the 'install' event. Since we don't yet know the API URL, we won't attempt
 * any data fetch here. Instead, we'll wait for 'CONFIGURE_API'.
 */
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

/**
 * Become active immediately.
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * We do not intercept fetch requests for offline usage here, so we leave fetch alone.
 */
self.addEventListener('fetch', () => {
  // No offline fetch handling
});

/**
 * Listen for messages from client pages. This includes:
 *   - CONFIGURE_API: sets the API_BASE_URL and optionally triggers 7‑day fetch
 *   - STORE_INTERVALS: store provided intervals in IndexedDB
 *   - GET_INTERVALS: retrieve intervals from IndexedDB in [startMs..endMs]
 */
self.addEventListener('message', async (evt) => {
  if (!evt.data || !evt.data.command || !evt.data.requestId) {
    return;
  }

  try {
    switch (evt.data.command) {
      case 'CONFIGURE_API': {
        // e.g. { requestId, command: 'CONFIGURE_API', apiBaseURL: '...' }
        API_BASE_URL = evt.data.apiBaseURL || '';
        if (!API_BASE_URL) {
          throw new Error('API base URL is empty or missing.');
        }
        // Immediately fetch and store the last 7 days of intervals
        const now = Date.now();
        const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
        await fetchAndStoreRange(oneWeekAgo, now);

        evt.source?.postMessage?.({
          requestId: evt.data.requestId,
          status: 'ok',
          message: `API base URL set to '${API_BASE_URL}', and 7-day fetch complete.`
        });
        break;
      }

      case 'STORE_INTERVALS': {
        const records = evt.data.payload;
        if (Array.isArray(records)) {
          await storeIntervals(records);
        }
        evt.source?.postMessage?.({
          requestId: evt.data.requestId,
          status: 'ok',
          storedCount: Array.isArray(records) ? records.length : 0
        });
        break;
      }

      case 'GET_INTERVALS': {
        if (!evt.data.payload ||
            typeof evt.data.payload.startMs !== 'number' ||
            typeof evt.data.payload.endMs !== 'number') {
          throw new Error('Invalid GET_INTERVALS payload');
        }
        const { startMs, endMs } = evt.data.payload;
        const intervals = await getIntervalsInRange(startMs, endMs);
        evt.source?.postMessage?.({
          requestId: evt.data.requestId,
          status: 'ok',
          intervals
        });
        break;
      }

      default:
        throw new Error(`Unknown command: ${evt.data.command}`);
    }

  } catch (err) {
    evt.source?.postMessage?.({
      requestId: evt.data.requestId,
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    });
  }
});

/**
 * Open or create the global IndexedDB.
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
        store.createIndex('settlement_idx', 'settlement');
        store.createIndex('settlement_region_idx', ['settlement', 'regionid'], { unique: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Store intervals in the DB, updating duplicates by settlement+regionid.
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
 * Retrieve intervals in [startMs..endMs], sorted ascending by settlement.
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
 * Fetch intervals from [startMs..endMs] in 100-record increments with next-page logic.
 */
async function fetchAndStoreRange(startMs, endMs) {
  if (!API_BASE_URL) {
    throw new Error('API_BASE_URL is not configured.');
  }
  let offset = 0;
  let hasNext = true;

  while (hasNext) {
    const url = new URL('/data', API_BASE_URL);
    url.searchParams.set('start', String(startMs));
    url.searchParams.set('end', String(endMs));
    url.searchParams.set('limit', '100');
    url.searchParams.set('offset', String(offset));

    const resp = await fetch(url.toString());
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Fetch intervals failed (status=${resp.status}): ${txt}`);
    }
    const data = await resp.json();
    if (!Array.isArray(data)) {
      throw new Error('Response did not contain an array of intervals.');
    }
    await storeIntervals(data);

    const xHasNext = (resp.headers.get('X-Has-Next-Page') || '').trim().toLowerCase();
    hasNext = (xHasNext === 'true');
    offset += data.length;
  }
}