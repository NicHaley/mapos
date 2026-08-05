/**
 * FTS5 MATCH expression construction for the offline geocode packs. Split out from
 * the query layer so it carries no `better-sqlite3` import and stays unit-testable
 * in plain Node (see geocode-match.test.ts).
 */

/**
 * Shortest trailing token that may carry a prefix `*`. The packs are built with
 * `prefix='2 3'`, so FTS5 has a prefix index for 2- and 3-character prefixes only.
 * A 1-character prefix term has no index behind it: FTS5 scans the whole term
 * index and unions every matching doclist, which on a metro-sized pack (~5.7M
 * features) costs ~1s. Searching the bare token instead costs ~35ms.
 */
export const MIN_PREFIX_LEN = 2;

/**
 * Turn free text into a safe FTS5 MATCH expression: each word becomes a quoted
 * token (quoting neutralises FTS operator characters), and the last token gets a
 * prefix `*` so search-as-you-type works — but only once it's long enough to hit
 * the pack's prefix index (see {@link MIN_PREFIX_LEN}).
 */
export function buildMatch(query: string): string | null {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens
    .map((t, i) => (i === tokens.length - 1 && t.length >= MIN_PREFIX_LEN ? `"${t}"*` : `"${t}"`))
    .join(" ");
}

/**
 * Normalised whole query for the exact-name boost: the same tokenisation as
 * {@link buildMatch}, joined by spaces, so `lower(f.name) = @exact` compares
 * like against like.
 */
export function exactPhrase(query: string): string {
  return (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
}
