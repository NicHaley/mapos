import { Loader2Icon, MapPinIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { useDebounce } from "@renderer/hooks/useDebounce";
import { type PhotonSearchResult, searchPhoton } from "@renderer/lib/photon";
import { cn } from "@renderer/lib/utils";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";

const DEBOUNCE_MS = 300;

function trimQuery(q: string): string {
  return q.trim();
}

function pickLang(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  const tag = navigator.language?.trim();
  if (!tag) return undefined;
  const short = tag.split(/[-_]/)[0];
  return short && short.length === 2 ? short : undefined;
}

export type PhotonSearchPanelProps = {
  /** When false, search is idle and internal query is cleared. */
  active: boolean;
  placeholder: string;
  onSelectResult: (result: PhotonSearchResult) => void;
  className?: string;
  /** Shown to the right of the search field (e.g. clear action). */
  inputEndSlot?: ReactNode;
};

/** Native result rows avoid cmdk CommandItem selection bugs (wrong item / first click ignored). */
export function PhotonSearchPanel({
  active,
  placeholder,
  onSelectResult,
  className,
  inputEndSlot
}: PhotonSearchPanelProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query, DEBOUNCE_MS);
  const [results, setResults] = useState<PhotonSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const debouncedTrim = trimQuery(debouncedQuery);
  const queryTrim = trimQuery(query);
  const isDebouncing = active && queryTrim !== "" && queryTrim !== debouncedTrim;

  useEffect(() => {
    if (!active) {
      setQuery("");
      setResults([]);
      setError(null);
      setLoading(false);
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    if (!debouncedTrim) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const ac = new AbortController();
    void searchPhoton(debouncedTrim, { signal: ac.signal, lang: pickLang() })
      .then((r) => {
        setResults(r);
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Search failed");
        setResults([]);
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });

    return () => {
      ac.abort();
    };
  }, [debouncedTrim, active]);

  const pick = useCallback(
    (r: PhotonSearchResult) => {
      onSelectResult(r);
    },
    [onSelectResult]
  );

  const resultButtonClass =
    "flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="p-2 pb-0" data-slot="photon-search-input">
        <InputGroup className="min-w-0 w-full">
          <InputGroupAddon align="inline-start">
            {loading || isDebouncing ? (
              <Loader2Icon className="size-4 shrink-0 animate-spin opacity-50" />
            ) : (
              <SearchIcon className="size-4 shrink-0 opacity-50" />
            )}
          </InputGroupAddon>
          <InputGroupInput
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            autoComplete="off"
          />
          {inputEndSlot ? (
            <InputGroupAddon align="inline-end">{inputEndSlot}</InputGroupAddon>
          ) : null}
        </InputGroup>
      </div>
      <div className="max-h-60 overflow-y-auto p-2">
        {!queryTrim && !loading && !error ? (
          <div className="flex flex-col items-center gap-2 border-0 bg-transparent px-4 py-6 text-center md:px-6">
            <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-input/30">
              <SearchIcon className="size-5 opacity-70" aria-hidden />
            </div>
            <p className="text-base font-medium">Search the map</p>
            <p className="max-w-[16rem] text-xs text-muted-foreground">
              Type a place name or address. Results come from OpenStreetMap via Photon.
            </p>
          </div>
        ) : null}
        {results.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            <p className="px-2 py-1 text-xs font-medium text-muted-foreground">Places</p>
            {results.map((r, index) => (
              <button
                key={`${r.id}-${index}`}
                type="button"
                className={resultButtonClass}
                onClick={() => pick(r)}
              >
                <MapPinIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                  <span className="truncate font-medium leading-tight">{r.primaryLabel}</span>
                  {r.secondaryLabel ? (
                    <span className="truncate text-xs leading-tight text-muted-foreground">
                      {r.secondaryLabel}
                    </span>
                  ) : null}
                </div>
              </button>
            ))}
          </div>
        ) : null}
        {error ? (
          <>
            {results.length > 0 ? <hr className="my-1 border-border" /> : null}
            <div className="px-2 py-3 text-center text-xs text-destructive">{error}</div>
          </>
        ) : null}
        {!loading && !isDebouncing && !error && queryTrim && results.length === 0 ? (
          <div className="flex flex-col items-center gap-2 border-0 bg-transparent px-4 py-6 text-center md:px-6">
            <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-input/30">
              <MapPinIcon className="size-5 opacity-70" aria-hidden />
            </div>
            <p className="text-base font-medium">No results</p>
            <p className="max-w-[16rem] text-xs text-muted-foreground">
              Try a different spelling or a nearby city or region.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
