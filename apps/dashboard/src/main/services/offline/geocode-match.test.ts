import { describe, expect, it } from "vitest";

import { buildMatch, exactPhrase } from "./geocode-match";

describe("buildMatch", () => {
  it("makes the trailing token a prefix term once it is long enough", () => {
    expect(buildMatch("ab")).toBe('"ab"*');
    expect(buildMatch("broadway")).toBe('"broadway"*');
  });

  it("leading tokens are always exact terms", () => {
    expect(buildMatch("broad av")).toBe('"broad" "av"*');
    expect(buildMatch("new york city")).toBe('"new" "york" "city"*');
  });

  // The packs are built with prefix='2 3'. A 1-char prefix term has no index behind
  // it, so FTS5 unions every doclist in the term index — ~1s of blocking work on a
  // metro-sized pack, versus ~35ms for the bare term.
  it("does not prefix a single-character trailing token", () => {
    expect(buildMatch("a")).toBe('"a"');
    expect(buildMatch("broad a")).toBe('"broad" "a"');
  });

  it("strips punctuation and lowercases", () => {
    expect(buildMatch("St. Andrews")).toBe('"st" "andrews"*');
  });

  it("keeps non-ASCII letters as ordinary tokens", () => {
    expect(buildMatch("café")).toBe('"café"*');
  });

  it("is null when there is nothing to search", () => {
    expect(buildMatch("")).toBeNull();
    expect(buildMatch("   ")).toBeNull();
    expect(buildMatch("!?-")).toBeNull();
  });

  it("quotes tokens so FTS5 operators cannot leak in", () => {
    expect(buildMatch('foo OR bar" AND')).toBe('"foo" "or" "bar" "and"*');
  });
});

describe("exactPhrase", () => {
  it("normalises to the same tokens buildMatch uses, space-joined", () => {
    expect(exactPhrase("St. Andrews")).toBe("st andrews");
    expect(exactPhrase("BERLIN")).toBe("berlin");
    expect(exactPhrase("  ")).toBe("");
  });
});
