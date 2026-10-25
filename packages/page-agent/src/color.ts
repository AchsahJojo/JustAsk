// Ported from Mana's colorName. Computed styles can be rgb(), or (for colors written that way)
// oklch(), oklab(), lab(), lch() or color(srgb …). All of them become one plain word.

type RGBA = [number, number, number, number];

const num = (s: string | undefined, scale = 1): number => {
  if (!s || s === "none") return 0;
  return s.endsWith("%") ? (parseFloat(s) / 100) * scale : parseFloat(s);
};
const alpha = (s: string | undefined) => (s === undefined ? 1 : num(s, 1));
const toByte = (linear: number) => {
  const v = linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(Math.max(linear, 0), 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
};
const rad = (deg: number) => (deg * Math.PI) / 180;

function fromOklab(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toByte(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** CIE Lab (D50, as CSS uses) to sRGB bytes. */
function fromLab(L: number, a: number, b: number): [number, number, number] {
  const e = 216 / 24389,
    k = 24389 / 27;
  const fy = (L + 16) / 116,
    fx = fy + a / 500,
    fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > e ? t ** 3 : (116 * t - 16) / k);
  const X = inv(fx) * 0.96422,
    Y = L > k * e ? fy ** 3 : L / k,
    Z = inv(fz) * 0.82521;
  return [
    toByte(3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z),
    toByte(-0.9787684 * X + 1.9161415 * Y + 0.033454 * Z),
    toByte(0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z),
  ];
}

/** Any computed CSS color to sRGB 0–255 plus alpha, or null if it isn't one we read. */
export function parseColor(css: string | null | undefined): RGBA | null {
  const m = css?.trim().match(/^(rgba?|oklch|oklab|lab|lch|color)\(([^)]*)\)/i);
  if (!m) return null;
  const fn = m[1].toLowerCase();
  const [main, a] = m[2].split("/").map((x) => x.trim());
  const p = main.split(/[\s,]+/).filter(Boolean);
  if (fn === "rgb" || fn === "rgba") {
    const [r, g, b] = p.slice(0, 3).map((x) => (x.endsWith("%") ? num(x, 255) : parseFloat(x)));
    return [r, g, b, a !== undefined ? alpha(a) : p[3] !== undefined ? alpha(p[3]) : 1];
  }
  if (fn === "oklab") return [...fromOklab(num(p[0], 1), num(p[1], 0.4), num(p[2], 0.4)), alpha(a)];
  if (fn === "oklch") {
    const C = num(p[1], 0.4),
      h = rad(num(p[2]));
    return [...fromOklab(num(p[0], 1), C * Math.cos(h), C * Math.sin(h)), alpha(a)];
  }
  if (fn === "lab") return [...fromLab(num(p[0], 100), num(p[1], 125), num(p[2], 125)), alpha(a)];
  if (fn === "lch") {
    const C = num(p[1], 150),
      h = rad(num(p[2]));
    return [...fromLab(num(p[0], 100), C * Math.cos(h), C * Math.sin(h)), alpha(a)];
  }
  // color(<space> r g b): sRGB-like spaces are close enough for a color word.
  const [space, ...rest] = p;
  if (!/^(srgb|srgb-linear|display-p3|a98-rgb|rec2020|prophoto-rgb)$/i.test(space ?? "")) return null;
  const [r, g, b] = rest.slice(0, 3).map((x) => num(x, 1));
  const linear = /linear/i.test(space);
  const byte = (v: number) => (linear ? toByte(v) : Math.round(Math.min(1, Math.max(0, v)) * 255));
  return [byte(r), byte(g), byte(b), alpha(a)];
}

export function colorName(css: string | null | undefined): string | null {
  const c = parseColor(css);
  if (!c) return null;
  const [r, g, b, a] = c;
  if ([r, g, b].some((x) => Number.isNaN(x)) || a < 0.1) return null;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min;
  const l = (max + min) / 510;
  const s = d === 0 ? 0 : d / (255 - Math.abs(max + min - 255));
  if (s < 0.2) return l > 0.85 ? null : l < 0.2 ? "black" : "grey";
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 345) return "red";
  if (h < 45) return "orange";
  if (h < 65) return "yellow";
  if (h < 170) return "green";
  if (h < 255) return "blue";
  if (h < 290) return "purple";
  return "pink";
}
