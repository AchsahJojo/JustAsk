// Fingerprints survive rerenders (plan §3.4): role + text + name + nearest heading + landmark + ordinal.

export function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function hash(s: string): string {
  // FNV-1a 32-bit, hex. Collisions are handled by the "exactly one match" rule.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function nearestHeading(el: Element): string {
  let cur: Element | null = el;
  for (let depth = 0; cur && depth < 6; depth++, cur = cur.parentElement) {
    let sib: Element | null = cur.previousElementSibling;
    while (sib) {
      if (/^H[1-6]$/.test(sib.tagName) || sib.getAttribute("role") === "heading") return normalize(sib.textContent ?? "").slice(0, 60);
      const inner = sib.querySelector?.("h1,h2,h3,h4,h5,h6");
      if (inner) return normalize(inner.textContent ?? "").slice(0, 60);
      sib = sib.previousElementSibling;
    }
  }
  return "";
}

function landmark(el: Element): string {
  const lm = el.closest("main,nav,header,footer,aside,form,dialog,[role=main],[role=navigation],[role=dialog]");
  return lm ? lm.tagName.toLowerCase() + (lm.getAttribute("role") ?? "") : "";
}

function ordinal(el: Element, key: string, keyOf: (e: Element) => string): number {
  const parent = el.parentElement;
  if (!parent) return 0;
  let i = 0;
  for (const sib of Array.from(parent.children)) {
    if (sib === el) return i;
    if (sib.tagName === el.tagName && keyOf(sib) === key) i++;
  }
  return i;
}

export interface FingerprintParts {
  role: string;
  text: string;
  name: string;
}

export function fingerprint(el: Element, parts: FingerprintParts): string {
  const base = `${parts.role}|${normalize(parts.text)}|${normalize(parts.name)}`;
  const keyOf = (e: Element) => normalize((e as HTMLElement).innerText ?? e.textContent ?? "").slice(0, 80);
  const ord = ordinal(el, keyOf(el), keyOf);
  return hash(`${base}|${nearestHeading(el)}|${landmark(el)}|${ord}`);
}

/** Role + text only: the looser fallback match. */
export function roleTextKey(parts: FingerprintParts): string {
  return `${parts.role}|${normalize(parts.text)}`;
}
