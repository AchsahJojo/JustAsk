import { describe, expect, it } from "vitest";
import { friendlyError, mergePrefs, parseCode, parseDevices, seenAgo, spacedCode, type SyncedPrefs } from "../src/lib/prefs";

const LOCAL: SyncedPrefs = { voice: "browser", rate: 0.9, consent: { notifyOnComplete: false, notifyOnStuck: false } };

describe("mergePrefs", () => {
  it("takes valid remote fields that differ", () => {
    expect(mergePrefs(LOCAL, { voice: "cartesia", rate: 1.1, consent: { notifyOnComplete: true, notifyOnStuck: false } })).toEqual({
      voice: "cartesia",
      rate: 1.1,
      consent: { notifyOnComplete: true, notifyOnStuck: false },
    });
  });

  it("ignores a remote showMeInstead (guide-only: JustAsk never acts for her)", () => {
    expect(mergePrefs(LOCAL, { showMeInstead: true })).toEqual({});
    expect(mergePrefs(LOCAL, { showMeInstead: false, voice: "cartesia" })).toEqual({ voice: "cartesia" });
  });

  it("returns nothing when remote matches local", () => {
    expect(mergePrefs(LOCAL, { ...LOCAL })).toEqual({});
  });

  it("ignores null, arrays and junk", () => {
    expect(mergePrefs(LOCAL, null)).toEqual({});
    expect(mergePrefs(LOCAL, undefined)).toEqual({});
    expect(mergePrefs(LOCAL, [1, 2])).toEqual({});
    expect(mergePrefs(LOCAL, { voice: "robot", rate: "fast", consent: "all" })).toEqual({});
    expect(mergePrefs(LOCAL, { rate: Number.NaN })).toEqual({});
  });

  it("clamps the speech rate", () => {
    expect(mergePrefs(LOCAL, { rate: 9 })).toEqual({ rate: 1.5 });
    expect(mergePrefs(LOCAL, { rate: 0.1 })).toEqual({ rate: 0.5 });
  });

  it("merges partial consent over local", () => {
    const local = { ...LOCAL, consent: { notifyOnComplete: true, notifyOnStuck: false } };
    expect(mergePrefs(local, { consent: { notifyOnStuck: true } })).toEqual({ consent: { notifyOnComplete: true, notifyOnStuck: true } });
  });
});

describe("friendlyError", () => {
  it("passes the lockout through", () => {
    expect(friendlyError(new Error("Uncaught Error: Too many tries. Wait 10 minutes."))).toMatch(/^Too many tries/);
  });
  it("is kind about functions that don't exist yet", () => {
    expect(friendlyError(new Error("[Request ID: 1] Server Error\nCould not find public function for 'devices:list'"))).toMatch(/isn't ready yet/);
  });
  it("names network trouble and has a default", () => {
    expect(friendlyError(new TypeError("Failed to fetch"))).toMatch(/can't reach the internet/);
    expect(friendlyError("boom")).toMatch(/Something went wrong/);
    expect(friendlyError(undefined)).toMatch(/Something went wrong/);
  });
});

describe("parseDevices", () => {
  it("normalises id variants and flags", () => {
    expect(
      parseDevices([
        { _id: "d1", label: "Chrome on Windows", kind: "extension", lastSeenAt: 5, current: true },
        { id: "d2", kind: "extension" },
        { deviceId: "d3", label: "Edge on Mac", isCurrent: false },
        { label: "no id" },
        "junk",
      ]),
    ).toEqual([
      { id: "d1", label: "Chrome on Windows", kind: "extension", lastSeenAt: 5, current: true },
      { id: "d2", label: "A browser", kind: "extension", lastSeenAt: null, current: false },
      { id: "d3", label: "Edge on Mac", kind: "extension", lastSeenAt: null, current: false },
    ]);
  });
  it("accepts {devices: [...]} and junk", () => {
    expect(parseDevices({ devices: [{ _id: "a" }] })).toHaveLength(1);
    expect(parseDevices(null)).toEqual([]);
  });
});

describe("codes", () => {
  it("parses 6-digit codes from replies", () => {
    expect(parseCode({ code: "123456", expiresAt: 1 })).toBe("123456");
    expect(parseCode({ code: 654321 })).toBe("654321");
    expect(parseCode("111222")).toBe("111222");
    expect(parseCode({ code: "12" })).toBeNull();
    expect(parseCode(null)).toBeNull();
  });
  it("spaces codes for reading aloud", () => {
    expect(spacedCode("123456")).toBe("123 456");
    expect(spacedCode("12")).toBe("12");
  });
});

describe("seenAgo", () => {
  const now = Date.UTC(2026, 9, 24, 12);
  it("says today, yesterday or N days", () => {
    expect(seenAgo(now - 1000, now)).toBe("Used today");
    expect(seenAgo(now - 86_400_000 * 1.5, now)).toBe("Used yesterday");
    expect(seenAgo(now - 86_400_000 * 5, now)).toBe("Used 5 days ago");
  });
});
