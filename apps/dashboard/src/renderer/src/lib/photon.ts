/**
 * Renderer-side search helper. Routes through the main-process dispatcher via
 * IPC so the active services mode (community / cloud / self-hosted) governs
 * which provider actually serves the request. The function name remains
 * `searchPhoton` for backward compatibility with existing consumers — the
 * underlying provider is no longer guaranteed to be Photon.
 */

import type { GeocodeResult } from "@mapos/contracts";

export type PhotonSearchResult = GeocodeResult;

type SearchOptions = {
  /** Abort detection is client-side: in-flight main-process requests run to completion, but the resulting promise rejects with AbortError so stale results are dropped. */
  signal?: AbortSignal;
  lang?: string;
};

export async function searchPhoton(
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
