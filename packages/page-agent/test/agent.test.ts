// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PageAgent } from "../src/agent";
import { fakeLayout } from "./setup-dom";
import type { FromContent } from "@justask/shared";

beforeEach(() => {
  fakeLayout();
  document.body.innerHTML = "";
});

function setup(html: string) {
  document.body.innerHTML = html;
  const sent: FromContent[] = [];
  const agent = new PageAgent({ frameId: 0, isTop: true, send: (m) => sent.push(m) });
  const scan = agent.scan([]);
  const n = (text: string) => scan.snapshot.elements.find((e) => e.text === text || e.label === text)!.n;
  return { agent, sent, scan, n };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe("fingerprint resolve (rerenders)", () => {
  it("rebinds silently when the node is replaced by an identical one", () => {
    const { agent, n } = setup(`<main><h2>Lisinopril</h2><div id="row"><button>Refill</button></div></main>`);
    const id = n("Refill");
    document.getElementById("row")!.innerHTML = `<button>Refill</button>`;
    const el = agent.resolve(id);
    expect(el).not.toBeNull();
    expect(el!.isConnected).toBe(true);
  });

  it("returns null when ambiguous (two identical candidates)", () => {
    const { agent, n } = setup(`<main><div id="row"><button>Refill</button></div></main>`);
    const id = n("Refill");
    document.getElementById("row")!.innerHTML = `<div><button>Refill</button></div><div><button>Refill</button></div>`;
    expect(agent.resolve(id)).toBeNull();
  });

  it("returns null when gone", () => {
    const { agent, n } = setup(`<main><div id="row"><button>Refill</button></div></main>`);
    const id = n("Refill");
    document.getElementById("row")!.innerHTML = ``;
    expect(agent.resolve(id)).toBeNull();
  });
});

describe("click observation", () => {
  it("target click advances; a click elsewhere reports wrong", async () => {
    const { agent, sent, n } = setup(`<main><button id="a">Refill</button><button id="b">Other</button></main>`);
    expect(agent.highlight({ localId: n("Refill"), expect: "click", option: null, label: "Click here" })).toBe(true);
    document.getElementById("b")!.click();
    expect(sent).toEqual([{ type: "ja:wrong", what: "click" }]);
    document.getElementById("a")!.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    expect(sent.at(-1)).toEqual({ type: "ja:step-done", how: "click" });
    agent.destroy();
  });

  it("a click on an icon inside the target counts", () => {
    const { agent, sent, n } = setup(`<main><button>Refill <span id="icon">→</span></button></main>`);
    agent.highlight({ localId: n("Refill →"), expect: "click", option: null, label: "Click here" });
    document.getElementById("icon")!.click();
    expect(sent.at(-1)).toEqual({ type: "ja:step-done", how: "click" });
    agent.destroy();
  });
});

describe("typing (hasValue state machine)", () => {
  it("advances on change only once the field has a value; wrong box is reported", () => {
    const { agent, sent, n } = setup(`<form><label for="e">Email</label><input id="e" type="email"><label for="o">Other</label><input id="o"></form>`);
    agent.highlight({ localId: n("Email"), expect: "type", option: null, label: "Type here" });
    const e = document.getElementById("e") as HTMLInputElement;
    const o = document.getElementById("o") as HTMLInputElement;
    o.value = "x";
    o.dispatchEvent(new Event("input", { bubbles: true }));
    expect(sent).toEqual([{ type: "ja:wrong", what: "typing" }]);
    e.dispatchEvent(new Event("change", { bubbles: true })); // empty: no advance
    expect(sent.length).toBe(1);
    e.value = "a@b.co";
    e.dispatchEvent(new Event("change", { bubbles: true }));
    expect(sent.at(-1)).toEqual({ type: "ja:step-done", how: "typed" });
    agent.destroy();
  });

  it("Enter advances when the field has a value", () => {
    const { agent, sent, n } = setup(`<input id="q" aria-label="Search">`);
    agent.highlight({ localId: n("Search"), expect: "type", option: null, label: "Type here" });
    const q = document.getElementById("q") as HTMLInputElement;
    q.value = "flu shot";
    q.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sent.at(-1)).toEqual({ type: "ja:step-done", how: "typed" });
    agent.destroy();
  });
});

