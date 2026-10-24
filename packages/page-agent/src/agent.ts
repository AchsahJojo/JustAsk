import type { ActResult, ActSpec, FrameScan, FromContent, HighlightSpec } from "@justask/shared";
import { CLICKABLE_SELECTOR, closestComposed, collectComposed, elementParts, fieldKind, hasValue, isVisible, mainHeading, pageText, scanDocument, strippedUrl, type ScanOptions } from "./scanner";
import { fingerprint, normalize, roleTextKey } from "./fingerprint";
import { Overlay } from "./overlay";
import { performAct } from "./act";
import { containsComposed } from "./visibility";

/** Quiet time after real DOM mutations before `watch` reports a settled change. */
export const WATCH_QUIET_MS = 600;

interface Entry {
  ref: WeakRef<Element>;
  fp: string;
  roleText: string;
}

export interface AgentOptions {
  frameId: number;
  isTop: boolean;
  send: (msg: FromContent) => void;
  getShadowRoot?: ScanOptions["getShadowRoot"];
  doc?: Document;
}

/**
 * Frame-local half of JustAsk: scans its own document, draws its own overlay,
 * and watches its own clicks/typing. Never reads, stores or sends field values.
 */
export class PageAgent {
  private doc: Document;
  private registry = new Map<number, Entry>();
  private overlay: Overlay;
  private spec: HighlightSpec | null = null;
  private target: Element | null = null;
  private added = new WeakSet<Node>();
  private mo: MutationObserver;
  private lastMutation = 0;
  private resolveTimer: ReturnType<typeof setInterval> | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private done = false;
  private listeners: Array<[EventTarget, string, EventListener, boolean]> = [];
  private watching = false;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: AgentOptions) {
    this.doc = opts.doc ?? document;
    this.overlay = new Overlay(this.doc);
    this.mo = new MutationObserver((muts) => {
      let real = false;
      for (const m of muts) {
        if (isOurs(m.target) || onlyOurNodes(m)) continue;
        real = true;
        m.addedNodes.forEach((n) => this.added.add(n));
      }
      if (!real) return;
      this.lastMutation = Date.now();
      if (this.watching) this.armWatch();
      if (this.target && !this.target.isConnected) this.onTargetGone();
    });
    this.mo.observe(this.doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: false });
  }

  // ───────────── scan ─────────────

  scan(context: string[]): FrameScan {
    // A child frame smaller than 50×50 (tracking pixels, hidden widgets) has nothing she can use.
    const win = this.doc.defaultView;
    if (!this.opts.isTop && win && (win.innerWidth < 50 || win.innerHeight < 50)) {
      return {
        frameId: this.opts.frameId,
        isTop: false,
        visibleFrames: 0,
        snapshot: { url: strippedUrl(this.doc.location), title: this.doc.title, heading: "", pageText: "", elements: [], omitted: { count: 0, regions: [] }, surface: "web" },
      };
    }
    const recently = this.added;
    const { elements, omitted } = scanDocument(this.doc, {
      getShadowRoot: this.opts.getShadowRoot,
      context,
      recentlyAdded: { has: (n: Node) => hasAddedAncestor(n, recently) } as unknown as WeakSet<Node>,
    });
    this.added = new WeakSet();
    this.registry.clear();
    for (const s of elements) {
      this.registry.set(s.data.n, { ref: new WeakRef(s.el), fp: s.fp, roleText: roleTextKey({ role: s.data.role, text: s.data.text, name: s.data.label ?? "" }) });
    }
    const visibleFrames = Array.from(this.doc.querySelectorAll("iframe")).filter((f) => {
      const r = f.getBoundingClientRect();
      return r.width >= 50 && r.height >= 50 && isVisible(f);
    }).length;
    return {
      frameId: this.opts.frameId,
      isTop: this.opts.isTop,
      visibleFrames,
      snapshot: {
        url: strippedUrl(this.doc.location),
        title: this.doc.title,
        heading: mainHeading(this.doc, this.opts.getShadowRoot),
        pageText: pageText(this.doc, undefined, this.opts.getShadowRoot),
        elements: elements.map((e) => e.data),
        omitted,
        surface: "web",
      },
    };
  }

  // ───────────── resolve (plan §3.4) ─────────────

  resolve(localId: number): Element | null {
    const entry = this.registry.get(localId);
    if (!entry) return null;
    const live = entry.ref.deref();
    if (live && live.isConnected) return live;
    // Rescan this frame's candidates and match by fingerprint, then by role+text.
    const candidates = collectComposed(this.doc, { getShadowRoot: this.opts.getShadowRoot }).filter(isVisible);
    const described = candidates.map((el) => ({ el, parts: elementParts(el) }));
    const byFp = described.filter((d) => fingerprint(d.el, d.parts) === entry.fp);
    let hit: Element | null = byFp.length === 1 ? byFp[0].el : null;
    if (!hit) {
      const byRt = described.filter((d) => roleTextKey(d.parts) === entry.roleText);
      if (byRt.length === 1) hit = byRt[0].el;
    }
    if (hit) entry.ref = new WeakRef(hit);
    return hit;
  }

  // ───────────── highlight + observe ─────────────

  highlight(spec: HighlightSpec): boolean {
    this.clear();
    const el = this.resolve(spec.localId);
    if (!el) return false;
    this.spec = spec;
    this.target = el;
    this.done = false;
    this.overlay.show(el, spec.label);
    this.attachObservers();
    this.resolveTimer = setInterval(() => {
      if (this.target && !this.target.isConnected) this.onTargetGone();
    }, 250);
    return true;
  }

  pulse() {
    this.overlay.pulse();
  }

  clear() {
    this.spec = null;
    this.target = null;
    this.overlay.hide();
    for (const [t, type, fn, cap] of this.listeners) t.removeEventListener(type, fn, cap);
    this.listeners = [];
    if (this.resolveTimer) clearInterval(this.resolveTimer);
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.resolveTimer = null;
  }

  banner(text: string) {
    this.overlay.banner(text, () => this.opts.send({ type: "ja:banner-start" }));
  }

  /** Resolves true once the DOM has changed and then stayed quiet for `quietMs`. */
  waitForChange(timeoutMs: number, quietMs = 600): Promise<boolean> {
    const startedAt = Date.now();
    const baseline = this.lastMutation;
    const url = this.doc.location.href;
    return new Promise((resolve) => {
      const iv = setInterval(() => {
        const now = Date.now();
        const urlChanged = this.doc.location.href !== url;
        const changed = this.lastMutation > baseline || urlChanged;
        if (changed && now - this.lastMutation >= quietMs) {
          clearInterval(iv);
          resolve(true);
        } else if (now - startedAt >= timeoutMs) {
          clearInterval(iv);
          resolve(changed);
        }
      }, 100);
    });
  }

  // ───────────── act (drive mode, ARCHITECTURE §11) ─────────────

  /**
   * Perform one action on element `localId`. Refuses type/choose/submit on sensitive fields.
   * A highlighted step counts as done first, so our own synthetic events never report
   * step-done, wrong or lost; on failure the highlight is live again for guide mode.
   */
  act(spec: ActSpec): ActResult {
    const el = this.resolve(spec.localId);
    if (!el) return { ok: false };
    const prevDone = this.done;
    this.done = true;
    const result = performAct(el, spec);
    if (!result.ok) this.done = prevDone;
    return result;
  }

  // ───────────── watch (P1) ─────────────

  /**
   * While on, send `ja:page-changed` once each time real DOM mutations settle
   * (`WATCH_QUIET_MS` of quiet). Off cancels any pending report.
   */
  watch(on: boolean) {
    this.watching = on;
    if (!on && this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
  }

  private armWatch() {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      if (this.watching) this.opts.send({ type: "ja:page-changed", reason: "mutation" });
    }, WATCH_QUIET_MS);
  }

  destroy() {
    this.watch(false);
    this.clear();
    this.mo.disconnect();
    this.overlay.destroy();
  }

  private on(t: EventTarget, type: string, fn: EventListener, capture = true) {
    t.addEventListener(type, fn, capture);
    this.listeners.push([t, type, fn, capture]);
  }

  private isTargetPath(e: Event): boolean {
    const target = this.target;
    if (!target) return false;
    const path = e.composedPath();
    if (path.includes(target)) return true;
    // React may swap the node between pointerdown and click: accept a node with the same fingerprint.
    const entry = this.spec && this.registry.get(this.spec.localId);
    if (!entry) return false;
    for (const n of path) {
      if (!(n instanceof Element) || !n.matches(CLICKABLE_SELECTOR)) continue;
      if (fingerprint(n, elementParts(n)) === entry.fp) {
        this.target = n;
        return true;
      }
    }
    return false;
  }

  private finish(how: Extract<FromContent, { type: "ja:step-done" }>["how"]) {
    if (this.done) return;
    this.done = true;
    this.opts.send({ type: "ja:step-done", how });
  }

  private attachObservers() {
    const win = this.doc.defaultView!;
    const spec = this.spec!;

    const onPress = (e: Event) => {
      if (this.done || !this.target) return;
      if (this.isTargetPath(e)) {
        if (spec.expect === "click") this.finish("click");
        return;
      }
      const hit = (e.composedPath().find((n) => n instanceof Element && n.matches(CLICKABLE_SELECTOR)) as Element | undefined) ?? null;
      if (!hit || isOurs(hit)) return;
      if (e.type !== "click") return; // report wrong clicks once, on click
      if (spec.expect === "type" && fieldKind(hit)) return; // handled by typing check
      if (hit.tagName === "LABEL" && (hit as HTMLLabelElement).control === this.target) return;
      this.opts.send({ type: "ja:wrong", what: "click" });
    };
    this.on(win, "pointerdown", onPress);
    this.on(win, "click", onPress);

    if (spec.expect === "type") {
      const onInput = (e: Event) => {
        if (this.done) return;
        if (this.isTargetPath(e)) return;
        const el = e.composedPath()[0];
        if (el instanceof Element && fieldKind(el)) this.opts.send({ type: "ja:wrong", what: "typing" });
      };
      const tryAdvance = (e: Event) => {
        if (this.done || !this.target || !this.isTargetPath(e)) return;
        if (e.type === "keydown" && (e as KeyboardEvent).key !== "Enter") return;
        if (!hasValue(this.target)) return;
        const t = this.target as HTMLInputElement;
        const dateLike = ["date", "time", "month", "datetime-local", "week"].includes(t.type);
        if (dateLike && t.validity && !t.validity.valid) return;
        this.finish("typed");
      };
      this.on(this.doc, "input", onInput);
      this.on(this.doc, "change", tryAdvance);
      this.on(this.doc, "blur", tryAdvance); // capture-phase blur reaches the document
      this.on(this.doc, "focusout", tryAdvance);
      this.on(this.doc, "keydown", tryAdvance);
    }

    if (spec.expect === "choose") {
      this.on(this.doc, "change", (e) => {
        if (this.done || !this.isTargetPath(e)) return;
        const sel = this.target as HTMLSelectElement;
        const chosen = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
        // Compare locally; only `matched` leaves the page, never the selected value.
        const matched = !!chosen && normalize(chosen.label || chosen.text).toLowerCase() === normalize(spec.option ?? "").toLowerCase();
        if (matched) this.finish("chose");
        else this.opts.send({ type: "ja:wrong", what: "choice" });
      });
    }

    if (spec.expect === "file") {
      this.on(this.doc, "change", (e) => {
        if (this.done || !this.isTargetPath(e)) return;
        const files = (this.target as HTMLInputElement).files;
        if (files && files.length > 0) this.finish("file"); // names are never read
      });
    }

    if (spec.expect === "hover") {
      const enter = (e: Event) => {
        if (this.done || !this.isTargetPath(e)) return;
        if (this.hoverTimer) clearTimeout(this.hoverTimer);
        this.hoverTimer = setTimeout(() => {
          this.hoverTimer = null;
          this.finish("hovered");
        }, 300);
      };
      const leave = (e: Event) => {
        if (this.done || !this.target || !this.isTargetPath(e)) return;
        const related = (e as MouseEvent).relatedTarget;
        const next = related instanceof Element ? related : related instanceof Node ? related.parentElement : null;
        // Moving between descendants of the target is still a hover; leaving it cancels the dwell.
        if (next && containsComposed(this.target, next)) return;
        if (this.hoverTimer) clearTimeout(this.hoverTimer);
        this.hoverTimer = null;
      };
      this.on(this.doc, "pointerover", enter);
      this.on(this.doc, "mouseover", enter);
      this.on(this.doc, "pointerout", leave);
      this.on(this.doc, "mouseout", leave);
    }
  }

  private onTargetGone() {
    if (!this.spec) return;
    const next = this.resolve(this.spec.localId);
    if (next) {
      this.target = next;
      this.overlay.retarget(next);
      return;
    }
    if (this.done) return;
    this.clear();
    this.opts.send({ type: "ja:lost" });
  }
}

function isOurs(n: Node): boolean {
  let cur: Node | null = n;
  while (cur) {
    if (cur instanceof Element && cur.tagName === "JUSTASK-OVERLAY") return true;
    const root: Node = cur.getRootNode?.() ?? cur;
    if (root instanceof ShadowRoot) cur = root.host;
    else cur = (cur as Element).parentNode;
  }
  return false;
}

/** A childList mutation that only adds/removes our overlay host (e.g. on body). */
function onlyOurNodes(m: MutationRecord): boolean {
  if (m.type !== "childList") return false;
  const nodes = [...Array.from(m.addedNodes), ...Array.from(m.removedNodes)];
  return nodes.length > 0 && nodes.every((n) => n instanceof Element && n.tagName === "JUSTASK-OVERLAY");
}

function hasAddedAncestor(n: Node, set: WeakSet<Node>): boolean {
  let cur: Node | null = n;
  for (let i = 0; cur && i < 12; i++) {
    if (set.has(cur)) return true;
    const root: Node = cur.getRootNode?.() ?? cur;
    cur = cur.parentNode ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return false;
}

export { closestComposed };
