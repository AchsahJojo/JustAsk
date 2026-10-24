import type { FieldInfo, FieldKind, SnapshotElement } from "@justask/shared";
import { colorName } from "./color";
import { fingerprint, normalize } from "./fingerprint";

// Mana's SEL, extended per plan §3.3.
export const CLICKABLE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[contenteditable=true]",
  "[contenteditable='']",
  "[tabindex]:not([tabindex='-1'])",
  ...["button", "link", "tab", "menuitem", "checkbox", "radio", "switch", "option", "combobox", "textbox", "listbox", "treeitem"].map((r) => `[role=${r}]`),
].join(", ");

const MODAL_SELECTOR = "dialog[open], [aria-modal=true]";
const TEXT_MAX = 80;
export const ELEMENT_CAP = 150;

export interface ScanOptions {
  /** Closed shadow roots via the platform adapter (chrome.dom / Firefox). */
  getShadowRoot?: (el: Element) => ShadowRoot | null;
  /** Words from the request, recipe step and last spoken line, for ranking. */
  context?: string[];
  /** Elements added since the last scan (MutationObserver addedNodes). */
  recentlyAdded?: WeakSet<Node>;
  cap?: number;
}

export interface ScannedElement {
  el: Element;
  data: SnapshotElement;
  fp: string;
  score: number;
}

/** Walk the composed tree: light DOM plus open (and, via adapter, closed) shadow roots. */
export function collectComposed(root: Document | ShadowRoot | Element, opts: ScanOptions, out: Element[] = []): Element[] {
  const walker = (root as Node).ownerDocument
    ? ((root as Node).ownerDocument as Document).createTreeWalker(root as Node, NodeFilter.SHOW_ELEMENT)
    : (root as Document).createTreeWalker(root as Node, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode() as Element | null;
  while (node) {
    if (node.matches?.(CLICKABLE_SELECTOR)) out.push(node);
    const sr = node.shadowRoot ?? opts.getShadowRoot?.(node) ?? null;
    if (sr) collectComposed(sr, opts, out);
    node = walker.nextNode() as Element | null;
  }
  return out;
}

export function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 2 || r.height <= 2) {
    // Visually hidden native radios/checkboxes are often styled through a label; keep if the label is visible.
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio" || el.type === "file")) {
      const lab = el.labels?.[0];
      if (lab) return isVisible(lab);
    }
    return false;
  }
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.display === "none" || (cs.opacity !== "" && Number(cs.opacity) === 0)) return false;
  return true;
}

export function roleOf(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "select") return "dropdown";
  if (tag === "textarea") return "text box";
  if (tag === "input") {
    const t = (el as HTMLInputElement).type;
    if (["submit", "button", "reset", "image"].includes(t)) return "button";
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio button";
    if (t === "file") return "file picker";
    if (t === "range") return "slider";
    return "text box";
  }
  if ((el as HTMLElement).isContentEditable) return "text box";
  return tag;
}

/**
 * Visible text. NEVER uses `.value` except for button-type inputs, where it is page text
 * (plan change 5: Mana's readPage leaked typed text through `el.value`).
 */
export function visibleText(el: Element): string {
  if (el instanceof HTMLInputElement) {
    if (["submit", "button", "reset"].includes(el.type)) return clip(el.value || el.getAttribute("aria-label") || "");
    if (el.type === "image") return clip(el.alt || "");
    return clip(el.placeholder || "");
  }
  if (el instanceof HTMLTextAreaElement) return clip(el.placeholder || "");
  if (el instanceof HTMLSelectElement) return "";
  if ((el as HTMLElement).isContentEditable || el.getAttribute("role") === "textbox") {
    return clip(el.getAttribute("aria-placeholder") || el.getAttribute("data-placeholder") || el.getAttribute("placeholder") || "");
  }
  const t = (el as HTMLElement).innerText ?? el.textContent ?? "";
  if (t.trim()) return clip(t);
  const img = el.querySelector("img[alt]");
  if (img) return clip(img.getAttribute("alt") || "");
  return clip(el.getAttribute("title") || "");
}

