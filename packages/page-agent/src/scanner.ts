import type { FieldInfo, FieldKind, SnapshotElement } from "@justask/shared";
import { colorName } from "./color";
import { fingerprint, normalize } from "./fingerprint";
import { isSensitive } from "./sensitive";
import { closestComposed, containsComposed, inViewport, isVisible, pickModal } from "./visibility";

export { closestComposed, isVisible };

// Mana's SEL, extended per plan §3.3 and ARCHITECTURE §10 P1/P2.
export const CLICKABLE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[contenteditable=true]",
  "[contenteditable='']",
  "[contenteditable=plaintext-only]",
  "[tabindex]:not([tabindex='-1'])",
  ...[
    "button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "checkbox", "radio", "switch", "option",
    "combobox", "textbox", "searchbox", "listbox", "treeitem", "spinbutton", "slider",
  ].map((r) => `[role=${r}]`),
].join(", ");

/** Editable regions whose typed text must never be read. */
const EDITABLE_SELECTOR = "[contenteditable=true], [contenteditable=''], [contenteditable=plaintext-only], [role=textbox], [role=searchbox]";
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

/** A contenteditable host or a [role=textbox|searchbox] that is not a native control. */
export function isEditableHost(el: Element): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return false;
  return (el as HTMLElement).isContentEditable === true || el.matches(EDITABLE_SELECTOR);
}

const TEXT_INPUT_TYPES = new Set(["text", "search", ""]);
const SEARCH_WORD = /(?:^|\s)(search|query|find|keywords?)(?:\s|$)/;

function searchWords(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.[\]]+/g, " ")
    .toLowerCase();
}

/**
 * A search field: type=search, role=searchbox, a text input inside [role=search] / <search>,
 * or a text input whose name/id/aria-label/placeholder means search (q, query, search, find, keyword).
 */
export function isSearchBox(el: Element): boolean {
  if (el.getAttribute("role") === "searchbox") return true;
  if (!(el instanceof HTMLInputElement)) return false;
  if (el.type === "search") return true;
  if (!TEXT_INPUT_TYPES.has(el.type)) return false;
  if (closestComposed(el, "[role=search], search")) return true;
  for (const a of ["name", "id"]) if (/^q$/i.test(el.getAttribute(a) ?? "")) return true;
  return ["name", "id", "aria-label", "placeholder"].some((a) => SEARCH_WORD.test(searchWords(el.getAttribute(a) ?? "")));
}

export function roleOf(el: Element): string {
  if (isSearchBox(el)) return "search box";
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
  if (isEditableHost(el)) return "text box";
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
  if (isEditableHost(el)) {
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
    const safe = ids
      .split(/\s+/)
      .map((id) => (root.getElementById ? root.getElementById(id) : (root as ShadowRoot).querySelector(`#${CSS.escape(id)}`)))
      .filter((node): node is Element => !!node)
      .map((node) => safeText(node))
      .join(" ");
    if (safe.trim()) return clip(safe);
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
  return safeText(label, label.control ?? undefined);
}

/** Text for names/context only. Never includes an editable subtree or live status message. */
function safeText(root: Node, skip?: Node): string {
  if (root === skip) return "";
  if (root.nodeType === Node.TEXT_NODE) return root.textContent ?? "";
  if (root instanceof Element) {
    if (
      isEditableHost(root) ||
      insideEditable(root) ||
      root.matches("input, textarea, select, option, [role=alert], [role=status]")
    ) return "";
  }
  return Array.from(root.childNodes).map((child) => safeText(child, skip)).join(" ");
}

function clip(s: string): string {
  return normalize(s).slice(0, TEXT_MAX);
}

export function fieldKind(el: Element): FieldKind | null {
  if (el instanceof HTMLSelectElement) return "select";
  if (el instanceof HTMLTextAreaElement) return "textarea";
  if (el instanceof HTMLInputElement) {
    const t = el.type;
    if (["submit", "button", "reset", "image", "range", "color", "hidden"].includes(t)) return null;
    if (el.autocomplete === "one-time-code") return "otp";
    if (["password", "email", "number", "tel", "search", "url", "date", "time", "month", "checkbox", "radio", "file"].includes(t)) return t as FieldKind;
    if (t === "datetime-local" || t === "week") return "date";
    return "text";
  }
  if (isEditableHost(el)) return "contenteditable";
  return null;
}

/** `hasValue` is a local boolean only. The value never leaves this function. */
export function hasValue(el: Element): boolean {
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") return el.checked;
    if (el.type === "file") return (el.files?.length ?? 0) > 0;
    return el.value !== "";
  }
  if (el instanceof HTMLTextAreaElement) return el.value !== "";
  if (el instanceof HTMLSelectElement) {
    if (el.selectedIndex < 0) return false;
    const selected = el.options[el.selectedIndex];
    if (selected && isPlaceholderOption(el, selected)) return false;
    return true;
  }
  if (isEditableHost(el)) return (el.textContent ?? "").trim() !== "";
  return false;
}

/** Common first-option placeholders, including the no-value-attribute form. */
function isPlaceholderOption(select: HTMLSelectElement, option: HTMLOptionElement): boolean {
  if (select.multiple || select.size > 1 || option.index !== 0) return false;
  if (option.disabled || option.hidden || option.value.trim() === "") return true;
  return /^(please\s+)?(select|choose|pick)(\s+(an?|the))?(\s+.+)?[.…]*$/i.test(normalize(option.label || option.text));
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
    const labels = Array.from(el.options).map((o) => normalize(o.label || o.text));
    info.optionCount = labels.length;
    info.options = labels.length > 30 ? labels.slice(0, 10) : labels;
  }
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) info.checked = el.checked;
  const hint = dateHint(kind);
  if (hint) info.formatHint = hint;
  if (isSensitive(el)) info.sensitive = true;
  return info;
}

