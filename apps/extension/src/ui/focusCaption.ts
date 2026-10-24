/** Keep spoken-line updates from stealing the answer field's focus during a clarify step. */
export function focusCaptionUnlessAsking(phase: string, caption: Pick<HTMLElement, "focus"> | null): void {
  if (phase !== "asking") caption?.focus({ preventScroll: true });
}
