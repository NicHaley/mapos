import { describe, expect, it } from "vitest";
import {
  emojiIcon,
  emojiPinImageId,
  normalizeFeatureColor,
  parseEmojiPinImageId
} from "./map-styles";

// Only the pure helpers are covered: `drawEmojiPin` and the paint/layout builders need a DOM
// canvas, and the vitest environment here is "node".

describe("emoji pin image id codec", () => {
  // The glyph is the unsplit remainder, so multi-codepoint sequences must survive byte-for-byte.
  const emoji = ["🍜", "👨‍👩‍👧", "🇯🇵", "👍🏽", "1️⃣", "☺️"];
  const colors = ["#ef4444", "rgb(1, 2, 3)", "rgba(0,0,0,0.5)", "hsl(210 40% 50%)"];

  for (const e of emoji) {
    for (const color of colors) {
      it(`round-trips ${e} on ${color}`, () => {
        expect(parseEmojiPinImageId(emojiPinImageId(e, color))).toEqual({ emoji: e, color });
      });
    }
  }

  it("rejects the other runtime-rasterized image ids", () => {
    expect(parseEmojiPinImageId("overlay-chip")).toBeNull();
    expect(parseEmojiPinImageId("route-arrow")).toBeNull();
    expect(parseEmojiPinImageId("route-destination")).toBeNull();
  });

  it("rejects malformed ids rather than rasterizing a blank", () => {
    // No separator, empty glyph, and empty colour respectively.
    expect(parseEmojiPinImageId("emoji-pin:#ef4444")).toBeNull();
    expect(parseEmojiPinImageId("emoji-pin:#ef4444|")).toBeNull();
    expect(parseEmojiPinImageId("emoji-pin:|🍜")).toBeNull();
    expect(parseEmojiPinImageId("")).toBeNull();
  });
});

describe("emojiIcon", () => {
  it("accepts a single emoji, including multi-codepoint clusters", () => {
    expect(emojiIcon("🍜")).toBe("🍜");
    expect(emojiIcon("👨‍👩‍👧")).toBe("👨‍👩‍👧");
    expect(emojiIcon("🇯🇵")).toBe("🇯🇵");
    expect(emojiIcon("👍🏽")).toBe("👍🏽");
    expect(emojiIcon("1️⃣")).toBe("1️⃣");
  });

  it("trims surrounding whitespace", () => {
    expect(emojiIcon("  🍜 ")).toBe("🍜");
  });

  // Anything rejected here keeps its point on the circle layer. A value that slipped through and
  // rasterized to nothing would leave an invisible point instead.
  it("rejects non-emoji, multiple emoji, and non-strings", () => {
    expect(emojiIcon("home")).toBeUndefined();
    expect(emojiIcon("map-pin")).toBeUndefined();
    expect(emojiIcon("🍜🍕")).toBeUndefined();
    expect(emojiIcon("🍜 ramen")).toBeUndefined();
    expect(emojiIcon("a")).toBeUndefined();
    expect(emojiIcon("1")).toBeUndefined();
    expect(emojiIcon("")).toBeUndefined();
    expect(emojiIcon("   ")).toBeUndefined();
    expect(emojiIcon(undefined)).toBeUndefined();
    expect(emojiIcon(null)).toBeUndefined();
    expect(emojiIcon(42)).toBeUndefined();
  });
});

describe("normalizeFeatureColor", () => {
  it("collapses equivalent hex spellings to one image id", () => {
    expect(normalizeFeatureColor("#FFF")).toBe("#ffffff");
    expect(normalizeFeatureColor("#ffffff")).toBe("#ffffff");
    expect(normalizeFeatureColor("#EF4444")).toBe("#ef4444");
    expect(normalizeFeatureColor("  #ef4444 ")).toBe("#ef4444");
  });

  it("passes other colour syntaxes through untouched", () => {
    expect(normalizeFeatureColor("rgb(1, 2, 3)")).toBe("rgb(1, 2, 3)");
    expect(normalizeFeatureColor("rebeccapurple")).toBe("rebeccapurple");
  });

  it("maps blank and missing to undefined", () => {
    expect(normalizeFeatureColor(undefined)).toBeUndefined();
    expect(normalizeFeatureColor("")).toBeUndefined();
  });
});
