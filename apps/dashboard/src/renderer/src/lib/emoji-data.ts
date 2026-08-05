import data from "@emoji-mart/data";

/**
 * The emoji catalogue, reshaped once at import into what the picker actually renders.
 *
 * `@emoji-mart/data` is kept as a *data-only* dependency — the UI is ours. Its own `Picker` is a
 * custom element with a shadow root, which cost two rounds of layout bugs (a grid that collapsed to
 * five columns, and one that overflowed a popover with no way to clip it) before we gave up on it.
 * The JSON is the good part: 1870 emoji with names, keywords, and skin-tone variants.
 *
 * Imported, never fetched: the renderer's CSP (src/main/csp.ts) allows no CDN in `connect-src`, and
 * this has to work offline anyway.
 */

/** Raw shape of the slice of `@emoji-mart/data` we use. Its own types are loose. */
type RawData = {
  categories: Array<{ id: string; emojis: string[] }>;
  emojis: Record<
    string,
    {
      id: string;
      name: string;
      keywords: string[];
      skins: Array<{ native: string }>;
    }
  >;
};

export type EmojiEntry = {
  id: string;
  name: string;
  /** The default (yellow) glyph. */
  native: string;
  /** Tone variants, light to dark. Empty for the 1565 emoji that have no tones. */
  tones: string[];
  /** Lowercased name + keywords, joined once so search is a substring test per entry. */
  haystack: string;
};

export type EmojiCategory = {
  id: string;
  label: string;
  emojis: EmojiEntry[];
};

/** Display names for the dataset's category ids, in the order the picker shows them. */
const CATEGORY_LABELS: Record<string, string> = {
  people: "Smileys & people",
  nature: "Animals & nature",
  foods: "Food & drink",
  activity: "Activity",
  places: "Travel & places",
  objects: "Objects",
  symbols: "Symbols",
  flags: "Flags"
};

const raw = data as unknown as RawData;

function entryFor(id: string): EmojiEntry | null {
  const e = raw.emojis[id];
  if (!e?.skins?.length) return null;
  return {
    id: e.id,
    name: e.name,
    native: e.skins[0].native,
    // Index 0 is the toneless default, so the variants are everything after it.
    tones: e.skins.slice(1).map((s) => s.native),
    haystack: `${e.name} ${e.keywords.join(" ")}`.toLowerCase()
  };
}

export const EMOJI_CATEGORIES: EmojiCategory[] = raw.categories
  .filter((c) => CATEGORY_LABELS[c.id])
  .map((c) => ({
    id: c.id,
    label: CATEGORY_LABELS[c.id],
    emojis: c.emojis.map(entryFor).filter((e): e is EmojiEntry => e !== null)
  }))
  .filter((c) => c.emojis.length > 0);

/** Flat list for search, built once. */
const ALL_EMOJI: EmojiEntry[] = EMOJI_CATEGORIES.flatMap((c) => c.emojis);

/**
 * Substring match over name + keywords. Ranked so a prefix match on the *name* wins: typing "car"
 * should surface 🚗 before every emoji that merely lists "card" as a keyword.
 */
export function searchEmoji(query: string, limit = 120): EmojiEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const exact: EmojiEntry[] = [];
  const prefix: EmojiEntry[] = [];
  const rest: EmojiEntry[] = [];
  for (const e of ALL_EMOJI) {
    if (e.name.toLowerCase() === q) exact.push(e);
    else if (e.name.toLowerCase().startsWith(q)) prefix.push(e);
    else if (e.haystack.includes(q)) rest.push(e);
    if (exact.length + prefix.length + rest.length >= limit * 3) break;
  }
  return [...exact, ...prefix, ...rest].slice(0, limit);
}

/** A random emoji, for the shuffle button. */
export function randomEmoji(): EmojiEntry {
  return ALL_EMOJI[Math.floor(Math.random() * ALL_EMOJI.length)];
}

/** The five Fitzpatrick tones the dataset carries, plus the default, as picker labels. */
export const SKIN_TONES = [
  { index: 0, label: "Default" },
  { index: 1, label: "Light" },
  { index: 2, label: "Medium light" },
  { index: 3, label: "Medium" },
  { index: 4, label: "Medium dark" },
  { index: 5, label: "Dark" }
] as const;

/** The glyph for an entry at the chosen tone, falling back when it has no variants. */
export function toneOf(entry: EmojiEntry, tone: number): string {
  if (tone <= 0 || entry.tones.length === 0) return entry.native;
  return entry.tones[tone - 1] ?? entry.native;
}
