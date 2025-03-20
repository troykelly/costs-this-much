/**
 * @fileoverview serviceWorkerRoot.ts
 *
 * A service worker script intended to be served from the root domain (e.g. coststhismuch.au)
 * It manages a single IndexedDB to store intervals from the CostsThisMuch API. Subdomain pages
 * postMessage to this service worker requesting data or storing new intervals. The worker
 * responds with the requested data or a status message.
 *
 * NOTE: Cross-origin SW registration is restricted by browsers. This is an example of how you'd
 * do it if your setup allows or if everything is served from the same domain.
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
 * Opens (or upgrades) the single global IndexedDB instance.
 */
function openGlobalDB(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function (event) {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: 'id',
          autoIncrement: true
        });
        // For quick time range queries: remain consistent with storing settlement as ISO string
        store.createIndex('settlement_idx', 'settlement', { unique: false });
        // Composite uniqueness by settlement+regionid if you want to skip duplicates
        store.createIndex('settlement_region_idx', ['settlement', 'regionid'], { unique: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Writes an array of intervals to IndexedDB.
 * If duplicates (same settlement+regionid) exist, they are updated (due to the unique index).
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
 * Retrieves all intervals whose 'settlement' is in [startIso..endIso].
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
        // sort by settlement ascending
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
 * Install event: typical practice to skip waiting or to cache static files.
 */
self.addEventListener('install', (event) => {
  // If you want immediate activation:
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  event.waitUntil(self.skipWaiting());
});

/**
 * Activate event: typical practice to clean up old caches or old DB versions.
 */
self.addEventListener('activate', (event) => {
  // Claim clients so this worker is active immediately for all pages under scope
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  event.waitUntil(self.clients.claim());
});

/**
 * Fetch event: Not used here for offline HTML caching. We rely on message passing to store/fetch intervals.
 * You can add offline fetch handling if desired.
 */
self.addEventListener('fetch', (event) => {
  // console.log('[ServiceWorker] fetch event for ', event.request.url);
  // You can respond with custom caching logic here if needed.
});

/**
 * Message event: The main interface for subdomains to request data or store intervals.
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