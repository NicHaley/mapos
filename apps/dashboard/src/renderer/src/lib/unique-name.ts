/**
 * Shared unique-name generation for property keys, filenames, and similar.
 */

export type UniqueNameSuffixStyle = "spaceNumbered" | "hyphenNumbered";

/**
 * Yields candidate names in order: always `base` first, then numbered suffixes.
 *
 * - `spaceNumbered`: `base`, `base 1`, `base 2`, …
 * - `hyphenNumbered`: `base`, `base-2`, `base-3`, … (no `base-1`; matches legacy file rename behavior)
 */
export function* uniqueNameCandidates(
  base: string,
  suffixStyle: UniqueNameSuffixStyle
): Generator<string> {
  yield base;
  if (suffixStyle === "spaceNumbered") {
    for (let i = 1; ; i++) yield `${base} ${i}`;
  } else {
    for (let i = 2; ; i++) yield `${base}-${i}`;
  }
}

export function firstUniqueName(
  base: string,
  isTaken: (name: string) => boolean,
  options: {
    suffixStyle: UniqueNameSuffixStyle;
    maxCandidates?: number;
    fallback: (base: string) => string;
  }
): string {
  const max = options.maxCandidates ?? 1000;
  let n = 0;
  for (const candidate of uniqueNameCandidates(base, options.suffixStyle)) {
    if (++n > max) break;
    if (!isTaken(candidate)) return candidate;
  }
  return options.fallback(base);
}
