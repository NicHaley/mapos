import { Loader2Icon, MapPinIcon, SearchIcon, TextSearchIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandPrimitive,
  CommandShortcut
} from "@mapos/ui/components/command";
import { InputGroup, InputGroupAddon } from "@mapos/ui/components/input-group";
import { Kbd, KbdGroup } from "@mapos/ui/components/kbd";
import { cn } from "@mapos/ui/lib/utils";
import { useMapViewport } from "@renderer/contexts/map-viewport";
import { useDebounce } from "@renderer/hooks/use-debounce";
import { modSymbol, useShortcuts } from "@renderer/hooks/use-shortcuts";
import { type GeocodeSearchResult, searchGeocode } from "@renderer/lib/geocode-search";
import { scoreNameMatch } from "@shared/name-match";
import type { PlaceRecord } from "@shared/types";
import { VaultFileIcon } from "./vault-file-icon";

const DEBOUNCE_MS = 300;
/** Cap local (file) matches so the popover stays scannable. */
const LOCAL_RESULT_LIMIT = 6;
/** Cap place results shown in the popover; the full set opens via "Open all as a list". */
const POPOVER_RESULT_LIMIT = 5;
/** How many results to request from the backend (clamped to 50). The popover shows the
 *  first few; the rest are reachable via "Open all as a list". */
const SEARCH_RESULT_LIMIT = 50;
/** ⌘1–⌘9 select the Nth visible result; one keyboard row's worth. */
const MAX_HOTKEYS = 9;
/**
 * Stand-in cmdk value meaning "nothing is highlighted". Any value that matches no row
 * would do; NUL is used because it can never occur in a file path or a result id, so
 * it cannot collide with a real row.
 */
const NO_HIGHLIGHT = "\u0000";
/** Keys cmdk handles by moving the highlight — see `userMovedSelection`. */
const MOVE_SELECTION_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"]);

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

/**
 * Context for a file result: its containing folder, relative to the vault root
 * ("tokyo-2026", not "/Users/…/MapOS/tokyo-2026"). Empty for files at the root.
 */
function fileRelativeDir(filePath: string, vaultRoot: string): string {
  const rel =
    vaultRoot && filePath.startsWith(vaultRoot)
      ? filePath.slice(vaultRoot.length).replace(/^\//, "")
      : filePath;
  const slash = rel.lastIndexOf("/");
  return slash > 0 ? rel.slice(0, slash) : "";
}

/**
 * Electron wraps IPC failures as "Error invoking remote method '…': SomeError: <msg>".
 * Strip the invoke wrapper and the error-class prefix so the user sees the human
 * reason, not a stack-trace-looking string.
 */
function cleanErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : "";
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^\w*Error:\s*/, "")
    .trim();
  return cleaned || "Search failed";
}

/** A row reachable via ⌘N, in display order (files → places). */
type HotkeyTarget =
  | { kind: "file"; file: PlaceRecord }
  | { kind: "place"; result: GeocodeSearchResult };

/**
 * Right-aligned ⌘N chip on a result row. `index` is the row's flattened position.
 * Wrapped in CommandShortcut: its `data-slot` is what hides CommandItem's built-in
 * trailing CheckIcon — otherwise the two `ml-auto` elements split the free space
 * and the chip floats mid-row instead of hugging the right edge.
 */
function HotkeyHint({ index }: { index: number }): React.JSX.Element | null {
  if (index >= MAX_HOTKEYS) return null;
  return (
    <CommandShortcut className="shrink-0 self-center">
      <KbdGroup>
        <Kbd>{modSymbol}</Kbd>
        <Kbd>{index + 1}</Kbd>
      </KbdGroup>
    </CommandShortcut>
  );
}

