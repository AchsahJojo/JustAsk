import { writeFileSync, mkdirSync } from "node:fs";
import { validateAnimationDocument } from "@clayzo/animation/authoring";
import { orb } from "./orb";

const out = new URL("../src/assets/", import.meta.url);
mkdirSync(out, { recursive: true });
const diag = validateAnimationDocument(orb).diagnostics;
for (const d of diag) console.log(`[${d.severity ?? "info"}] ${d.code}: ${d.message}`);
writeFileSync(new URL("orb.json", out), JSON.stringify(orb));
console.log("wrote src/assets/orb.json");
