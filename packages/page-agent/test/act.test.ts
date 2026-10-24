// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActSpec, FromContent } from "@justask/shared";
import { PageAgent } from "../src/agent";
import { fakeLayout } from "./setup-dom";

beforeEach(() => {
  fakeLayout();
  document.body.innerHTML = "";
});
afterEach(() => vi.restoreAllMocks());

const nativeValue = (el: HTMLInputElement | HTMLTextAreaElement) =>
  Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.get!.call(el);

function setup(html: string) {
  document.body.innerHTML = html;
  const sent: FromContent[] = [];
  const agent = new PageAgent({ frameId: 0, isTop: true, send: (m) => sent.push(m) });
  const scan = agent.scan([]);
  const n = (t: string) => scan.snapshot.elements.find((e) => e.text === t || e.label === t)!.n;
  const act = (t: string, expect: ActSpec["expect"], extra: Partial<ActSpec> = {}) =>
    agent.act({ localId: n(t), expect, text: null, option: null, ...extra });
  return { agent, sent, scan, n, act };
}

function record(el: Element, types: string[]) {
  const log: Event[] = [];
  for (const t of types) el.addEventListener(t, (e) => log.push(e));
  return log;
}

describe("act: click", () => {
  it("focuses then clicks", () => {
    const { agent, act } = setup(`<main><button id="b">Add to cart</button></main>`);
    const b = document.getElementById("b")!;
    const log = record(b, ["focus", "click"]);
    expect(act("Add to cart", "click")).toEqual({ ok: true });
    expect(log.map((e) => e.type)).toEqual(["focus", "click"]);
    expect(document.activeElement).toBe(b);
    agent.destroy();
  });

  it("returns ok:false for an unknown number", () => {
    const { agent } = setup(`<button>X</button>`);
    expect(agent.act({ localId: 99, expect: "click", text: null, option: null })).toEqual({ ok: false });
    agent.destroy();
  });
});

describe("act: type", () => {
  it("sets the value through the native setter (bypassing a React-style override) and fires input then change", () => {
    const { agent, act } = setup(`<form role="search"><input id="q" name="q" placeholder="Search products"></form>`);
    const q = document.getElementById("q") as HTMLInputElement;
    const log = record(q, ["input", "change"]);
    // React tracks `value` with an instance property; act must go through the prototype setter.
    // (happy-dom's own setter reads `value` internally, so reads are delegated, not forbidden.)
    Object.defineProperty(q, "value", {
      configurable: true,
      get() { return nativeValue(q); },
      set() { throw new Error("instance setter used"); },
    });
    expect(act("Search products", "type", { text: "water bottle" })).toEqual({ ok: true });
    expect(nativeValue(q)).toBe("water bottle");
    expect(log.map((e) => e.type)).toEqual(["input", "change"]);
    expect(log[0]).toBeInstanceOf(InputEvent);
    expect((log[0] as InputEvent).bubbles).toBe(true);
    agent.destroy();
  });

  it("types into a textarea", () => {
    const { agent, act } = setup(`<label for="t">Message</label><textarea id="t"></textarea>`);
    const t = document.getElementById("t") as HTMLTextAreaElement;
    expect(act("Message", "type", { text: "Happy birthday" })).toEqual({ ok: true });
    expect(nativeValue(t)).toBe("Happy birthday");
    agent.destroy();
  });

  it("types into a contenteditable (insertText, or textContent fallback) and fires input", () => {
    const { agent, act } = setup(`<div id="ce" contenteditable="true" aria-label="What's on your mind?"></div>`);
    const ce = document.getElementById("ce")!;
    const log = record(ce, ["input"]);
    expect(act("What's on your mind?", "type", { text: "Hello all" })).toEqual({ ok: true });
    expect(ce.textContent).toBe("Hello all");
    expect(log.length).toBeGreaterThan(0);
    agent.destroy();
  });

  it("uses execCommand insertText when the engine supports it", () => {
    const { agent, act } = setup(`<div id="ce" contenteditable="true" aria-label="Note"></div>`);
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    try {
      expect(act("Note", "type", { text: "hi" })).toEqual({ ok: true });
      expect(exec).toHaveBeenCalledWith("insertText", false, "hi");
    } finally {
      delete (document as unknown as { execCommand?: unknown }).execCommand;
    }
    agent.destroy();
  });

  it("refuses non-text targets and missing text", () => {
    const { agent, act } = setup(`<label><input type="checkbox"> Agree</label><input aria-label="Name">`);
    expect(act("Agree", "type", { text: "x" })).toEqual({ ok: false });
    expect(act("Name", "type")).toEqual({ ok: false });
    agent.destroy();
  });
});

