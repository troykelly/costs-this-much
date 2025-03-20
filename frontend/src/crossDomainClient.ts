/**
 * @fileoverview crossDomainClient.ts
 *
 * This module runs in subdomain pages (e.g. toast.coststhismuch.au). It attempts to:
 *   1) Register the service worker from the root domain (if allowed by the browser).
 *   2) Provide two main functions: storeIntervals() and getIntervalsInRange() which
 *      use postMessage to talk to the root worker's IDB.
 *
 * NOTE: Most browsers block cross-origin service worker registration. If so, an error
 * "Failed to register a ServiceWorker" will occur. In that case, consider an iframe-based
 * approach or unify your domain.
 *
 * Author: Troy Kelly (troy@troykelly.com)
 * Created: 20 March 2025
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

interface WorkerRequest {
  requestId: string;
  command: 'STORE_INTERVALS' | 'GET_INTERVALS';
  payload?: any;
}

interface WorkerResponse {
  requestId: string;
  status: 'ok' | 'error';
  intervals?: IntervalRecord[];
  storedCount?: number;
  message?: string;
}

/**
 * A simple generator function to produce unique IDs for matching requests to responses.
 */
function generateRequestId(): string {
  return 'req_' + Math.random().toString(36).slice(2) + Date.now().toString();
}

/**
 * Global reference to the cross-domain service worker registration if it succeeds.
 */
let crossDomainSWRegistration: ServiceWorkerRegistration | null = null;

/**
 * A map from requestId -> promise resolvers so we can correlate the async response.
 */
const pendingRequests = new Map<
  string,
  {
    resolve: (res: WorkerResponse) => void;
    reject: (err: WorkerResponse) => void;
  }
>();

/**
 * Attempt to register the service worker from the root domain, e.g. "https://coststhismuch.au/sw.js".
 * If blocked by the browser, you'll get a SecurityError in the console.
 */
export async function initializeCrossDomainServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('ServiceWorker not supported in this browser');
  }

  try {
    // Adjust domain & scope if your root domain is something else:
    crossDomainSWRegistration = await navigator.serviceWorker.register(
      'https://coststhismuch.au/sw.js',
      {
        scope: 'https://coststhismuch.au/' // requires crossOriginIsolated or special headers
      }
    );

    // Wait for the service worker to be active
    await navigator.serviceWorker.ready;

    // Add a message listener on this subdomain to handle responses from the root SW
    navigator.serviceWorker.addEventListener('message', (evt: MessageEvent) => {
      const response = evt.data as WorkerResponse;
      if (!response || !response.requestId || !pendingRequests.has(response.requestId)) {
        return; // Not relevant
      }

      const { resolve, reject } = pendingRequests.get(response.requestId)!;
      pendingRequests.delete(response.requestId);

      if (response.status === 'ok') {
        resolve(response);
      } else {
        reject(response);
      }
    });

    console.log('Cross-domain SW registration succeeded:', crossDomainSWRegistration);
  } catch (err) {
    console.error('Failed to register cross-domain service worker:', err);
    throw err;
  }
}

/**
 * Store an array of intervals in the root domain’s IndexedDB by sending
 * a message to the service worker.
 */
export async function storeIntervals(records: IntervalRecord[]): Promise<void> {
  if (!crossDomainSWRegistration?.active && !navigator.serviceWorker.controller) {
    throw new Error('Service worker not active. Did you call initializeCrossDomainServiceWorker()?');
  }

  const sw = navigator.serviceWorker.controller || crossDomainSWRegistration.active;
  if (!sw) {
    throw new Error('No active service worker. Possibly the cross-domain registration is blocked.');
  }

  const requestId = generateRequestId();
  return new Promise<void>((resolve, reject) => {
    // Save the resolvers so we can complete asynchronously
    pendingRequests.set(requestId, {
      resolve: (res) => resolve(),
      reject: (res) => reject(new Error(res.message ?? 'Unknown error storing intervals'))
    });

    sw.postMessage({
      requestId,
      command: 'STORE_INTERVALS',
      payload: records
    } as WorkerRequest);
  });
}

/**
 * Retrieve intervals from [startMs..endMs] from the root domain’s IndexedDB via the service worker.
 */
export async function getIntervalsInRange(startMs: number, endMs: number): Promise<IntervalRecord[]> {
  if (!crossDomainSWRegistration?.active && !navigator.serviceWorker.controller) {
    throw new Error('Service worker not active. Did you call initializeCrossDomainServiceWorker()?');
  }

  const sw = navigator.serviceWorker.controller || crossDomainSWRegistration.active;
  if (!sw) {
    throw new Error('No active service worker. Possibly the cross-domain registration is blocked.');
  }

  const requestId = generateRequestId();
  return new Promise<IntervalRecord[]>((resolve, reject) => {
    pendingRequests.set(requestId, {
      resolve: (res) => resolve(res.intervals || []),
      reject: (res) => reject(new Error(res.message ?? 'Unknown SW error retrieving intervals'))
    });

    sw.postMessage({
      requestId,
      command: 'GET_INTERVALS',
      payload: { startMs, endMs }
    } as WorkerRequest);
  });
}