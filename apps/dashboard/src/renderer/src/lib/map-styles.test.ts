import { describe, expect, it } from "vitest";
import { emojiPinImageId, parseEmojiPinImageId } from "./map-styles";

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
