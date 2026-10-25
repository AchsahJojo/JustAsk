// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import type { FromContent } from "@justask/shared";
import { PageAgent, WATCH_QUIET_MS } from "../src/agent";
import { fakeLayout } from "./setup-dom";

beforeEach(() => {
  fakeLayout();
  document.body.innerHTML = `<main><button>Start a post</button><div id="slot"></div></main>`;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const changes = (sent: FromContent[]) => sent.filter((m) => m.type === "ja:page-changed");

describe("watch (P1)", () => {
  it("sends page-changed once per settle, and nothing once off", async () => {
    const sent: FromContent[] = [];
    const agent = new PageAgent({ frameId: 0, isTop: true, send: (m) => sent.push(m) });
    agent.watch(true);
    const slot = document.getElementById("slot")!;
    slot.textContent = "Loading…";
    await sleep(200);
    slot.innerHTML = `<div contenteditable="true" aria-label="What's on your mind?"></div>`;
    await sleep(200);
    expect(changes(sent)).toEqual([]); // still settling
    await sleep(WATCH_QUIET_MS + 150);
    expect(changes(sent)).toEqual([{ type: "ja:page-changed", reason: "mutation" }]);

    await sleep(WATCH_QUIET_MS + 150); // quiet: no repeat
    expect(changes(sent).length).toBe(1);

    agent.watch(false);
    slot.innerHTML = `<button>Post</button>`;
    await sleep(WATCH_QUIET_MS + 150);
    expect(changes(sent).length).toBe(1);
    agent.destroy();
  });

  it("turning off mid-settle cancels the pending report; destroy cleans up", async () => {
    const sent: FromContent[] = [];
    const agent = new PageAgent({ frameId: 0, isTop: true, send: (m) => sent.push(m) });
    agent.watch(true);
    document.getElementById("slot")!.textContent = "x";
    await sleep(100);
    agent.watch(false);
    await sleep(WATCH_QUIET_MS + 100);
    expect(changes(sent)).toEqual([]);

    agent.watch(true);
    document.getElementById("slot")!.textContent = "y";
    await sleep(100);
    agent.destroy();
    document.getElementById("slot")!.textContent = "z";
    await sleep(WATCH_QUIET_MS + 100);
    expect(changes(sent)).toEqual([]);
  });

  it("our own overlay does not count as a page change", async () => {
    const sent: FromContent[] = [];
    const agent = new PageAgent({ frameId: 0, isTop: true, send: (m) => sent.push(m) });
    const scan = agent.scan([]);
    agent.watch(true);
    agent.highlight({ localId: scan.snapshot.elements[0].n, expect: "click", option: null, label: "Click here" });
    await sleep(WATCH_QUIET_MS + 150);
    expect(changes(sent)).toEqual([]);
    agent.destroy();
  });
});

describe("settle (wait for a page to finish before reading it)", () => {
  it("waits while results are still streaming in, then resolves after the page is quiet", async () => {
    const agent = new PageAgent({ frameId: 0, isTop: true, send: () => {} });
    const slot = document.getElementById("slot")!;
    let settledAt = 0;
    const t0 = Date.now();
    const p = agent.settle(300, 3000).then(() => (settledAt = Date.now() - t0));
    for (let i = 0; i < 4; i++) {
      await sleep(150);
      slot.insertAdjacentHTML("beforeend", `<p>Result ${i}</p>`);
    }
    await p;
    expect(settledAt).toBeGreaterThanOrEqual(600 + 300 - 50); // after the last result, plus the quiet time
    agent.destroy();
  });

  it("keeps waiting while something is marked aria-busy, up to the maximum", async () => {
    document.body.insertAdjacentHTML("beforeend", `<div aria-busy="true">Loading results…</div>`);
    const agent = new PageAgent({ frameId: 0, isTop: true, send: () => {} });
    const t0 = Date.now();
    await agent.settle(100, 700);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(650);
    agent.destroy();
  });

  it("is quick when the page has been quiet", async () => {
    const agent = new PageAgent({ frameId: 0, isTop: true, send: () => {} });
    await sleep(250);
    const t0 = Date.now();
    await agent.settle(200, 3000);
    expect(Date.now() - t0).toBeLessThan(150);
    agent.destroy();
  });
});
