// Ported from Mana's colorName.
export function colorName(css: string | null | undefined): string | null {
  const m = css && css.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map((s) => parseFloat(s));
  const [r, g, b] = p;
  const a = p.length > 3 ? p[3] : 1;
  if (a < 0.1) return null;
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
