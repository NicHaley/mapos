import { FileTextIcon, Loader2Icon, MapPinIcon, MessageSquareIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useMapViewport } from "@renderer/contexts/map-viewport";
import { useDebounce } from "@renderer/hooks/use-debounce";
import { type GeocodeSearchResult, searchGeocode } from "@renderer/lib/geocode-search";
import type { ConversationMeta, PlaceRecord } from "@shared/types";
import { cn } from "@mapos/ui/lib/utils";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandPrimitive
} from "@mapos/ui/components/command";
import { InputGroup, InputGroupAddon } from "@mapos/ui/components/input-group";

const DEBOUNCE_MS = 300;
/** Cap local (file / conversation) matches so the popover stays scannable. */
const LOCAL_RESULT_LIMIT = 6;

function trimQuery(q: string): string {
  return q.trim();
}

/** Uppercase the first character; secondary labels arrive un-cased from some providers. */
function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function pickLang(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  const tag = navigator.language?.trim();
  if (!tag) return undefined;
  const short = tag.split(/[-_]/)[0];
  return short && short.length === 2 ? short : undefined;
}

function fileTypeLabel(type: string): string {
  switch (type) {
    case "place":
      return "Place";
    case "note":
      return "Note";
    case "collection":
      return "Collection";
    case "GeoJsonLayer":
      return "Layer";
    default:
      return capitalize(type);
  }
}

/** Second line for a file result: its type, qualified by the containing folder when nested. */
function fileSecondaryLabel(file: PlaceRecord): string {
  const slash = file.filePath.lastIndexOf("/");
  const dir = slash > 0 ? file.filePath.slice(0, slash) : "";
  const label = fileTypeLabel(file.type);
  return dir ? `${label} · ${dir}` : label;
}

function conversationTitle(c: ConversationMeta): string {
  return c.title || c.preview || "Chat";
}

function formatConversationDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export type GeocodeSearchPanelProps = {
  /** When false, search is idle and internal query is cleared. */
  active: boolean;
  placeholder: string;
  onSelectResult: (result: GeocodeSearchResult) => void;
  /** Indexed vault files to search locally (matched by title and path). */
  files?: PlaceRecord[];
  onSelectFile?: (file: PlaceRecord) => void;
  /** Saved conversations to search locally (matched by title and preview). */
  conversations?: ConversationMeta[];
  onSelectConversation?: (conversation: ConversationMeta) => void;
  className?: string;
  /** Shown to the right of the search field (e.g. clear action). */
  inputEndSlot?: ReactNode;
};

