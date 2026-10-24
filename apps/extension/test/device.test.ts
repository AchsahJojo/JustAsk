import { describe, expect, it } from "vitest";
import { detectBrowser, detectOs, deviceLabel } from "../src/platform/device";

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const EDGE_UA = `${CHROME_UA} Edg/141.0.0.0`;
const OPERA_UA = `${CHROME_UA} OPR/125.0.0.0`;
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

describe("detectBrowser", () => {
  it("uses userAgentData brands first", () => {
    expect(detectBrowser({ brands: ["Not)A;Brand", "Chromium", "Google Chrome"], ua: CHROME_UA })).toBe("chrome");
    expect(detectBrowser({ brands: ["Not)A;Brand", "Chromium", "Microsoft Edge"], ua: CHROME_UA })).toBe("edge");
    expect(detectBrowser({ brands: ["Chromium", "Opera", "Not)A;Brand"], ua: CHROME_UA })).toBe("opera");
    expect(detectBrowser({ brands: ["Brave", "Chromium", "Not)A;Brand"], ua: CHROME_UA })).toBe("brave");
  });

  it("detects Brave from navigator.brave even when brands look like Chrome", () => {
    expect(detectBrowser({ brands: ["Chromium", "Google Chrome"], ua: CHROME_UA, isBrave: true })).toBe("brave");
  });

  it("falls back to the UA string without brands", () => {
    expect(detectBrowser({ ua: EDGE_UA })).toBe("edge");
    expect(detectBrowser({ ua: OPERA_UA })).toBe("opera");
    expect(detectBrowser({ ua: CHROME_UA })).toBe("chrome");
    expect(detectBrowser({ ua: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0" })).toBe("other");
    expect(detectBrowser({})).toBe("other");
  });

  it("treats a Chromium-only brand list as chrome", () => {
    expect(detectBrowser({ brands: ["Chromium", "Not)A;Brand"], ua: CHROME_UA })).toBe("chrome");
  });
});

describe("detectOs", () => {
  it("reads userAgentData.platform", () => {
    expect(detectOs({ platform: "Windows" })).toBe("Windows");
    expect(detectOs({ platform: "macOS" })).toBe("Mac");
    expect(detectOs({ platform: "Chrome OS" })).toBe("ChromeOS");
    expect(detectOs({ platform: "Linux" })).toBe("Linux");
  });

  it("falls back to the UA string", () => {
    expect(detectOs({ ua: CHROME_UA })).toBe("Windows");
    expect(detectOs({ ua: MAC_UA })).toBe("Mac");
    expect(detectOs({ ua: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)" })).toBe("ChromeOS");
    expect(detectOs({})).toBe("computer");
  });
});

describe("deviceLabel", () => {
  it("names browser and OS plainly", () => {
    expect(deviceLabel("chrome", "Windows")).toBe("Chrome on Windows");
    expect(deviceLabel("edge", "Mac")).toBe("Edge on Mac");
    expect(deviceLabel("other", "Linux")).toBe("Browser on Linux");
    expect(deviceLabel("brave", "computer")).toBe("Brave on this computer");
  });
});
