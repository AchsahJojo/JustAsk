// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageText, scanDocument } from "../src/scanner";
import { isVisible, pickModal } from "../src/visibility";
import { fakeLayout } from "./setup-dom";

beforeEach(() => {
  fakeLayout();
  document.body.innerHTML = "";
});
afterEach(() => vi.restoreAllMocks());

const texts = () => scanDocument(document).elements.map((e) => e.data.text);

describe("visibility (P2)", () => {
  it("skips aria-hidden and inert subtrees, including through shadow roots", () => {
    document.body.innerHTML = `
      <main><button>Shown</button>
        <div aria-hidden="true"><button>Hidden menu</button></div>
        <div inert><a href="/x">Inert link</a></div>
        <button aria-hidden="false">Not hidden</button>
        <div aria-hidden="true" id="host"></div>
      </main>`;
    document.getElementById("host")!.attachShadow({ mode: "open" }).innerHTML = `<button>Shadow hidden</button>`;
    expect(texts()).toEqual(["Shown", "Not hidden"]);
  });

  it("drops elements clipped away by an overflow:hidden ancestor, keeps scrollable ones", () => {
    document.body.innerHTML = `
      <nav style="overflow:hidden" data-rect="0,0,800,0.5"><a href="/m" data-rect="0,10,100,20">Mega menu item</a></nav>
      <div style="overflow-x:clip" data-rect="0,100,300,50"><a href="/r" data-rect="400,110,100,20">Clipped right</a></div>
      <div style="overflow-y:auto" data-rect="0,200,300,100"><button data-rect="0,900,100,20">Scroll to me</button></div>
      <main><button>Visible</button></main>`;
    expect(texts()).toEqual(["Scroll to me", "Visible"]);
  });

  it("drops off-canvas elements left of 0 and right of the document", () => {
    document.body.innerHTML = `
      <button data-rect="-300,10,200,40">Left drawer</button>
      <button data-rect="5000,10,200,40">Right drawer</button>
      <button>On screen</button>`;
    expect(texts()).toEqual(["On screen"]);
  });

  it("uses checkVisibility when the engine has it", () => {
    document.body.innerHTML = `<button id="a">Faded</button><button>Plain</button>`;
    const orig = Element.prototype.checkVisibility;
    const spy = vi.fn(function (this: Element, o?: CheckVisibilityOptions) {
      expect(o).toMatchObject({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true });
      return this.id !== "a";
    });
    Element.prototype.checkVisibility = spy;
    try {
      expect(texts()).toEqual(["Plain"]);
      expect(spy).toHaveBeenCalled();
    } finally {
      Element.prototype.checkVisibility = orig;
    }
  });

  it("an ancestor with opacity 0 hides its children (checkVisibility)", () => {
    document.body.innerHTML = `<div style="opacity:0"><button>Ghost</button></div><button>Real</button>`;
    expect(texts()).toEqual(["Real"]);
  });
});

describe("modal rule (P2)", () => {
  const DRAWER = `
    <header><form role="search"><input name="q" placeholder="Search products"><button>Search</button></form></header>
    <main><h1>Shop everything</h1><p>Find what you need.</p><a href="/b">Steel water bottle</a></main>
    <div role="dialog" aria-modal="true" aria-label="Menu" data-rect="-300,0,300,700" style="transform:translateX(-100%)">
      <p data-rect="-290,5,200,20">Drawer heading text</p>
      <a href="/room" data-rect="-290,40,200,20">Shop by room</a>
      <a href="/living" data-rect="-290,70,200,20">Living room</a>
    </div>`;

  it("an off-canvas aria-modal drawer no longer wipes the page", () => {
    document.body.innerHTML = DRAWER;
    expect(pickModal(document)).toBeNull();
    const els = scanDocument(document).elements.map((e) => e.data);
    expect(els.map((e) => e.text)).toEqual(["Search products", "Search", "Steel water bottle"]);
    expect(els.every((e) => !e.inModal && e.region !== "modal")).toBe(true);
    const text = pageText(document);
    expect(text).toContain("Shop everything");
    expect(text).not.toContain("Drawer heading text");
  });

  it("the same drawer, slid open, is the modal", () => {
    document.body.innerHTML = DRAWER.replace(/-300,0/, "0,0").replace(/-290,/g, "10,");
    expect(pickModal(document)).not.toBeNull();
    const els = scanDocument(document).elements.map((e) => e.data);
    expect(els.map((e) => e.text)).toEqual(["Shop by room", "Living room"]);
    expect(els.every((e) => e.inModal)).toBe(true);
    expect(pageText(document)).toBe("Drawer heading text");
  });

  it("a modal that loses the hit test at its center is ignored; one that wins is used", () => {
    document.body.innerHTML = `<button id="behind">Behind</button><div id="m" role="dialog" aria-modal="true"><button>Accept</button></div>`;
    const m = document.getElementById("m")!;
    const behind = document.getElementById("behind")!;
    const spy = vi.spyOn(document, "elementFromPoint").mockReturnValue(behind);
    expect(pickModal(document)).toBeNull();
    expect(texts()).toEqual(["Behind", "Accept"]);
    spy.mockReturnValue(m.querySelector("button"));
    expect(pickModal(document)).toBe(m);
    expect(texts()).toEqual(["Accept"]);
  });

  it("a modal outside the viewport is ignored", () => {
    document.body.innerHTML = `<button>Page</button><div role="dialog" aria-modal="true" data-rect="10,5000,300,300"><button data-rect="20,5010,100,20">Far</button></div>`;
    expect(pickModal(document)).toBeNull();
    expect(texts()).toEqual(["Page", "Far"]);
  });

  it("isVisible keeps a small checkbox through its visible label", () => {
    document.body.innerHTML = `<label for="c">Agree</label><input id="c" type="checkbox" data-rect="0,0,1,1">`;
    expect(isVisible(document.getElementById("c")!)).toBe(true);
  });
});