export type GeocodeSearchPanelProps = {
  /** When false, search is idle and internal query is cleared. */
  active: boolean;
  placeholder: string;
  onSelectResult: (result: GeocodeSearchResult) => void;
  /** Indexed vault files to search locally (matched by title and path). */
  files?: PlaceRecord[];
  onSelectFile?: (file: PlaceRecord) => void;
  /** When provided and there are place or file matches, offers "open all as a list".
   *  `files` are the matched vault files, included in the list as vault rows. */
  onOpenResults?: (results: GeocodeSearchResult[], query: string, files: PlaceRecord[]) => void;
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
  onOpenResults,
  className,
  inputEndSlot
}: GeocodeSearchPanelProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query, DEBOUNCE_MS);
  const [results, setResults] = useState<GeocodeSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Controlled cmdk selection. Kept empty so nothing is highlighted by default (cmdk
  // otherwise auto-selects the first item); ArrowDown moves to the first result, and
  // Enter with nothing highlighted runs the default "open all" action (see onKeyDown).
  const [selected, setSelected] = useState("");
  // cmdk schedules a "highlight the first item" pass every time its internal `search`
  // state changes — i.e. on every keystroke — and pushes it out through onValueChange.
  // That fights the empty default above: the highlight appeared on each keystroke and
  // vanished again when the debounced results landed. So writes are accepted only when
  // they came from the user actually moving through the list.
  //
  // This has to be a ref, not state: cmdk calls onValueChange *synchronously* from its
  // own keydown handler, in the same event dispatch as the keydown below, so a state
  // flag set here would still read stale when the decision is made.
  const userMovedSelection = useRef(false);
  // Refusing the write above isn't enough on its own: cmdk keeps its own copy of the
  // highlighted value and only re-reads the controlled prop when that prop *changes*,
  // so its copy would stay pointing at the first row and keep it lit. Bumping this
  // hands cmdk a value it hasn't seen, which forces the re-read.
  const [selectionResets, setSelectionResets] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { getViewportBBox } = useMapViewport();
  // Vault root, for showing file locations as vault-relative folders.
  const [vaultRoot, setVaultRoot] = useState("");
  useEffect(() => {
    void window.api.fs.getVaultRoot().then(setVaultRoot);
  }, []);

  const debouncedTrim = trimQuery(debouncedQuery);
  const queryTrim = trimQuery(query);
  const isDebouncing = active && queryTrim !== "" && queryTrim !== debouncedTrim;

  useEffect(() => {
    if (!active) {
      setQuery("");
      setResults([]);
      setError(null);
      setLoading(false);
      setSelected("");
      userMovedSelection.current = false;
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
    void searchGeocode(debouncedTrim, {
      signal: ac.signal,
      lang: pickLang(),
      bbox,
      limit: SEARCH_RESULT_LIMIT
    })
      .then((r) => {
        setResults(r);
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === "AbortError") return;
        setError(cleanErrorMessage(e));
        setResults([]);
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });

    return () => {
      ac.abort();
    };
  }, [debouncedTrim, active, getViewportBBox]);

  // Local matches filter instantly against the current (un-debounced) query, fuzzy-scored
  // and ranked best-first. Paths are scored vault-relative (and damped vs the title) so a
  // query can name a folder without home-directory segments matching everything.
  const allFileMatches = useMemo(() => {
    if (!queryTrim || !files) return [];
    return files
      .filter((f) => f.type !== "Search")
      .map((f) => {
        const relPath =
          vaultRoot && f.filePath.startsWith(vaultRoot)
            ? f.filePath.slice(vaultRoot.length + 1)
            : f.title;
        const score = Math.max(
          scoreNameMatch(queryTrim, f.title),
          0.95 * scoreNameMatch(queryTrim, relPath)
        );
        return { f, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.f);
  }, [files, queryTrim, vaultRoot]);
  const fileMatches = useMemo(() => allFileMatches.slice(0, LOCAL_RESULT_LIMIT), [allFileMatches]);

  const pick = useCallback(
    (r: GeocodeSearchResult) => {
      onSelectResult(r);
    },
    [onSelectResult]
  );

  // ⌘1–⌘9 quick-select, numbering every visible row in display order. Built from
  // the same lists the groups render, so the chip on row N and the key ⌘N can't
  // disagree. Digit codes (not e.key) are layout-independent under modifiers.
  // Only the first few place results are shown in the popover; the rest are reachable
  // via "Open all as a list".
  const visibleResults = useMemo(() => results.slice(0, POPOVER_RESULT_LIMIT), [results]);

  const hotkeyTargets = useMemo<HotkeyTarget[]>(
    () =>
      [
        ...fileMatches.map((file) => ({ kind: "file", file }) as const),
        ...visibleResults.map((result) => ({ kind: "place", result }) as const)
      ].slice(0, MAX_HOTKEYS),
    [fileMatches, visibleResults]
  );

  useShortcuts(
    Array.from({ length: MAX_HOTKEYS }, (_, i) => ({
      def: {
        code: `Digit${i + 1}`,
        meta: true,
        // Gating on `active` keeps an idle embedded panel (place card) from
        // stealing keys while the popover's panel is the one in use.
        enabled: active && i < hotkeyTargets.length
      },
      handler: () => {
        const target = hotkeyTargets[i];
        if (!target) return;
        if (target.kind === "place") pick(target.result);
        else onSelectFile?.(target.file);
      }
    }))
  );

  const hasAnyResults = results.length > 0 || fileMatches.length > 0;
  // "Open all" spans place results + every matched vault file (not just the shown few).
  const openAllCount = results.length + allFileMatches.length;

  return (
    <Command
      shouldFilter={false}
      loop
      value={selected || `${NO_HIGHLIGHT}${selectionResets}`}
      onValueChange={(next) => {
        // Drop cmdk's unsolicited select-first (see userMovedSelection above).
        if (userMovedSelection.current) setSelected(next);
        else setSelectionResets((n) => n + 1);
      }}
      className={cn("flex flex-col", className)}
    >
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
            onValueChange={(next) => {
              setQuery(next);
              // A new query means a new result set: back to nothing highlighted.
              setSelected("");
              userMovedSelection.current = false;
            }}
            placeholder={placeholder}
            autoComplete="off"
            onKeyDown={(e) => {
              // Runs before cmdk's root handler (this bubbles up to it), so the flag is
              // set by the time cmdk pushes the resulting selection back through
              // onValueChange in this same dispatch.
              if (MOVE_SELECTION_KEYS.has(e.key)) userMovedSelection.current = true;
              // Nothing highlighted + any matches present → Enter opens all as a list
              // (the default action). cmdk always preventDefaults Enter, so intercept here
              // and stop it reaching cmdk's root handler.
              if (
                e.key === "Enter" &&
                !selected &&
                onOpenResults &&
                (results.length > 0 || allFileMatches.length > 0)
              ) {
                e.preventDefault();
                e.stopPropagation();
                onOpenResults(results, debouncedTrim, allFileMatches);
              }
            }}
            className="flex h-9 w-full min-w-0 bg-transparent text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
          />
          {inputEndSlot ? (
            <InputGroupAddon align="inline-end">{inputEndSlot}</InputGroupAddon>
          ) : null}
        </InputGroup>
      </div>
      <CommandList
        className="max-h-72"
        // cmdk highlights on hover too; that's the user moving through the list, so let
        // those writes through the gate as well. Capture phase — the row's own
        // pointer-move handler is what sets the value, and it would otherwise run (and
        // be rejected) before this one bubbled up.
        onPointerMoveCapture={() => {
          userMovedSelection.current = true;
        }}
      >
        {!queryTrim && !loading && !error ? (
          <div className="flex flex-col items-center gap-2 border-0 bg-transparent px-4 py-6 text-center md:px-6">
            <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-input/30">
              <SearchIcon className="size-5 opacity-70" aria-hidden />
            </div>
            <p className="text-base font-medium">Search</p>
            <p className="max-w-[16rem] text-xs text-muted-foreground">Find places and files.</p>
          </div>
        ) : null}
        {fileMatches.length > 0 ? (
          <CommandGroup heading="Files">
            {fileMatches.map((f, index) => {
              const dir = fileRelativeDir(f.filePath, vaultRoot);
              return (
                <CommandItem
                  key={`file-${f.filePath}`}
                  value={`file-${f.filePath}`}
                  onSelect={() => onSelectFile?.(f)}
                  className="rounded-md"
                >
                  <VaultFileIcon place={f} glyphClassName="text-muted-foreground" />
                  <div className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left">
                    <span className="max-w-full shrink-0 truncate font-medium leading-tight">
                      {f.title}
                    </span>
                    {dir ? (
                      <span className="min-w-0 truncate text-xs leading-tight text-muted-foreground">
                        {dir}
                      </span>
                    ) : null}
                  </div>
                  <HotkeyHint index={index} />
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}
        {visibleResults.length > 0 ? (
          <CommandGroup heading="Places">
            {visibleResults.map((r, index) => {
              const value = `${r.id}-${index}`;
              return (
                <CommandItem
                  key={value}
                  value={value}
                  onSelect={() => pick(r)}
                  className="rounded-md"
                >
                  <MapPinIcon className="size-4 shrink-0 text-muted-foreground" />
                  {/* Single line — secondary inline in grey — so items with and without
                      context (countries have none) keep a consistent height. The name
                      never shrinks; the context truncates into whatever space is left. */}
                  <div className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left">
                    <span className="max-w-full shrink-0 truncate font-medium leading-tight">
                      {r.primaryLabel}
                    </span>
                    {r.secondaryLabel ? (
                      <span className="min-w-0 truncate text-xs leading-tight text-muted-foreground">
                        {capitalize(r.secondaryLabel)}
                      </span>
                    ) : null}
                  </div>
                  <HotkeyHint index={fileMatches.length + index} />
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}
        {onOpenResults && openAllCount > 0 ? (
          <CommandGroup>
            <CommandItem
              value="__open_all_results__"
              onSelect={() => onOpenResults(results, debouncedTrim, allFileMatches)}
              className="rounded-md"
            >
              <TextSearchIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">
                Open {openAllCount} result{openAllCount === 1 ? "" : "s"} as a list
              </span>
            </CommandItem>
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
