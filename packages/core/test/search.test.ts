import { describe, expect, it } from "vitest";
import { searchQueryFor } from "../src/search";

describe("searchQueryFor", () => {
  it.each([
    ["help me refill my prescription", "refill my prescription"],
    ["Can you help me find a cheaper air fryer please?", "find a cheaper air fryer"],
    ["I want to join my doctor's appointment on Zoom", "join my doctor's appointment on Zoom"],
    ["how do I check my email", "check my email"],
    ["take me to amazon", "amazon"],
    ["What's the weather today?", "What's the weather today"],
    ["  weather  ", "weather"],
  ])("%s -> %s", (req, q) => expect(searchQueryFor(req)).toBe(q));

  it("keeps the request when only filler is left, and caps the length", () => {
    expect(searchQueryFor("help me")).toBe("help me");
    expect(searchQueryFor("x".repeat(300))).toHaveLength(100);
  });
});
