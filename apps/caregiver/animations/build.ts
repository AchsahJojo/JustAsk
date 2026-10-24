import { writeFileSync, mkdirSync } from "node:fs";
import { validateAnimationDocument } from "@clayzo/animation/authoring";
import { link } from "./link";
// The brand orb is authored once, in the extension.
import { orb } from "../../extension/animations/orb";

const out = new URL("../src/assets/", import.meta.url);
mkdirSync(out, { recursive: true });
for (const [name, doc] of Object.entries({ link, orb })) {
  for (const d of validateAnimationDocument(doc).diagnostics) console.log(`[${name}] [${d.severity ?? "info"}] ${d.code}: ${d.message}`);
  writeFileSync(new URL(`${name}.json`, out), JSON.stringify(doc));
  console.log(`wrote src/assets/${name}.json`);
}
