import { z } from "zod";

/** Kinds of form field the scanner reports. Values are never captured, only `hasValue`. */
export const FieldKind = z.enum([
  "text",
  "password",
  "email",
  "number",
  "tel",
  "search",
  "url",
  "date",
  "time",
  "month",
  "textarea",
  "contenteditable",
  "select",
  "checkbox",
  "radio",
  "file",
  "otp",
]);
export type FieldKind = z.infer<typeof FieldKind>;

export const FieldInfo = z.object({
  kind: FieldKind,
  /** Local boolean only: the field is not empty. Never the value, its length or characters. */
  hasValue: z.boolean(),
  /** From `validity.valid`. `validationMessage` is never sent (it can quote the value). */
  valid: z.boolean(),
  /** Native <select> option labels: up to 30, or the first 10 when there are more. */
  options: z.array(z.string()).optional(),
  optionCount: z.number().int().optional(),
  /** Checkbox / radio state. This is page state, not typed text. */
  checked: z.boolean().optional(),
  /** Locale hint for date-like fields, e.g. "month, then day, then year". */
  formatHint: z.string().optional(),
  /**
   * Passwords, one-time codes, card/CVV, SSN, bank fields. Decided by deterministic page-agent
   * rules (never by Claude). JustAsk never types into these; the user does.
   */
  sensitive: z.boolean().optional(),
  /**
   * Entries already added to this box and shown as chips with a remove button (an email's recipients,
   * tags). A count only, never their text.
   */
  items: z.number().int().optional(),
});
export type FieldInfo = z.infer<typeof FieldInfo>;

export const SnapshotElement = z.object({
  n: z.number().int().positive(),
  role: z.string(),
  /** Visible text (or button-type input value). Trimmed to 80 chars. */
  text: z.string(),
  /** Accessible name when it differs from `text`. */
  label: z.string().nullable(),
  /** Nearby context: the nearest heading or row text. */
  nearby: z.string().nullable(),
  color: z.string().nullable(),
  big: z.boolean(),
  disabled: z.boolean(),
  inModal: z.boolean(),
  inViewport: z.boolean(),
  region: z.enum(["main", "nav", "header", "footer", "aside", "modal", "other"]),
  field: FieldInfo.optional(),
});
export type SnapshotElement = z.infer<typeof SnapshotElement>;

export const PageSnapshot = z.object({
  snapshotId: z.string(),
  url: z.string(),
  title: z.string(),
  heading: z.string(),
  pageText: z.string(),
  elements: z.array(SnapshotElement),
  omitted: z.object({ count: z.number().int(), regions: z.array(z.string()) }),
});
export type PageSnapshot = z.infer<typeof PageSnapshot>;
