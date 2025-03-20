/**
 * @fileoverview crossDomainClient.ts
 *
 * This module runs in subdomain pages (e.g. toast.example.com). It:
 *   1) Registers the service worker from the root domain (using the environment var VITE_APP_URL).
 *   2) Provides postMessage-based functions for storing/retrieving intervals from the SW.
 *
 * NOTE: Cross-origin SW registration is often blocked by browsers. If so, you may need 
 * to unify under one domain or use an iframe approach. 
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

let crossDomainSWRegistration: ServiceWorkerRegistration | null = null;
const pendingRequests = new Map<
  string,
  {
    resolve: (res: WorkerResponse) => void;
    reject: (err: WorkerResponse) => void;
  }
>();

function generateRequestId(): string {
  return 'req_' + Math.random().toString(36).slice(2) + Date.now().toString();
}

/**
 * Attempt to register the service worker from the root domain, taken from the 
 * environment variable "VITE_APP_URL". Example: "http://localhost:5173".
 * If the domain is cross-origin relative to the subdomain, many browsers may block it.
 */
export async function initializeCrossDomainServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('ServiceWorker not supported in this browser');
  }

  const rootURL = import.meta.env.VITE_APP_URL || '';
  if (!rootURL) {
    throw new Error('VITE_APP_URL environment variable is not set or empty.');
  }

  // Root domain SW script path => e.g. "http://localhost:5173/sw.js"
  const swScriptURL = `${rootURL.replace(/\/+$/, '')}/sw.js`;
  const swScope = `${rootURL.replace(/\/+$/, '')}/`; // e.g. "http://localhost:5173/"

  try {
    crossDomainSWRegistration = await navigator.serviceWorker.register(swScriptURL, {
      scope: swScope
    });
    // Wait for the service worker to be active
    await navigator.serviceWorker.ready;

    // Listener for SW responses.
    navigator.serviceWorker.addEventListener('message', (evt: MessageEvent) => {
      const response = evt.data as WorkerResponse;
      if (!response || !response.requestId || !pendingRequests.has(response.requestId)) {
        return;
      }
      const { resolve, reject } = pendingRequests.get(response.requestId)!;
      pendingRequests.delete(response.requestId);

      if (response.status === 'ok') {
        resolve(response);
      } else {
        reject(response);
      }
    });

    console.log('Cross-domain SW registration successful:', crossDomainSWRegistration);
  } catch (err) {
    console.error('Failed to register cross-domain service worker:', err);
    throw err;
  }
}

export async function storeIntervals(records: IntervalRecord[]): Promise<void> {
  const sw = navigator.serviceWorker.controller || crossDomainSWRegistration?.active;
  if (!sw) {
    throw new Error('No active service worker. Possibly cross-origin SW registration is blocked.');
  }

  const requestId = generateRequestId();
  return new Promise<void>((resolve, reject) => {
    pendingRequests.set(requestId, {
      resolve: () => resolve(),
      reject: (res) => reject(new Error(res.message ?? 'Unknown error storing intervals'))
    });

    sw.postMessage({
      requestId,
      command: 'STORE_INTERVALS',
      payload: records
    } as WorkerRequest);
  });
}

export async function getIntervalsInRange(startMs: number, endMs: number): Promise<IntervalRecord[]> {
  const sw = navigator.serviceWorker.controller || crossDomainSWRegistration?.active;
  if (!sw) {
    throw new Error('No active service worker. Possibly cross-origin SW registration is blocked.');
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