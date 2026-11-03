import { describe, expect, it } from "vitest";
import { shouldInjectContentScript } from "../src/lib/inject";

describe("shouldInjectContentScript", () => {
  it("skips injection when the top frame is already running JustAsk", () => {
    expect(shouldInjectContentScript(true)).toBe(false);
    expect(shouldInjectContentScript(false)).toBe(true);
  });
});
