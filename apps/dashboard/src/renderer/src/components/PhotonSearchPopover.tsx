import { Loader2Icon, MapPinIcon, SearchIcon } from "lucide-react";
import {
  type CSSProperties,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";

import { useDebounce } from "@renderer/hooks/useDebounce";
import { modSymbol, useShortcuts } from "@renderer/hooks/useShortcuts";
import { type PhotonSearchResult, searchPhoton } from "@renderer/lib/photon";
import { Button } from "./ui/button";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandPrimitive,
  CommandSeparator
} from "./ui/command";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { InputGroup, InputGroupAddon } from "./ui/input-group";
import { Kbd, KbdGroup } from "./ui/kbd";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

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

export function PhotonSearchPopover({
  onSelectResult,
  className
}: {
  onSelectResult: (result: PhotonSearchResult) => void;
  className?: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query, DEBOUNCE_MS);
  const [results, setResults] = useState<PhotonSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const debouncedTrim = trimQuery(debouncedQuery);
  const queryTrim = trimQuery(query);
  const isDebouncing = open && queryTrim !== "" && queryTrim !== debouncedTrim;

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery("");
      setResults([]);
      setError(null);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
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
  }, [debouncedTrim, open]);

  const pick = useCallback(
    (r: PhotonSearchResult) => {
      onSelectResult(r);
      handleOpenChange(false);
    },
    [onSelectResult, handleOpenChange]
  );

  useShortcuts([{ def: { key: "k", meta: true }, handler: () => setOpen(true) }]);

  return (
    <TooltipProvider>
      <Tooltip>
        <Popover open={open} onOpenChange={handleOpenChange} modal={false}>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Search places"
                    className={className}
                    style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
                  >
                    <SearchIcon className="size-4" />
                  </Button>
                }
              />
            }
          />
          <TooltipContent side="bottom">
            Search places
            <KbdGroup>
              <Kbd>{modSymbol}</Kbd>
              <Kbd>K</Kbd>
            </KbdGroup>
          </TooltipContent>
          <PopoverContent className="w-96 p-0" align="start" side="bottom" sideOffset={6}>
            <PopoverTitle className="sr-only">Search places</PopoverTitle>
            <Command
              shouldFilter={false}
              className="overflow-visible rounded-lg bg-transparent p-0"
            >
              <div className="p-2 pb-0" data-slot="command-input-wrapper">
                <InputGroup className="h-8! rounded-lg! border-input/30 bg-input/30 shadow-none! *:data-[slot=input-group-addon]:pl-2!">
                  <InputGroupAddon align="inline-start">
                    {loading || isDebouncing ? (
                      <Loader2Icon className="size-4 shrink-0 animate-spin opacity-50" />
                    ) : (
                      <SearchIcon className="size-4 shrink-0 opacity-50" />
                    )}
                  </InputGroupAddon>
                  <CommandPrimitive.Input
                    ref={inputRef}
                    data-slot="command-input"
                    value={query}
                    onValueChange={setQuery}
                    placeholder="Search map…"
                    autoComplete="off"
                    className="w-full border-0 bg-transparent py-1.5 pr-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-0 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </InputGroup>
              </div>
              <CommandList className="max-h-60 p-2">
                {!queryTrim && !loading && !error ? (
                  <Empty className="border-0 bg-transparent p-4 py-6 md:p-6">
                    <EmptyHeader>
                      <EmptyMedia className="bg-input/30 border border-border" variant="icon">
                        <SearchIcon aria-hidden />
                      </EmptyMedia>
                      <EmptyTitle className="text-base">Search the map</EmptyTitle>
                      <EmptyDescription className="max-w-[16rem] text-xs">
                        Type a place name or address. Results come from OpenStreetMap via Photon.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : null}
                {results.length > 0 ? (
                  <CommandGroup heading="Places" className="p-0">
                    {results.map((r) => (
                      <CommandItem
                        key={r.id}
                        value={r.id}
                        onSelect={() => {
                          pick(r);
                        }}
                      >
                        <MapPinIcon className="text-muted-foreground size-4 shrink-0" />
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                          <span className="truncate font-medium leading-tight">
                            {r.primaryLabel}
                          </span>
                          {r.secondaryLabel ? (
                            <span className="text-muted-foreground truncate text-xs leading-tight">
                              {r.secondaryLabel}
                            </span>
                          ) : null}
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}
                {error ? (
                  <>
                    {results.length > 0 ? <CommandSeparator /> : null}
                    <div className="px-2 py-3 text-center text-xs text-destructive">{error}</div>
                  </>
                ) : null}
                {!loading && !isDebouncing && !error && queryTrim && results.length === 0 ? (
                  <Empty className="border-0 bg-transparent p-4 py-6 md:p-6">
                    <EmptyHeader>
                      <EmptyMedia className="bg-input/30 border border-border" variant="icon">
                        <MapPinIcon aria-hidden />
                      </EmptyMedia>
                      <EmptyTitle className="text-base">No results</EmptyTitle>
                      <EmptyDescription className="max-w-[16rem] text-xs">
                        Try a different spelling or a nearby city or region.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : null}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </Tooltip>
    </TooltipProvider>
  );
}
