// happy-dom has no layout. Give every element a visible box unless it is display:none,
// with optional overrides via data-rect="x,y,w,h".
export function fakeLayout() {
  const fn = function (this: Element) {
    const spec = this.getAttribute?.("data-rect");
    let x = 10, y = 10, w = 120, h = 40;
    if (spec) [x, y, w, h] = spec.split(",").map(Number);
    let cur: Element | null = this;
    while (cur) {
      if (getComputedStyle(cur).display === "none" || cur.hasAttribute("hidden")) { w = 0; h = 0; break; }
      cur = cur.parentElement ?? ((cur.getRootNode() as any).host ?? null);
    }
    return { x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h } as DOMRect;
  };
  for (const C of ["Element", "HTMLElement", "SVGElement"]) {
    const proto = (globalThis as any)[C]?.prototype;
    if (proto) Object.defineProperty(proto, "getBoundingClientRect", { value: fn, configurable: true, writable: true });
  }
}
