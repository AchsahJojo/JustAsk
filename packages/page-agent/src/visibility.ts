// Visibility and modal rules (ARCHITECTURE §10 P2). DOM only, no browser-extension APIs.

export const MODAL_SELECTOR = "dialog[open], [aria-modal=true]";
const HIDDEN_SUBTREE = '[aria-hidden="true"], [inert]';

/** `closest` that crosses shadow boundaries. */
export function closestComposed(el: Element, selector: string): Element | null {
  let cur: Node | null = el;
  while (cur) {
    if (cur instanceof Element) {
      const hit = cur.closest(selector);
      if (hit) return hit;
    }
    const root: Node = (cur as Element).getRootNode?.() ?? cur;
    cur = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

export type ShadowGetter = (el: Element) => ShadowRoot | null;

/**
 * `querySelectorAll` that also looks inside open shadow roots, and closed ones when `getShadowRoot`
 * can open them (chrome.dom). Document order, light DOM before each host's shadow content.
 */
export function queryAllComposed(root: Document | ShadowRoot | Element, selector: string, getShadowRoot?: ShadowGetter): Element[] {
  const out: Element[] = [];
  const visit = (r: Document | ShadowRoot | Element) => {
    const doc = (r as Node).ownerDocument ?? (r as Document);
    const walker = doc.createTreeWalker(r as Node, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode() as Element | null; n; n = walker.nextNode() as Element | null) {
      if (n.matches(selector)) out.push(n);
      const sr = n.shadowRoot ?? getShadowRoot?.(n) ?? null;
      if (sr) visit(sr);
    }
  };
  if (root instanceof Element && root.matches(selector)) out.push(root);
  if (root instanceof Element) {
    const sr = root.shadowRoot ?? getShadowRoot?.(root) ?? null;
    if (sr) visit(sr);
  }
  visit(root);
  return out;
}

/** Parent in the composed tree: the parent element, or the shadow host at a root boundary. */
export function composedParent(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode?.();
  return root instanceof ShadowRoot ? root.host : null;
}

/** `ancestor.contains(el)` across shadow boundaries. */
export function containsComposed(ancestor: Element, el: Element): boolean {
  for (let cur: Element | null = el; cur; cur = composedParent(cur)) if (cur === ancestor) return true;
  return false;
}

/** True when the element sits in an `aria-hidden="true"` or `inert` subtree (shadow roots included). */
export function inHiddenSubtree(el: Element): boolean {
  return !!closestComposed(el, HIDDEN_SUBTREE);
}

/** True when the rect lies wholly outside the document: left of 0, right of its width, or above its top. */
export function isOffCanvas(r: DOMRect, doc: Document): boolean {
  const win = doc.defaultView;
  const width = Math.max(doc.documentElement?.scrollWidth ?? 0, win?.innerWidth ?? 0);
  if (r.right <= 0) return true;
  if (width > 0 && r.left >= width) return true;
  if (r.bottom + (win?.scrollY ?? 0) <= 0) return true;
  return false;
}

/** Overflow per axis. happy-dom and some engines leave the longhands empty, so fall back to the shorthand. */
function overflowAxes(cs: CSSStyleDeclaration): [string, string] {
  const short = (cs.overflow || "").trim().split(/\s+/);
  return [cs.overflowX || short[0] || "", cs.overflowY || short[1] || short[0] || ""];
}

const CLIPS = new Set(["hidden", "clip"]);
const SCROLLS = new Set(["auto", "scroll", "overlay"]);

/**
 * True when an overflow hidden/clip ancestor cuts the element away entirely (collapsed mega-menus).
 * Stops at <body>, at scroll containers (the user can scroll to it) and at position:fixed boxes.
 */
export function isClipped(el: Element, r: DOMRect): boolean {
  const doc = el.ownerDocument;
  if (getComputedStyle(el).position === "fixed") return false;
  for (let a = composedParent(el); a && a !== doc.body && a !== doc.documentElement; a = composedParent(a)) {
    const cs = getComputedStyle(a);
    const [ox, oy] = overflowAxes(cs);
    const clipX = CLIPS.has(ox);
    const clipY = CLIPS.has(oy);
    if (clipX || clipY) {
      const ar = a.getBoundingClientRect();
      if (clipX && (r.right <= ar.left || r.left >= ar.right)) return true;
      if (clipY && (r.bottom <= ar.top || r.top >= ar.bottom)) return true;
    }
    if (SCROLLS.has(ox) || SCROLLS.has(oy) || cs.position === "fixed") return false;
  }
  return false;
}

const CHECK_VIS = { opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true };

/** Can the user see it? Size, CSS (via checkVisibility when present), aria-hidden/inert, clipping and off-canvas. */
export function isVisible(el: Element): boolean {
  if (inHiddenSubtree(el)) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 2 || r.height <= 2) {
    // Visually hidden native radios/checkboxes are often styled through a label; keep if the label is visible.
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio" || el.type === "file")) {
      const lab = el.labels?.[0];
      if (lab) return isVisible(lab);
    }
    return false;
  }
  const cv = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility;
  if (typeof cv === "function" && !cv.call(el, CHECK_VIS)) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.display === "none" || (cs.opacity !== "" && Number(cs.opacity) === 0)) return false;
  if (isOffCanvas(r, el.ownerDocument)) return false;
  if (isClipped(el, r)) return false;
  return true;
}

/** True when the rect overlaps the window's viewport. */
export function inViewport(r: DOMRect, win: Window = window): boolean {
  return r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth;
}

/** The modal wins a hit test at its center (skipped when the engine has no hit testing). */
function winsHitTest(m: Element, r: DOMRect): boolean {
  const root = m.getRootNode() as Document | ShadowRoot;
  if (typeof root.elementFromPoint !== "function") return true;
  const hit = root.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!hit) return true;
  if (hit.tagName === "JUSTASK-OVERLAY") return true; // our own banner may sit on top
  return hit === m || m.contains(hit);
}

function isTopLayerModal(m: Element): boolean {
  try {
    return m.matches(":modal");
  } catch {
    return false;
  }
}

/**
 * The open modal, or null. A dialog[open] / [aria-modal=true] counts only when visible,
 * in the viewport and on top at its center, so an off-screen drawer never hides the page.
 */
export function pickModal(doc: Document, getShadowRoot?: ShadowGetter): Element | null {
  const win = doc.defaultView ?? window;
  // Dialogs inside web components count too (a <dialog> in a shadow root hides the page just the same).
  const ok = queryAllComposed(doc, MODAL_SELECTOR, getShadowRoot).filter((m) => {
    if (!isVisible(m)) return false;
    const r = m.getBoundingClientRect();
    return inViewport(r, win) && winsHitTest(m, r);
  });
  const top = ok.filter(isTopLayerModal);
  return (top.length ? top : ok).at(-1) ?? null;
}
