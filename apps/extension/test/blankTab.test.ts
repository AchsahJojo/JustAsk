import { describe, expect, it } from "vitest";
import { isBlankTab, isInjectable } from "../src/platform";

describe("isBlankTab", () => {
  it.each(["chrome://newtab/", "chrome://new-tab-page/", "chrome-search://local-ntp/local-ntp.html", "about:blank", "about:newtab", "edge://newtab/", "", undefined])("%s is empty", (u) =>
    expect(isBlankTab(u)).toBe(true),
  );
  it.each(["https://example.com/", "chrome://settings/", "chrome://version", "https://www.google.com/"])("%s is not", (u) => expect(isBlankTab(u)).toBe(false));
  it("empty tabs are never injectable, so they need the search instead", () => {
    expect(isInjectable("chrome://newtab/")).toBe(false);
  });
});
