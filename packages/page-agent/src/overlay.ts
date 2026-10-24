// The highlight overlay: a closed Shadow DOM host, promoted to the top layer when the
// browser supports popovers, so it draws above <dialog>.showModal() and popovers (plan §3.7).
// Styles go through adoptedStyleSheets, never <style> tags, so strict-CSP sites can't block them.

const ACCENT = "#E8654A";

const CSS_TEXT = `
:host { all: initial; }
.ring {
  position: fixed;
  box-sizing: border-box;
  border: 4px solid ${ACCENT};
  border-radius: 14px;
  pointer-events: none;
  transition: left .25s ease-out, top .25s ease-out, width .25s ease-out, height .25s ease-out;
  animation: ja-in .35s ease-out, ja-pulse 1.6s ease-out .35s infinite;
}
.ring.again { animation: ja-again .5s ease-out 2, ja-pulse 1.6s ease-out 1s infinite; }
.tag {
  position: absolute;
  left: -4px;
  bottom: 100%;
  margin-bottom: 6px;
  background: ${ACCENT};
  color: #fff;
  font: 700 17px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  padding: 6px 14px;
  border-radius: 999px;
  white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0,0,0,.25);
}
.ring.below .tag { bottom: auto; top: 100%; margin-bottom: 0; margin-top: 6px; }
/* Beside the target when there's room, so the tag never covers the label she needs to read. */
.ring.side .tag { left: 100%; bottom: auto; top: 50%; transform: translateY(-50%); margin: 0 0 0 10px; }
.ring.side .tag::before { content: ""; position: absolute; left: -6px; top: 50%; margin-top: -6px; border: 6px solid transparent; border-left: 0; border-right-color: ${ACCENT}; }
.banner {
  position: fixed;
  right: 20px;
  bottom: 20px;
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 14px;
  background: #1C1D19;
  color: #FFFBF4;
  font: 600 18px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  padding: 14px 16px 14px 20px;
  border-radius: 18px;
  box-shadow: 0 12px 40px rgba(0,0,0,.35);
  max-width: min(440px, calc(100vw - 40px));
}
.banner button {
  font: inherit;
  font-size: 18px;
  border: 0;
  border-radius: 12px;
  padding: 12px 18px;
  cursor: pointer;
  background: ${ACCENT};
  color: #fff;
}
.banner button.later { background: transparent; color: #FFFBF4; padding: 12px 8px; }
@keyframes ja-pulse { 0% { box-shadow: 0 0 0 0 rgba(232,101,74,.6); } 70% { box-shadow: 0 0 0 18px rgba(232,101,74,0); } 100% { box-shadow: 0 0 0 0 rgba(232,101,74,0); } }
@keyframes ja-in { from { opacity: 0; transform: scale(1.12); } to { opacity: 1; transform: scale(1); } }
@keyframes ja-again { 0%,100% { transform: scale(1); } 50% { transform: scale(1.08); } }
@media (prefers-reduced-motion: reduce) {
  .ring, .ring.again { animation: none; transition: none; border-width: 6px; box-shadow: 0 0 0 4px rgba(232,101,74,.35); }
}
`;

export class Overlay {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private ring: HTMLDivElement | null = null;
  private tag: HTMLDivElement | null = null;
  private target: Element | null = null;
  private raf = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private topLayerWatch: MutationObserver | null = null;
  // Only a page popover opening should re-promote us; our own hide/show also fires `toggle`.
  private onToggle = (e: Event) => {
    if (e.target === this.host) return;
    if ((e as Event & { newState?: string }).newState !== "open") return;
    if (!(e.target instanceof Element) || !e.target.hasAttribute("popover")) return;
    this.promote();
  };

  constructor(private doc: Document = document) {}

