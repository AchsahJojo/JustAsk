import type { PageSnapshot } from "@justask/shared";

/**
 * A short hash of the interactive elements (role, text, field kind, hasValue). Used while
 * waiting to re-plan only when the page really changed. Never includes field values.
 */
export function snapshotSignature(snapshot: PageSnapshot): string {
  let h = 0x811c9dc5;
  const s = snapshot.elements.map((e) => `${e.role}|${e.text}|${e.field?.kind ?? ""}|${e.field?.hasValue ?? ""}`).join("\n");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${snapshot.elements.length}:${(h >>> 0).toString(16)}`;
}
