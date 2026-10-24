import { describe, expect, it, vi } from "vitest";
import { focusCaptionUnlessAsking } from "../src/ui/focusCaption";

describe("focusCaptionUnlessAsking", () => {
  it("doesn't take focus away from the clarify answer field when the spoken line changes", () => {
    const focus = vi.fn();
    focusCaptionUnlessAsking("asking", { focus });
    expect(focus).not.toHaveBeenCalled();
  });

  it("moves focus to the caption in other phases", () => {
    const focus = vi.fn();
    focusCaptionUnlessAsking("guiding", { focus });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});