  private ensureHost() {
    if (this.host?.isConnected) return;
    const host = this.doc.createElement("justask-overlay");
    const st = host.style;
    for (const [k, v] of Object.entries({
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100vh",
      margin: "0",
      padding: "0",
      border: "0",
      background: "transparent",
      overflow: "visible",
      "pointer-events": "none",
      "z-index": "2147483647",
      display: "block",
      "max-width": "none",
      "max-height": "none",
      color: "inherit",
    })) st.setProperty(k, v, "important");
    const root = host.attachShadow({ mode: "closed" });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS_TEXT);
      root.adoptedStyleSheets = [sheet];
    } catch {
      const style = this.doc.createElement("style");
      style.textContent = CSS_TEXT;
      root.appendChild(style);
    }
    (this.doc.body ?? this.doc.documentElement).appendChild(host);
    this.host = host;
    this.root = root;
    this.promote();
    this.doc.addEventListener("toggle", this.onToggle, true);
    // A newer top-layer element (dialog.showModal, popover) wins; re-promote ourselves after it.
    this.topLayerWatch = new MutationObserver((muts) => {
      if (muts.some((m) => m.type === "attributes" && (m.attributeName === "open" || m.attributeName === "popover"))) this.promote();
    });
    this.topLayerWatch.observe(this.doc.documentElement, { subtree: true, attributes: true, attributeFilter: ["open", "popover"] });
  }

  /** Put the host on top of the top layer. Calling hide+show moves it to the end. */
  promote() {
    const host = this.host as (HTMLElement & { showPopover?: () => void; hidePopover?: () => void }) | null;
    if (!host || typeof host.showPopover !== "function") return;
    try {
      if (!host.hasAttribute("popover")) host.setAttribute("popover", "manual");
      if (host.matches(":popover-open")) host.hidePopover!();
      host.showPopover();
    } catch {
      /* not supported or detached */
    }
  }

  show(target: Element, label: string) {
    this.ensureHost();
    this.target = target;
    if (!this.ring) {
      this.ring = this.doc.createElement("div");
      this.ring.className = "ring";
      this.tag = this.doc.createElement("div");
      this.tag.className = "tag";
      this.ring.appendChild(this.tag);
      this.root!.appendChild(this.ring);
    }
    this.tag!.textContent = label;
    this.ring.style.display = "block";
    scrollIntoViewIfNeeded(target);
    this.place();
    this.startTracking();
  }

  retarget(target: Element) {
    this.target = target;
    this.place();
  }

  pulse() {
    if (!this.ring) return;
    this.ring.classList.remove("again");
    void this.ring.offsetWidth;
    this.ring.classList.add("again");
    if (this.target) scrollIntoViewIfNeeded(this.target);
  }

  hide() {
    this.target = null;
    if (this.ring) this.ring.style.display = "none";
    this.host?.removeAttribute("data-ring");
    this.stopTracking();
  }

  banner(text: string, onStart: () => void) {
    this.ensureHost();
    this.root!.querySelector(".banner")?.remove();
    const b = this.doc.createElement("div");
    b.className = "banner";
    b.setAttribute("role", "dialog");
    const span = this.doc.createElement("span");
    span.textContent = text;
    const start = this.doc.createElement("button");
    start.textContent = "Start";
    start.addEventListener("click", () => {
      b.remove();
      onStart();
    });
    const later = this.doc.createElement("button");
    later.className = "later";
    later.textContent = "Later";
    later.addEventListener("click", () => b.remove());
    b.append(span, start, later);
    this.root!.appendChild(b);
  }

  destroy() {
    this.stopTracking();
    this.topLayerWatch?.disconnect();
    this.doc.removeEventListener("toggle", this.onToggle, true);
    this.host?.remove();
    this.host = this.root = this.ring = this.tag = null;
  }

  /** For tests: the ring's current box. */
  get ringBox(): { left: number; top: number; width: number; height: number; visible: boolean } | null {
    if (!this.ring) return null;
    const s = this.ring.style;
    return { left: parseFloat(s.left), top: parseFloat(s.top), width: parseFloat(s.width), height: parseFloat(s.height), visible: s.display !== "none" };
  }

  private place() {
    if (!this.ring || !this.target) return;
    const r = this.target.getBoundingClientRect();
    const pad = 8;
    const s = this.ring.style;
    s.left = `${Math.round(r.left - pad)}px`;
    s.top = `${Math.round(r.top - pad)}px`;
    s.width = `${Math.round(r.width + pad * 2)}px`;
    s.height = `${Math.round(r.height + pad * 2)}px`;
    const vw = this.doc.defaultView?.innerWidth ?? 1024;
    const side = r.right + pad + 170 < vw;
    this.ring.classList.toggle("side", side);
    this.ring.classList.toggle("below", !side && r.top < 48);
    // Geometry only (no page data): lets tests and the dock check where the ring is.
    this.host?.setAttribute("data-ring", `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`);
  }

  private startTracking() {
    this.stopTracking();
    const loop = () => {
      this.place();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    // rAF pauses in background tabs; the timer keeps position right when she comes back.
    this.timer = setInterval(() => this.place(), 250);
  }

  private stopTracking() {
    cancelAnimationFrame(this.raf);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function scrollIntoViewIfNeeded(el: Element) {
  const r = el.getBoundingClientRect();
  const vh = el.ownerDocument.defaultView?.innerHeight ?? 800;
  if (r.top < 60 || r.bottom > vh - 40) {
    const reduce = el.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }
}
