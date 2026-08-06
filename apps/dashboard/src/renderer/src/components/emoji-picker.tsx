import { Button } from "@mapos/ui/components/button";
import { Input } from "@mapos/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger
} from "@mapos/ui/components/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mapos/ui/components/tooltip";
import { cn } from "@mapos/ui/lib/utils";
import { useVaultRoot } from "@renderer/hooks/use-vault-root";
import {
  EMOJI_CATEGORIES,
  type EmojiEntry,
  SKIN_TONES,
  randomEmoji,
  searchEmoji,
  toneOf
} from "@renderer/lib/emoji-data";
import { useLocalStorage } from "@renderer/lib/use-local-storage";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ShuffleIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

/**
 * The emoji picker: our own grid over `@emoji-mart/data`, in our own DOM.
 *
 * Written rather than pulled in because every off-the-shelf picker we tried put its grid in a shadow
 * root, which a popover can't clip or measure — the failure mode was a grid spilling down the whole
 * window. Owning the markup also means it themes with the rest of the app, and leaves room for an
 * "Icons" tab later (`icon` is a plain string, so a `lucide:map-pin` form extends the same key).
 *
 * Rendered as a virtual list of *rows*, not a grid of cells. 1870 emoji is well past what's worth
 * mounting, and a row-per-item list is what lets category headers be list items too — which keeps
 * them in document order and lets the jump bar scroll to one by index.
 */

const COLUMNS = 9;
const CELL = 34;
/** The panel is exactly its grid. Hard-coding a width instead left a remainder past the last
 *  column, and the header's trailing control sat in it looking like a tenth column. */
const GRID_WIDTH = COLUMNS * CELL;
const HEADER = 26;
const GRID_HEIGHT = 288;
const RECENTS_KEY = "mapos-emoji-recents";
const TONE_KEY = "mapos-emoji-tone";
const MAX_RECENTS = COLUMNS * 2;

/** One virtual row: a category label, or a run of up to `COLUMNS` emoji. */
type Row =
  | { kind: "header"; id: string; label: string }
  | { kind: "emoji"; id: string; entries: EmojiEntry[] };

function chunk(entries: EmojiEntry[], id: string): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < entries.length; i += COLUMNS) {
    rows.push({ kind: "emoji", id: `${id}-${i}`, entries: entries.slice(i, i + COLUMNS) });
  }
  return rows;
}

/** The first tone-capable emoji in the catalogue (a raised hand), used as the tone control's face
 *  — the same reference glyph Notion and Slack use. */
const TONE_REFERENCE = EMOJI_CATEGORIES.flatMap((c) => c.emojis).find((e) => e.tones.length > 0);

function readTone(): number {
  const saved = Number(localStorage.getItem(TONE_KEY));
  return Number.isInteger(saved) && saved >= 0 && saved < SKIN_TONES.length ? saved : 0;
}

/** Stable identity so the hook's initial value doesn't change between renders. */
const EMPTY_RECENTS: string[] = [];

/** A corrupt list isn't worth reporting — an empty Recents looks correct. Anything that isn't a
 *  list of glyphs is dropped rather than rendered. */
function parseRecents(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : [];
}