/** Landmark region. "modal" only for the modal `pickModal` chose, never for an off-screen drawer. */
function regionOf(el: Element, modal: Element | null): SnapshotElement["region"] {
  if (modal && containsComposed(modal, el)) return "modal";
  if (closestComposed(el, "main, [role=main]")) return "main";
  if (closestComposed(el, "nav, [role=navigation]")) return "nav";
  if (closestComposed(el, "footer, [role=contentinfo]")) return "footer";
  if (closestComposed(el, "aside, [role=complementary]")) return "aside";
  if (closestComposed(el, "header, [role=banner]")) return "header";
  return "other";
}

/** Nearest heading or row text, for context ("Refill" next to "Lisinopril"). */
export function nearbyText(el: Element, ownText: string): string | null {
  let cur: Element | null = el.parentElement;
  for (let depth = 0; cur && depth < 4; depth++, cur = cur.parentElement) {
    const h = cur.querySelector("h1,h2,h3,h4,h5,h6,legend,strong,[role=heading]");
    if (h && !h.contains(el)) {
      const t = clip(safeText(h));
      if (t && t !== ownText) return t;
    }
    // Generic row/list context preserves identical controls in distinct rows even when the
    // site has no heading element (for example two unlabelled "Edit" buttons).
    const row = cur.matches("li, tr, [role=row], [role=listitem], article, fieldset");
    const t = clip(safeContextText(cur, el));
    if (t && t !== ownText && (row || depth === 0)) return t;
  }
  return null;
}

function safeContextText(root: Element, target: Element): string {
  const walk = (node: Node): string => {
    if (node === target || (node instanceof Element && isInteractiveContext(node))) return "";
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node instanceof Element && node.matches("[contenteditable=true], [contenteditable=''], [contenteditable=plaintext-only], [role=textbox], [role=searchbox], [role=alert], [role=status]")) return "";
    return Array.from(node.childNodes).map(walk).join(" ");
  };
  return normalize(walk(root));
}

function isInteractiveContext(el: Element): boolean {
  return el.matches("a[href], button, input, select, textarea, [role=button], [role=link], [role=checkbox], [role=radio], [role=menuitem], [role=option]");
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
  const candidates = collectComposed(doc, opts).filter(
    (el) => isVisible(el) && !insideEditable(el) && !closestComposed(el, "[role=alert], [role=status]"),
  );

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

  const modal = pickModal(doc);
  const win = doc.defaultView ?? window;

  const ctxWords = words((opts.context ?? []).join(" "));
  const focusForm = (doc.activeElement as HTMLElement | null)?.closest?.("form") ?? null;

  const scored: ScannedElement[] = [];
  const dupKeys = new Set<string>();
  for (const el of filtered) {
    const inModal = !!modal && containsComposed(modal, el);
    if (modal && !inModal) continue; // plan §3.3: if a modal is open, elements outside it are dropped
    const r = el.getBoundingClientRect();
    const role = roleOf(el);
    const text = visibleText(el);
    let name = accessibleName(el);
    if (name === text) name = "";
    const field = fieldInfo(el);
    if (!text && !name && !field) continue;
    const region = inModal ? "modal" : regionOf(el, modal);
    const disabled = isDisabled(el);
    const vis = inViewport(r, win);
    const cs = getComputedStyle(el);
    const color = colorName(cs.backgroundColor);
    const big = r.width * r.height > 9000;
    const nearby = nearbyText(el, text);

    // Same control in different rows ("Add to cart" under each product) stays distinct via `nearby`.
    const dupKey = `${role}|${text}|${name}|${(el as HTMLAnchorElement).href ?? ""}|${nearby ?? ""}`;
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
        nearby,
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
  const root: ParentNode = pickModal(doc) ?? doc; // same modal choice as scanDocument
  for (const e of Array.from(root.querySelectorAll("h1,h2,h3,p,li,label,legend,[role=alert],[role=status]"))) {
    if (!isVisible(e)) continue;
    if (e.closest("script,style,noscript")) continue;
    if (insideEditable(e) || isEditableHost(e)) continue; // typed text in editors must never be read
    if (e.matches("[role=alert], [role=status]") || closestComposed(e, "[role=alert], [role=status]")) continue;
    const t = normalize(safeText(e));
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t.slice(0, 200));
    if (out.join("\n").length > max) break;
  }
  return out.join("\n").slice(0, max);
}

export function mainHeading(doc: Document): string {
  const h = Array.from(doc.querySelectorAll("h1, [role=heading][aria-level='1'], h2")).find(
    (el) => isVisible(el) && !isEditableHost(el) && !insideEditable(el) && !closestComposed(el, "[role=alert], [role=status]"),
  );
  return h ? clip(safeText(h)) : "";
}

/** URL with query and fragment stripped. */
export function strippedUrl(loc: Location | URL): string {
  return `${loc.protocol}//${loc.host}${loc.pathname}`;
}

/** True for nodes *inside* an editable region (not the editable root itself). */
export function insideEditable(el: Element): boolean {
  const p = el.parentElement;
  return !!p && (p.isContentEditable || !!closestComposed(p, EDITABLE_SELECTOR));
}

/** The parts a fingerprint is built from. Shared by the scanner and the resolver. */
export function elementParts(el: Element): { role: string; text: string; name: string } {
  const role = roleOf(el);
  const text = visibleText(el);
  let name = accessibleName(el);
  if (name === text) name = "";
  return { role, text, name };
}
