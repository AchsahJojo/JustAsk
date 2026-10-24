import { describe, expect, it } from "vitest";
import { colorName } from "../src/color";

describe("colorName", () => {
  it.each([
    ["rgb(34, 139, 34)", "green"],
    ["rgba(0, 0, 255, 0.9)", "blue"],
    ["rgb(220 38 38 / 100%)", "red"],
    ["rgba(0, 0, 0, 0)", null],
    ["rgb(255, 255, 255)", null],
    ["rgb(20, 20, 20)", "black"],
    // Modern CSS colors as Chrome reports them in computed styles.
    ["oklch(0.627 0.258 29.23)", "red"],
    ["oklch(62.7% 0.258 29.23)", "red"],
    ["oklch(0.6 0.2 145)", "green"],
    ["oklch(0.55 0.22 262)", "blue"],
    ["oklch(0.97 0 0)", null],
    ["oklab(0.6 -0.15 0.12)", "green"],
    ["lab(50 -60 50)", "green"],
    ["lab(40 20 -70)", "blue"],
    ["lch(55 80 40)", "red"],
    ["color(srgb 0.9 0.4 0.1)", "orange"],
    ["color(display-p3 0.2 0.3 0.9)", "blue"],
    ["oklch(0.6 0.2 145 / 0)", null],
    ["transparent", null],
    [null, null],
  ])("%s -> %s", (css, word) => expect(colorName(css)).toBe(word));
});