/** Accessible name: aria-labelledby (same root), aria-label, <label>. Not values. */
export function accessibleName(el: Element): string {
  const ids = el.getAttribute("aria-labelledby");
  if (ids) {
    const root = el.getRootNode() as Document | ShadowRoot;
    const txt = ids
      .split(/\s+/)
      .map((id) => (root.getElementById ? root.getElementById(id) : (root as ShadowRoot).querySelector(`#${CSS.escape(id)}`))?.textContent ?? "")
      .join(" ");
    if (txt.trim()) return clip(txt);
  }
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return clip(aria);
  if ("labels" in el) {
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) {
      const t = Array.from(labels)
        .map((l) => labelTextWithoutControls(l))
        .join(" ");
      if (t.trim()) return clip(t);
    }
  }
  const title = el.getAttribute("title");
  if (title?.trim()) return clip(title);
  return "";
}

/** A <label> can wrap its own <select>/<input>; skip those children so option text doesn't leak in. */
function labelTextWithoutControls(label: HTMLLabelElement): string {
  let out = "";
  label.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent;
    else if (n instanceof HTMLElement && !n.matches("input, select, textarea, option")) out += n.innerText ?? n.textContent ?? "";
  });
  return out;
}

function clip(s: string): string {
  return normalize(s).slice(0, TEXT_MAX);
}

export function fieldKind(el: Element): FieldKind | null {
  if (el instanceof HTMLSelectElement) return "select";
  if (el instanceof HTMLTextAreaElement) return isSearchBox(el) ? "search" : "textarea";
  if (el instanceof HTMLInputElement) {
    const t = el.type;
    if (["submit", "button", "reset", "image", "range", "color", "hidden"].includes(t)) return null;
    if (el.autocomplete === "one-time-code") return "otp";
    if (["password", "email", "number", "tel", "search", "url", "date", "time", "month", "checkbox", "radio", "file"].includes(t)) return t as FieldKind;
    if (t === "datetime-local" || t === "week") return "date";
    return isSearchBox(el) ? "search" : "text";
  }
  if ((el as HTMLElement).isContentEditable || el.getAttribute("role") === "textbox") return "contenteditable";
  return null;
}

const SEARCH_HINT = /\b(search|query|keywords?|find)\b/i;
const SEARCH_NAMES = new Set(["q", "s", "k", "query", "search", "field-keywords", "search_query", "keyword", "keywords"]);
// Autocomplete tokens for personal data. A box with one of these is never a search box.
const PERSONAL = /\b(name|email|tel|username|password|one-time-code|address|postal|country|cc-|bday|sex|organization|street)/i;

/**
 * A plain search box: the only kind of box "Type it for me" may fill. Checked from attributes
 * and structure, never from the value. Anything that might hold personal data is excluded.
 */
export function isSearchBox(el: Element): boolean {
  if (el instanceof HTMLInputElement) {
    if (el.type === "search") return !el.closest("form")?.querySelector('input[type="password"]');
    if (el.type !== "text") return false;
  } else if (!(el instanceof HTMLTextAreaElement)) return false;
  if (PERSONAL.test(el.getAttribute("autocomplete") ?? "")) return false;
  if (el.closest("form")?.querySelector('input[type="password"]')) return false;
  if (el.getAttribute("role") === "searchbox") return true;
  if (el.closest('[role="search"], search')) return true;
  if (SEARCH_NAMES.has((el.getAttribute("name") ?? "").toLowerCase())) return true;
  const hints = ["id", "aria-label", "placeholder", "title"].map((a) => el.getAttribute(a) ?? "").join(" ");
  return SEARCH_HINT.test(hints.replace(/[-_]/g, " "));
}

/** `hasValue` is a local boolean only. The value never leaves this function. */
export function hasValue(el: Element): boolean {
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") return el.checked;
    if (el.type === "file") return (el.files?.length ?? 0) > 0;
    return el.value !== "";
  }
  if (el instanceof HTMLTextAreaElement) return el.value !== "";
  if (el instanceof HTMLSelectElement) return el.selectedIndex > 0 || (el.selectedIndex === 0 && el.options[0]?.value !== "");
  if ((el as HTMLElement).isContentEditable || el.getAttribute("role") === "textbox") return (el.textContent ?? "").trim() !== "";
  return false;
}

