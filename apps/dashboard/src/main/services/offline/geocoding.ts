import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type {
  Endpoint,
  GeocodeForwardRequest,
  GeocodeResult,
  GeocodeReverseRequest
} from "@mapos/contracts";
import type { GeocodingCapability } from "@mapos/service-adapters";

import type { GeocodeWorkerCall, GeocodeWorkerResponse } from "./geocode-query";

/**
 * Main-thread client for offline geocoding. The actual SQLite work lives in
 * `geocode-query.ts` and runs inside `geocode-worker.ts`; this module only marshals
 * requests across the port and correlates the replies.
 *
 * Why a worker at all: `better-sqlite3` is synchronous, and ranking a broad FTS
 * prefix match is expensive — `"br"*` matches ~776k rows in the us-new-york pack and
 * takes ~0.8s warm, ~3s cold, because bm25 has to score every match before the top 50
 * can be picked. Run on the main thread that is a hard freeze of the whole app. Run
 * here, the main thread's worst measured stall is ~23ms.
 *
 * The worker is spawned lazily on first use and `unref`'d so it never holds up quit.
 * If it dies, pending requests reject and the next call transparently respawns it.
 */

// Sibling of the main bundle in `out/main/` (a second rollup entry — see
// electron.vite.config.ts). Built from `import.meta.url` at runtime rather than as a
// literal `new URL("./…", import.meta.url)` so Vite doesn't rewrite it as an asset ref.
function workerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "geocode-worker.js");
}

type Pending = {
  resolve: (results: GeocodeResult[]) => void;
  reject: (error: Error) => void;
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

/** Reject everything in flight and drop the handle, so the next call respawns. */
function teardown(reason: string): void {
  worker = null;
  const inFlight = [...pending.values()];
  pending.clear();
  for (const p of inFlight) p.reject(new Error(reason));
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(workerPath());
  w.on("message", (msg: GeocodeWorkerResponse) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.results);
    else p.reject(new Error(msg.error));
  });
  w.on("error", (e) => {
    teardown(`offline geocode worker failed: ${e.message}`);
  });
  w.on("exit", (code) => {
    // Only meaningful when we didn't already tear down; a clean exit with requests
    // still outstanding would otherwise leave them hanging forever.
    if (worker === w) teardown(`offline geocode worker exited (code ${code})`);
  });
  // Don't let an idle worker keep the event loop — and the app — alive.
  w.unref();
  worker = w;
  return w;
}

function send(call: GeocodeWorkerCall): Promise<GeocodeResult[]> {
  return new Promise<GeocodeResult[]>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    try {
      getWorker().postMessage({ ...call, id });
    } catch (e) {
      pending.delete(id);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

async function forward(req: GeocodeForwardRequest, ep: Endpoint): Promise<GeocodeResult[]> {
  return send({ op: "forward", req, ep });
}

async function reverse(req: GeocodeReverseRequest, ep: Endpoint): Promise<GeocodeResult[]> {
  return send({ op: "reverse", req, ep });
}

/**
 * Drop the worker's cached SQLite handles — call when the installed region packs
 * change, so the next query reopens against the new set of files rather than reading
 * a stale or deleted inode. The worker itself is kept alive (respawning costs a
 * process-load of `better-sqlite3` for no benefit). Fire-and-forget: a failure here
 * just means the worker is already gone, which achieves the same thing.
 */
export function closeOfflineGeocodeConnections(): void {
  if (!worker) return;
  void send({ op: "close" }).catch(() => {});
}

export const offlineGeocoding: GeocodingCapability = { forward, reverse };
