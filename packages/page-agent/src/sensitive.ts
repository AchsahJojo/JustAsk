// Deterministic `sensitive` classifier (ARCHITECTURE §11). JustAsk never types into these; the user does.
// Reads only attributes and label text, never the field's value.

const AUTOCOMPLETE_SECRET = new Set(["current-password", "new-password", "one-time-code"]);

/** Word-boundary patterns over normalized attribute/label text ("spinach" and "shipping" never match `pin`). */
const SECRET_WORDS: RegExp[] = [
  /\bcard\s*((number|no|num)\b|#)/,
  /\b(credit|debit)\s*card\b/,
  /\bcc\s*(num|number|no)\b/,
  /\b(cvv2?|cvc2?|csc)\b/,
  /\bsecurity\s*code\b/,
  /\bcard\s*verification\b/,
  /\bssn\b/,
  /\bsocial\s*security\b/,
  /\brouting\b/,
  /\biban\b/,
  /\bsort\s*code\b/,
  /\bbank\s*account\b/,
  /\baccount\s*((number|no|num)\b|#)/,
  /\bacct(\s*(number|no|num))?\b/,
  /\bpin\b/,
  /\botp\b/,
  /\bpasscode\b/,
  /\bone\s*time\s*(code|password|pass)\b/,
  // Gift card numbers and claim codes: the thing gift card scams are after.
  /\bgift\s*card\b/,
  /\b(claim|redemption|redeem|voucher)\s*(code|number|no)\b/,
];

/** camelCase and `_-.[]` become spaces, lowercase. "cardNumber" -> "card number". */
function words(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.[\]:/]+/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Attribute and label text that names the field. Page text only, never the value. */
function namingText(el: Element): string {
  const parts: string[] = [];
  for (const a of ["name", "id", "aria-label", "placeholder", "aria-placeholder", "title"]) {
    const v = el.getAttribute(a);
    if (v) parts.push(v);
  }
  const ids = el.getAttribute("aria-labelledby");
  if (ids) {
    const root = el.getRootNode() as Document | ShadowRoot;
    for (const id of ids.split(/\s+/)) {
      const t = (root.getElementById ? root.getElementById(id) : null)?.textContent;
      if (t) parts.push(t);
    }
  }
  const labels = (el as HTMLInputElement).labels;
  if (labels) for (const l of Array.from(labels)) parts.push(l.textContent ?? "");
  return words(parts.join(" "));
}

/**
 * True for passwords, one-time codes, card/CVV, gift card and claim codes, SSN and bank fields.
 * When the check itself fails, the field is treated as sensitive.
 */
export function isSensitive(el: Element): boolean {
  try {
    if (el instanceof HTMLInputElement && el.type === "password") return true;
    const ac = (el.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
    if (ac.some((t) => AUTOCOMPLETE_SECRET.has(t) || t.startsWith("cc-"))) return true;
    const cs = el.ownerDocument.defaultView?.getComputedStyle(el) as (CSSStyleDeclaration & { webkitTextSecurity?: string }) | undefined;
    const sec = cs?.webkitTextSecurity;
    if (sec && sec !== "none") return true; // masked like a password
    const text = namingText(el);
    return SECRET_WORDS.some((re) => re.test(text));
  } catch {
    return true;
  }
}