export function GeocodeSearchPanel({
  active,
  placeholder,
  onSelectResult,
  files,
  onSelectFile,
  conversations,
  onSelectConversation,
  className,
  inputEndSlot
}: GeocodeSearchPanelProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query, DEBOUNCE_MS);
  const [results, setResults] = useState<GeocodeSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { getViewportBBox } = useMapViewport();

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
    // Read the viewport at fire time so the bias tracks the latest pan/zoom.
    const bbox = getViewportBBox() ?? undefined;
    void searchGeocode(debouncedTrim, { signal: ac.signal, lang: pickLang(), bbox })
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
  }, [debouncedTrim, active, getViewportBBox]);

  // Local matches filter instantly against the current (un-debounced) query.
  const needle = queryTrim.toLowerCase();
  const fileMatches = useMemo(() => {
    if (!needle || !files) return [];
    return files
      .filter((f) => f.type !== "Search")
      .filter(
        (f) =>
          f.title.toLowerCase().includes(needle) || f.filePath.toLowerCase().includes(needle)
      )
      .slice(0, LOCAL_RESULT_LIMIT);
  }, [files, needle]);

  const conversationMatches = useMemo(() => {
    if (!needle || !conversations) return [];
    return conversations
      .filter((c) => conversationTitle(c).toLowerCase().includes(needle))
      .slice(0, LOCAL_RESULT_LIMIT);
  }, [conversations, needle]);

  const pick = useCallback(
    (r: GeocodeSearchResult) => {
      onSelectResult(r);
    },
    [onSelectResult]
  );

  const hasAnyResults =
    results.length > 0 || fileMatches.length > 0 || conversationMatches.length > 0;

  return (
    <Command shouldFilter={false} loop className={cn("flex flex-col", className)}>
      <div className="p-1 pb-0" data-slot="geocode-search-input">
        <InputGroup className="min-w-0 w-full">
          <InputGroupAddon align="inline-start">
            {loading || isDebouncing ? (
              <Loader2Icon className="size-4 shrink-0 animate-spin opacity-50" />
            ) : (
              <SearchIcon className="size-4 shrink-0 opacity-50" />
            )}
          </InputGroupAddon>
          <CommandPrimitive.Input
            ref={inputRef}
            value={query}
            onValueChange={setQuery}
            placeholder={placeholder}
            autoComplete="off"
            className="flex h-9 w-full min-w-0 bg-transparent text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
          />
          {inputEndSlot ? (
            <InputGroupAddon align="inline-end">{inputEndSlot}</InputGroupAddon>
          ) : null}
        </InputGroup>
      </div>
      <CommandList className="max-h-72">
        {!queryTrim && !loading && !error ? (
          <div className="flex flex-col items-center gap-2 border-0 bg-transparent px-4 py-6 text-center md:px-6">
            <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-input/30">
              <SearchIcon className="size-5 opacity-70" aria-hidden />
            </div>
            <p className="text-base font-medium">Search</p>
            <p className="max-w-[16rem] text-xs text-muted-foreground">
              Find places, files, and conversations.
            </p>
          </div>
        ) : null}
        {fileMatches.length > 0 ? (
          <CommandGroup heading="Files">
            {fileMatches.map((f) => (
              <CommandItem
                key={`file-${f.filePath}`}
                value={`file-${f.filePath}`}
                onSelect={() => onSelectFile?.(f)}
                className="items-start rounded-md"
              >
                <FileTextIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                  <span className="truncate font-medium leading-tight">{f.title}</span>
                  <span className="truncate text-xs leading-tight text-muted-foreground">
                    {capitalize(fileSecondaryLabel(f))}
                  </span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {conversationMatches.length > 0 ? (
          <CommandGroup heading="Conversations">
            {conversationMatches.map((c) => {
              const title = conversationTitle(c);
              const secondary = c.title && c.preview ? c.preview : formatConversationDate(c.updated_at);
              return (
                <CommandItem
                  key={`conv-${c.id}`}
                  value={`conv-${c.id}`}
                  onSelect={() => onSelectConversation?.(c)}
                  className="items-start rounded-md"
                >
                  <MessageSquareIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                    <span className="truncate font-medium leading-tight">{title}</span>
                    {secondary ? (
                      <span className="truncate text-xs leading-tight text-muted-foreground">
                        {capitalize(secondary)}
                      </span>
                    ) : null}
                  </div>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}
        {results.length > 0 ? (
          <CommandGroup heading="Places">
            {results.map((r, index) => {
              const value = `${r.id}-${index}`;
              return (
                <CommandItem
                  key={value}
                  value={value}
                  onSelect={() => pick(r)}
                  className="items-start rounded-md"
                >
                  <MapPinIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                    <span className="truncate font-medium leading-tight">{r.primaryLabel}</span>
                    {r.secondaryLabel ? (
                      <span className="truncate text-xs leading-tight text-muted-foreground">
                        {capitalize(r.secondaryLabel)}
                      </span>
                    ) : null}
                  </div>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}
        {error ? (
          <>
            {hasAnyResults ? <hr className="my-1 border-border" /> : null}
            <div className="px-2 py-3 text-center text-xs text-destructive">{error}</div>
          </>
        ) : null}
        {!loading && !isDebouncing && !error && queryTrim && !hasAnyResults ? (
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
      </CommandList>
    </Command>
  );
}