const DATE_HINTS: Record<string, string> = {
  date: "month, then day, then year",
  month: "month, then year",
  time: "hour, then minutes",
};

function dateHint(kind: FieldKind): string | undefined {
  if (!DATE_HINTS[kind]) return undefined;
  if (kind !== "date") return DATE_HINTS[kind];
  try {
    const parts = new Intl.DateTimeFormat(navigator.language).formatToParts(new Date(2000, 10, 22));
    const order = parts.filter((p) => ["month", "day", "year"].includes(p.type)).map((p) => p.type);
    if (order.length === 3) return `${order[0]}, then ${order[1]}, then ${order[2]}`;
  } catch {
    /* fall through */
  }
  return DATE_HINTS.date;
}

export function fieldInfo(el: Element): FieldInfo | undefined {
  const kind = fieldKind(el);
  if (!kind) return undefined;
  const info: FieldInfo = {
    kind,
    hasValue: hasValue(el),
    valid: "validity" in el ? (el as HTMLInputElement).validity.valid : true,
  };
  if (el instanceof HTMLSelectElement) {
    const labels = Array.from(el.options).map((o) => normalize(o.label || o.text).slice(0, 60));
    info.optionCount = labels.length;
    info.options = labels.length > 30 ? labels.slice(0, 10) : labels;
  }
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) info.checked = el.checked;
  const hint = dateHint(kind);
  if (hint) info.formatHint = hint;
  return info;
}

function regionOf(el: Element): SnapshotElement["region"] {
  if (closestComposed(el, MODAL_SELECTOR)) return "modal";
  if (closestComposed(el, "main, [role=main]")) return "main";
  if (closestComposed(el, "nav, [role=navigation]")) return "nav";
  if (closestComposed(el, "footer, [role=contentinfo]")) return "footer";
  if (closestComposed(el, "aside, [role=complementary]")) return "aside";
  if (closestComposed(el, "header, [role=banner]")) return "header";
  return "other";
}

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

/** Nearest heading or row text, for context ("Refill" next to "Lisinopril"). */
export function nearbyText(el: Element, ownText: string): string | null {
  let cur: Element | null = el.parentElement;
  for (let depth = 0; cur && depth < 4; depth++, cur = cur.parentElement) {
    const h = cur.querySelector("h1,h2,h3,h4,h5,h6,legend,strong,[role=heading]");
    if (h && !h.contains(el)) {
      const t = clip(h.textContent ?? "");
      if (t && t !== ownText) return t;
    }
  }
  return null;
}

function inViewport(r: DOMRect): boolean {
  return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}

function isDisabled(el: Element): boolean {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
}

