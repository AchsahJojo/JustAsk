// @vitest-environment happy-dom
// The gap fixtures exercise the generic rules; nothing here is special-cased in src.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { scanDocument } from "../src/scanner";
import { fakeLayout } from "./setup-dom";

const page = (name: string) => {
  const html = readFileSync(resolve(process.cwd(), "apps/fixtures/public/gaps", `${name}.html`), "utf8");
  // These tests exercise scanner behavior, not fixture server asset loading. Parse just the
  // body so happy-dom does not try (and fail) to fetch `/site.css` from localhost:3000.
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, "");
};
const find = (label: string) => scanDocument(document).elements.find((e) => e.data.label === label || e.data.text === label)!.data;

beforeEach(() => fakeLayout());

describe("gap fixtures", () => {
  it("checkout card fields are all sensitive", () => {
    page("checkout");
    for (const l of ["Card number", "Expiry", "CVV"]) expect([l, find(l).field?.sensitive]).toEqual([l, true]);
    expect(find("Place order $42.10").field).toBeUndefined();
  });

  it("login password is sensitive, email is not", () => {
    page("login");
    expect(find("Password").field?.sensitive).toBe(true);
    expect(find("Email").field?.sensitive).toBeUndefined();
  });

  it("store search input is a search box", () => {
    page("store");
    // happy-dom does not compute translateX(-100%) from the fixture CSS; model the drawer's
    // off-canvas box so this fixture check exercises the real scanner rule.
    document.getElementById("drawer")?.setAttribute("data-rect", "-400,0,300,800");
    expect(find("Search products").role).toBe("search box");
  });
});
