// Convex's generated function references for the backend in packages/backend.
export { api } from "@justask/backend/convex/_generated/api";
export type { Id } from "@justask/backend/convex/_generated/dataModel";

/** A readable message from a Convex error. Dev servers wrap it in "Uncaught Error: …"; prod hides plain Errors. */
export function errorText(e: unknown, fallback = "Something went wrong. Try again."): string {
  const data = (e as { data?: unknown })?.data;
  if (typeof data === "string") return data;
  const msg = e instanceof Error ? e.message : String(e ?? "");
  const m = msg.match(/Uncaught (?:Convex)?Error: (.+?)(?:\n|$)/);
  const text = (m?.[1] ?? "").replace(/\s+at .*$/, "").trim();
  if (!text || /^Server Error/.test(text)) return fallback;
  return text;
}
