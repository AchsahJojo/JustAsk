import { describe, expect, it } from "vitest";
import { detectPlatform, deviceInfo, newMachineId } from "../src/device";

describe("device info", () => {
  it("detects the platform from the user agent", () => {
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/141.0")).toBe("windows");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe("macos");
    expect(detectPlatform("")).toBe("windows");
  });

  it("builds the desktop device for Windows", () => {
    expect(deviceInfo("windows", "m-1")).toEqual({ kind: "desktop", platform: "windows", label: "JustAsk on Windows", machineId: "m-1" });
  });

  it("builds the desktop device for macOS", () => {
    expect(deviceInfo("macos", "m-2")).toEqual({ kind: "desktop", platform: "macos", label: "JustAsk on Mac", machineId: "m-2" });
  });

  it("makes distinct random machine ids", () => {
    const a = newMachineId();
    const b = newMachineId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});
