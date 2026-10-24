// Static fixture server. Main site on :5174, a second origin on :5175 for cross-origin iframes.
// Test-only pages: JustAsk never special-cases any of them.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("./public", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".json": "application/json" };

function serve(port) {
  createServer(async (req, res) => {
    // URL paths always use "/", so normalize them the POSIX way on every OS.
    let path = posix.normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    if (path.endsWith("/")) path += "index.html";
    if (!extname(path)) path += ".html";
    try {
      const body = await readFile(join(ROOT, path));
      res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  }).listen(port, () => console.log(`fixtures on http://localhost:${port}`));
}

serve(Number(process.env.FIXTURES_PORT ?? 5174));
serve(Number(process.env.FIXTURES_PORT2 ?? 5175));