describe("select matched logic", () => {
  it("matches the option label case-insensitively and reports a mismatch without sending the value", () => {
    const { agent, sent, n } = setup(`<label for="s">State</label><select id="s"><option value="">Choose…</option><option value="az">Arizona</option><option value="tx">Texas</option></select>`);
    agent.highlight({ localId: n("State"), expect: "choose", option: "arizona", label: "Pick here" });
    const s = document.getElementById("s") as HTMLSelectElement;
    s.value = "tx";
    s.dispatchEvent(new Event("change", { bubbles: true }));
    expect(sent.at(-1)).toEqual({ type: "ja:wrong", what: "choice" });
    s.value = "az";
    s.dispatchEvent(new Event("change", { bubbles: true }));
    expect(sent.at(-1)).toEqual({ type: "ja:step-done", how: "chose" });
    expect(JSON.stringify(sent)).not.toMatch(/tx|az|Texas/);
    agent.destroy();
  });

  it("matches a full option label longer than 60 characters", () => {
    const label = `North Phoenix pharmacy (${"near the community center ".repeat(4)})`;
    const { agent, sent, n, scan } = setup(`<label for="s">Pharmacy</label><select id="s"><option value="">Choose…</option><option>${label}</option></select>`);
    expect(scan.snapshot.elements.find((e) => e.label === "Pharmacy")?.field?.options?.[1]).toBe(label);
    agent.highlight({ localId: n("Pharmacy"), expect: "choose", option: label, label: "Pick here" });
    const s = document.getElementById("s") as HTMLSelectElement;
    s.selectedIndex = 1;
    s.dispatchEvent(new Event("change", { bubbles: true }));
    expect(sent.at(-1)).toEqual({ type: "ja:step-done", how: "chose" });
    expect(JSON.stringify(sent)).not.toContain(label);
    agent.destroy();
  });
});

describe("hover dwell", () => {
  it("cancels when the pointer leaves before the dwell finishes", () => {
    vi.useFakeTimers();
    const { agent, sent, n } = setup(`<main><button id="target"><span>Help</span></button><button id="other">Other</button></main>`);
    const target = document.getElementById("target")!;
    const span = target.querySelector("span")!;
    agent.highlight({ localId: n("Help"), expect: "hover", option: null, label: "Hover here" });
    span.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
    vi.advanceTimersByTime(250);
    span.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.getElementById("other") }));
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([]);

    target.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
    vi.advanceTimersByTime(300);
    expect(sent).toEqual([{ type: "ja:step-done", how: "hovered" }]);
    vi.useRealTimers();
    agent.destroy();
  });
});

describe("lost target", () => {
  it("reports ja:lost when the target disappears with no match", async () => {
    vi.useFakeTimers();
    const { agent, sent, n } = setup(`<main><div id="row"><button>Refill</button></div></main>`);
    agent.highlight({ localId: n("Refill"), expect: "click", option: null, label: "Click here" });
    document.getElementById("row")!.innerHTML = "";
    vi.advanceTimersByTime(300);
    vi.useRealTimers();
    await flush();
    expect(sent.at(-1)).toEqual({ type: "ja:lost" });
    agent.destroy();
  });
});

describe("the ring never jumps to the corner when a site swaps the element", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const ringOf = () => document.querySelector("justask-overlay")?.getAttribute("data-ring") ?? null;

  it("hides while the target is collapsed, then follows its replacement", async () => {
    const { agent, n } = setup(`<main><div id="slot"><div role="textbox" contenteditable="true" aria-label="Message Body" data-rect="40,300,600,200"></div></div></main>`);
    expect(agent.highlight({ localId: n("Message Body"), expect: "type", option: null, label: "Type here" })).toBe(true);
    await sleep(60);
    expect(ringOf()).toBe("40,300,600,200");
    // The site hides the old editor (still in the page) and adds a new one, like a compose box on focus.
    const slot = document.getElementById("slot")!;
    (slot.firstElementChild as HTMLElement).style.display = "none";
    slot.insertAdjacentHTML("beforeend", `<div role="textbox" contenteditable="true" aria-label="Message Body" data-rect="40,320,600,200"></div>`);
    await sleep(80);
    expect(ringOf()).toBeNull(); // hidden, never drawn at 0,0
    await sleep(500);
    expect(ringOf()).toBe("40,320,600,200");
    agent.destroy();
  });

  it("when nothing replaces it, says lost so JustAsk looks again", async () => {
    const { agent, n, sent } = setup(`<main><div role="textbox" contenteditable="true" aria-label="Message Body" data-rect="40,300,600,200"></div></main>`);
    agent.highlight({ localId: n("Message Body"), expect: "type", option: null, label: "Type here" });
    await sleep(60);
    (document.querySelector("[role=textbox]") as HTMLElement).style.display = "none";
    await sleep(600);
    expect(sent.some((m) => m.type === "ja:lost")).toBe(true);
    expect(ringOf()).toBeNull();
    agent.destroy();
  });
});
