/**
 * Renderer-side geocoding search helper. Routes through the main-process dispatcher
 * via IPC so the active services mode (local / cloud) governs which backend actually
 * serves the request — offline region packs in local mode, the MapOS server in cloud
 * mode. The renderer is backend-agnostic.
 */

import type { GeocodeResult } from "@mapos/contracts";

export type GeocodeSearchResult = GeocodeResult;

type SearchOptions = {
  /** Abort detection is client-side: in-flight main-process requests run to completion, but the resulting promise rejects with AbortError so stale results are dropped. */
  signal?: AbortSignal;
  lang?: string;
};

export async function searchGeocode(
  query: string,
  options: SearchOptions = {}
): Promise<GeocodeResult[]> {
  if (options.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  return new Promise<GeocodeResult[]>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new DOMException("Aborted", "AbortError"));
    };
    options.signal?.addEventListener("abort", onAbort);

    window.api.services
      .geocodingForward({
        query,
        ...(options.lang ? { lang: options.lang } : {})
      })
      .then(resolve, reject)
      .finally(() => {
        options.signal?.removeEventListener("abort", onAbort);
      });
  });
}
