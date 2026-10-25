import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PCM_WORKLET_SOURCE } from "@justask/voice";

describe("ja-pcm-worklet.js", () => {
  it("is the same worklet as packages/voice (extension pages can't load it from a blob)", () => {
    // Ignore line endings: a Windows checkout may have CRLF.
    const file = readFileSync(new URL("../public/ja-pcm-worklet.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(file).toContain(PCM_WORKLET_SOURCE);
  });
});