describe("act: choose", () => {
  it("selects the option by label and fires input then change", () => {
    const { agent, act } = setup(`<label for="s">State</label><select id="s"><option value="">Choose…</option><option value="az">Arizona</option><option value="tx">Texas</option></select>`);
    const s = document.getElementById("s") as HTMLSelectElement;
    const log = record(s, ["input", "change"]);
    expect(act("State", "choose", { option: "texas" })).toEqual({ ok: true });
    expect(s.selectedIndex).toBe(2);
    expect(log.map((e) => e.type)).toEqual(["input", "change"]);
    expect(act("State", "choose", { option: "Ohio" })).toEqual({ ok: false });
    expect(s.selectedIndex).toBe(2);
    agent.destroy();
  });
});

describe("act: submit", () => {
  it("requestSubmit when inside a form", () => {
    const { agent, act } = setup(`<form id="f"><label for="q">Search</label><input id="q"><button>Go</button></form>`);
    const f = document.getElementById("f") as HTMLFormElement;
    const submits: Event[] = [];
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      submits.push(e);
    });
    expect(act("Search", "submit")).toEqual({ ok: true });
    expect(submits.length).toBe(1);
    agent.destroy();
  });

  it("presses Enter when not in a form", () => {
    const { agent, act } = setup(`<input id="q" aria-label="Find">`);
    const q = document.getElementById("q")!;
    const log = record(q, ["keydown", "keypress", "keyup"]);
    expect(act("Find", "submit")).toEqual({ ok: true });
    expect(log.map((e) => `${e.type}:${(e as KeyboardEvent).key}`)).toEqual(["keydown:Enter", "keypress:Enter", "keyup:Enter"]);
    agent.destroy();
  });
});

describe("act: scroll", () => {
  it("scrolls the element to the center", () => {
    const { agent, act } = setup(`<main><button id="b">Far away</button></main>`);
    const spy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    expect(act("Far away", "scroll")).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ block: "center" }));
    agent.destroy();
  });
});

describe("act: sensitive fields", () => {
  it("refuses type/choose/submit on sensitive fields but allows click", () => {
    const { agent, act } = setup(`
      <form><label for="pw">Password</label><input id="pw" type="password">
      <label for="cc">Card number</label><input id="cc" autocomplete="cc-number">
      <label for="m">Expiry month</label><select id="m" autocomplete="cc-exp-month"><option>01</option><option>02</option></select></form>`);
    const pw = document.getElementById("pw") as HTMLInputElement;
    const cc = document.getElementById("cc") as HTMLInputElement;
    expect(act("Password", "type", { text: "hunter2" })).toEqual({ ok: false });
    expect(act("Card number", "type", { text: "4111111111111111" })).toEqual({ ok: false });
    expect(act("Expiry month", "choose", { option: "02" })).toEqual({ ok: false });
    expect(act("Password", "submit")).toEqual({ ok: false });
    expect(nativeValue(pw)).toBe("");
    expect(nativeValue(cc)).toBe("");
    expect((document.getElementById("m") as HTMLSelectElement).selectedIndex).toBe(0);
    expect(act("Password", "click")).toEqual({ ok: true });
    agent.destroy();
  });
});

describe("act while highlighted", () => {
  it("our own events never report step-done, wrong or lost", async () => {
    vi.useFakeTimers();
    const { agent, sent, n } = setup(`<main><div id="row"><button onclick="this.parentElement.innerHTML='<p>Added to cart</p>'">Add to cart</button></div></main>`);
    agent.highlight({ localId: n("Add to cart"), expect: "click", option: null, label: "Click here" });
    expect(agent.act({ localId: n("Add to cart"), expect: "click", text: null, option: null })).toEqual({ ok: true });
    vi.advanceTimersByTime(600);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([]);
    agent.destroy();
  });

  it("a refused act leaves the highlight live for guide mode", () => {
    const { agent, sent, n } = setup(`<label for="pw">Password</label><input id="pw" type="password">`);
    agent.highlight({ localId: n("Password"), expect: "type", option: null, label: "Type here" });
    expect(agent.act({ localId: n("Password"), expect: "type", text: "x", option: null })).toEqual({ ok: false });
    const pw = document.getElementById("pw") as HTMLInputElement;
    pw.value = "secret";
    pw.dispatchEvent(new Event("change", { bubbles: true }));
    expect(sent.at(-1)).toEqual({ type: "ja:step-done", how: "typed" });
    agent.destroy();
  });
});