export function EmojiPicker({
  onSelect,
  className
}: {
  onSelect: (emoji: string) => void;
  className?: string;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [tone, setTone] = useState(readTone);
  const [tonesOpen, setTonesOpen] = useState(false);
  const vaultRoot = useVaultRoot();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scoped to the vault — an unscoped key would leak recents across vaults. The hook holds the
  // value in memory until the root resolves, then re-reads for the real key.
  const [recents, setRecents] = useLocalStorage<string[]>(
    vaultRoot ? `${RECENTS_KEY}:${vaultRoot}` : null,
    EMPTY_RECENTS,
    { deserialize: parseRecents }
  );

  const pick = useCallback(
    (emoji: string) => {
      onSelect(emoji);
      setRecents((prev) => [emoji, ...prev.filter((e) => e !== emoji)].slice(0, MAX_RECENTS));
    },
    [onSelect, setRecents]
  );

  /** Rows for the current view. Searching flattens to one unlabelled run: category headers over
   *  filtered results just push the matches off screen. */
  const rows = useMemo<Row[]>(() => {
    if (query.trim()) return chunk(searchEmoji(query), "search");
    const out: Row[] = [];
    if (recents.length > 0) {
      out.push({ kind: "header", id: "recent", label: "Recent" });
      // Recents are stored as glyphs rather than ids: a later tone change shouldn't rewrite
      // history, and the glyph is all the grid needs to render one.
      const asEntries = recents.map((native) => ({
        id: `recent-${native}`,
        name: native,
        native,
        tones: [],
        haystack: ""
      }));
      out.push(...chunk(asEntries, "recent"));
    }
    for (const category of EMOJI_CATEGORIES) {
      out.push({ kind: "header", id: category.id, label: category.label });
      out.push(...chunk(category.emojis, category.id));
    }
    return out;
  }, [query, recents]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i].kind === "header" ? HEADER : CELL),
    overscan: 6
  });

  /** Row index of each category header, for the jump bar. */
  const headerIndex = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, i) => {
      if (row.kind === "header") map.set(row.id, i);
    });
    return map;
  }, [rows]);

  const jumpTo = useCallback(
    (categoryId: string) => {
      const index = headerIndex.get(categoryId);
      if (index !== undefined) virtualizer.scrollToIndex(index, { align: "start" });
    },
    [headerIndex, virtualizer]
  );

  return (
    <div className={cn("flex flex-col gap-2", className)} style={{ width: GRID_WIDTH }}>
      <div className="flex items-center gap-1.5">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          className="flex-1"
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Random emoji"
                onClick={() => pick(toneOf(randomEmoji(), tone))}
              >
                <ShuffleIcon />
              </Button>
            }
          />
          <TooltipContent>Random</TooltipContent>
        </Tooltip>
        {TONE_REFERENCE && (
          <Popover open={tonesOpen} onOpenChange={setTonesOpen}>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label="Skin tone"
                  className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-lg leading-none transition-colors hover:bg-hover"
                >
                  {toneOf(TONE_REFERENCE, tone)}
                </button>
              }
            />
            <PopoverContent align="end" className="w-auto flex-row gap-0.5 p-1">
              <PopoverTitle className="sr-only">Skin tone</PopoverTitle>
              {SKIN_TONES.map(({ index, label }) => (
                <button
                  key={index}
                  type="button"
                  title={label}
                  aria-label={label}
                  aria-pressed={tone === index}
                  onClick={() => {
                    setTone(index);
                    localStorage.setItem(TONE_KEY, String(index));
                    setTonesOpen(false);
                  }}
                  className={cn(
                    "flex size-7 cursor-pointer items-center justify-center rounded text-lg leading-none transition-colors hover:bg-hover",
                    tone === index && "bg-hover"
                  )}
                >
                  {toneOf(TONE_REFERENCE, index)}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        )}
      </div>

      <div
        ref={scrollRef}
        className="overflow-y-auto overscroll-contain"
        style={{ height: GRID_HEIGHT }}
      >
        {rows.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground text-sm">No emoji found</p>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              return (
                <div
                  key={row.id}
                  className="absolute inset-x-0 top-0 flex items-center"
                  style={{ height: item.size, transform: `translateY(${item.start}px)` }}
                >
                  {row.kind === "header" ? (
                    <span className="px-1 font-medium text-muted-foreground text-xs">
                      {row.label}
                    </span>
                  ) : (
                    row.entries.map((entry) => {
                      const glyph = toneOf(entry, tone);
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          title={entry.name}
                          aria-label={entry.name}
                          onClick={() => pick(glyph)}
                          // Centred by the flex box rather than by line metrics, which is fine
                          // here — the glyph is alone in its own square. The *pin* still goes
                          // through the rasterizer, which ink-fits (see VaultFileIcon).
                          className="flex shrink-0 cursor-pointer items-center justify-center rounded text-xl leading-none transition-colors hover:bg-hover"
                          style={{ width: CELL, height: CELL }}
                        >
                          {glyph}
                        </button>
                      );
                    })
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t pt-1.5">
        {EMOJI_CATEGORIES.map((category) => (
          <Tooltip key={category.id}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={category.label}
                  onClick={() => jumpTo(category.id)}
                  className="flex size-7 cursor-pointer items-center justify-center rounded text-base leading-none opacity-60 transition-opacity hover:bg-hover hover:opacity-100"
                >
                  {category.emojis[0]?.native}
                </button>
              }
            />
            <TooltipContent>{category.label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