function words(s: string): Set<string> {
  return new Set(
    normalize(s)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
}

/** Scan one document (frame). Returns ranked elements, capped, numbered from 1. */
export function scanDocument(doc: Document, opts: ScanOptions = {}): { elements: ScannedElement[]; omitted: { count: number; regions: string[] } } {
  const cap = opts.cap ?? ELEMENT_CAP;
  const candidates = collectComposed(doc, opts).filter((el) => isVisible(el) && !insideEditable(el));

  // Drop nested duplicates: an <a> inside a [role=button] wrapper etc. Keep the outermost interactive.
  const set = new Set(candidates);
  const filtered = candidates.filter((el) => {
    let p = el.parentElement;
    while (p) {
      if (set.has(p) && !fieldKind(el) && !fieldKind(p)) return false;
      p = p.parentElement;
    }
    return true;
  });

  const modal = (() => {
    const all = Array.from(doc.querySelectorAll(MODAL_SELECTOR)).filter(isVisible);
    return all[all.length - 1] ?? null;
  })();

  const ctxWords = words((opts.context ?? []).join(" "));
  const focusForm = (doc.activeElement as HTMLElement | null)?.closest?.("form") ?? null;

  const scored: ScannedElement[] = [];
  const dupKeys = new Set<string>();
  for (const el of filtered) {
    const inModal = !!(modal && closestComposed(el, MODAL_SELECTOR));
    if (modal && !inModal) continue; // plan §3.3: if a modal is open, elements outside it are dropped
    const r = el.getBoundingClientRect();
    const role = roleOf(el);
    const text = visibleText(el);
    let name = accessibleName(el);
    if (name === text) name = "";
    const field = fieldInfo(el);
    if (!text && !name && !field) continue;
    const region = inModal ? "modal" : regionOf(el);
    const disabled = isDisabled(el);
    const vis = inViewport(r);
    const cs = getComputedStyle(el);
    const color = colorName(cs.backgroundColor);
    const big = r.width * r.height > 9000;

    const dupKey = `${role}|${text}|${(el as HTMLAnchorElement).href ?? ""}`;
    if (!field && dupKeys.has(dupKey)) continue;
    dupKeys.add(dupKey);

    let score = 0;
    if (inModal) score += 5;
    if (opts.recentlyAdded?.has(el)) score += 4;
    if (vis) score += 3;
    if (region === "main") score += 2;
    const w = words(text + " " + name);
    for (const x of w) if (ctxWords.has(x)) {
      score += 2;
      break;
    }
    if (big || color) score += 1;
    if (region === "nav" || region === "footer" || region === "aside") score -= 1;
    if (disabled) score -= 1;
    if (focusForm && field && focusForm.contains(el)) score += 100; // always kept

    scored.push({
      el,
      fp: fingerprint(el, { role, text, name }),
      score,
      data: {
        n: 0,
        role,
        text,
        label: name || null,
        nearby: nearbyText(el, text),
        color,
        big,
        disabled,
        inModal,
        inViewport: vis,
        region,
        ...(field ? { field } : {}),
      },
    });
  }

  // Keep top `cap` by score, then restore document order for numbering (reads naturally).
  const order = new Map(scored.map((s, i) => [s, i]));
  const kept = [...scored].sort((a, b) => b.score - a.score || order.get(a)! - order.get(b)!).slice(0, cap);
  const keptSet = new Set(kept);
  const omittedEls = scored.filter((s) => !keptSet.has(s));
  kept.sort((a, b) => order.get(a)! - order.get(b)!);
  kept.forEach((s, i) => (s.data.n = i + 1));
  return {
    elements: kept,
    omitted: { count: omittedEls.length, regions: [...new Set(omittedEls.map((s) => s.data.region))] },
  };
}

/** Page text for context: headings, paragraphs, list items. Never form values. */
export function pageText(doc: Document, max = 1400): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const modal = Array.from(doc.querySelectorAll(MODAL_SELECTOR)).filter(isVisible).pop();
  const root: ParentNode = modal ?? doc;
  for (const e of Array.from(root.querySelectorAll("h1,h2,h3,p,li,label,legend,[role=alert],[role=status]"))) {
    if (!isVisible(e)) continue;
    if (e.closest("script,style,noscript")) continue;
    if (insideEditable(e)) continue; // typed text in editors must never be read
    const t = normalize((e as HTMLElement).innerText ?? e.textContent ?? "");
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t.slice(0, 200));
    if (out.join("\n").length > max) break;
  }
  return out.join("\n").slice(0, max);
}

export function mainHeading(doc: Document): string {
  const h = Array.from(doc.querySelectorAll("h1, [role=heading][aria-level='1'], h2")).find(isVisible);
  return h ? clip(h.textContent ?? "") : "";
}

/** URL with query and fragment stripped. */
export function strippedUrl(loc: Location | URL): string {
  return `${loc.protocol}//${loc.host}${loc.pathname}`;
}

/** True for nodes *inside* an editable region (not the editable root itself). */
export function insideEditable(el: Element): boolean {
  const p = el.parentElement;
  return !!p && (p.isContentEditable || !!p.closest("[role=textbox]"));
}

/** The parts a fingerprint is built from. Shared by the scanner and the resolver. */
export function elementParts(el: Element): { role: string; text: string; name: string } {
  const role = roleOf(el);
  const text = visibleText(el);
  let name = accessibleName(el);
  if (name === text) name = "";
  return { role, text, name };
}
