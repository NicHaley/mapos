import { parentPort } from "node:worker_threads";

import {
  type GeocodeWorkerRequest,
  type GeocodeWorkerResponse,
  handleGeocodeRequest
} from "./geocode-query";

/**
 * Worker-thread entry for offline geocoding. Its whole job is to keep the
 * synchronous `better-sqlite3` work off the Electron main thread: a broad prefix
 * search over a metro-sized pack takes hundreds of milliseconds to seconds, which
 * on the main thread freezes every window (macOS beach ball).
 *
 * This is a separate rollup entry — see `electron.vite.config.ts`, which emits it
 * as `out/main/geocode-worker.js` alongside the main bundle. `better-sqlite3` stays
 * external and is loaded here, in this thread; the addon is context-aware
 * (`NODE_MODULE_INIT` with per-isolate state), which is what makes it legal to load
 * in a worker under Electron.
 *
 * Requests are handled strictly FIFO — one message, one reply, correlated by `id`.
 * There's no cancellation: SQLite can't interrupt a running query, so an abandoned
 * search still costs its own time and delays whatever is behind it. That's a latency
 * cost, not a responsiveness one — the main thread never waits on any of it.
 */

if (!parentPort) throw new Error("geocode-worker must be started as a worker thread");
const port = parentPort;

port.on("message", (msg: GeocodeWorkerRequest) => {
  let response: GeocodeWorkerResponse;
  try {
    response = { id: msg.id, ok: true, results: handleGeocodeRequest(msg) };
  } catch (e) {
    response = { id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  port.postMessage(response);
});
