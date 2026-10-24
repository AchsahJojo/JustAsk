// @vitest-environment happy-dom
// Guide-only: JustAsk highlights the next element; she does every action herself.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listener: null as null | ((raw: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown),
  sentToTab: [] as unknown[],
  agentAct: vi.fn(() => ({ ok: true })),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      sendMessage: vi.fn(async () => {}),
      onMessage: {
        addListener: (fn: typeof mocks.listener) => {
          mocks.listener = fn;
        },
      },
    },
    tabs: {
      sendMessage: vi.fn(async (_tabId: number, msg: unknown) => {
        mocks.sentToTab.push(msg);
        return { ok: true };
      }),
    },
  },
}));

vi.mock("wxt/utils/define-content-script", () => ({ defineContentScript: (def: unknown) => def }));

vi.mock("@justask/page-agent", () => ({
  PageAgent: class {
    act = mocks.agentAct;
    scan() {
      return {};
    }
    highlight() {
      return true;
    }
    clear() {}
    pulse() {}
    watch() {}
    banner() {}
    waitForChange() {
      return Promise.resolve(false);
    }
  },
}));

vi.mock("../src/platform", () => ({ shadowRootGetter: () => undefined, isInjectable: () => true }));

import { ExtensionBridge } from "../src/lib/bridge";
import content from "../src/entrypoints/content";
import { doneLine } from "../src/ui/doneLine";

beforeEach(() => {
  mocks.sentToTab.length = 0;
  mocks.agentAct.mockClear();
});

describe("ExtensionBridge (guide-only)", () => {
  it("has no act method", () => {
    const bridge = new ExtensionBridge(() => 1);
    expect((bridge as unknown as { act?: unknown }).act).toBeUndefined();
    expect("act" in bridge).toBe(false);
  });
});

describe("content script (guide-only)", () => {
  it("ignores a ja:act message: nothing runs and no reply is sent", () => {
    (content as unknown as { main: () => void }).main();
    expect(mocks.listener).not.toBeNull();
    const sendResponse = vi.fn();
    const ret = mocks.listener!({ type: "ja:act", spec: { localId: 1, expect: "click", text: null, option: null } }, {}, sendResponse);
    expect(ret).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
    expect(mocks.agentAct).not.toHaveBeenCalled();
  });

  it("still answers ja:highlight", () => {
    const sendResponse = vi.fn();
    mocks.listener!({ type: "ja:highlight", spec: { localId: 1, expect: "click", option: null, label: "Click here" } }, {}, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith(true);
  });
});

describe("done line", () => {
  it("credits her clicks only", () => {
    expect(doneLine(1)).toBe("You made 1 click yourself.");
    expect(doneLine(4)).toBe("You made 4 clicks yourself.");
    expect(doneLine(0)).toBe("You made 0 clicks yourself.");
  });
});
