import { describe, expect, it } from "vitest";
import { emojiIcon, normalizeFeatureColor } from "./place-appearance";

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
