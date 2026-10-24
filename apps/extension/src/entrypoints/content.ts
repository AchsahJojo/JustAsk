import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { PageAgent } from "@justask/page-agent";
import type { FromContent, ScanReply, ToContent } from "@justask/shared";
import { shadowRootGetter } from "../platform";

// Injected on demand with scripting.executeScript into every frame of the session tab.
// Stateless across navigations: the panel owns the session.
export default defineContentScript({
  registration: "runtime",
  matches: ["<all_urls>"],
  allFrames: true,
  main() {
    const w = window as unknown as { __justask?: boolean };
    if (w.__justask) return;
    w.__justask = true;

    const send = (msg: FromContent) => {
      browser.runtime.sendMessage(msg).catch(() => {});
    };
    const agent = new PageAgent({ frameId: -1, isTop: window === window.top, send, getShadowRoot: shadowRootGetter() });

    browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse: (r: unknown) => void) => {
      const msg = raw as ToContent;
      switch (msg?.type) {
        case "ja:ping":
          sendResponse(true);
          return;
        case "ja:scan": {
          const reply: ScanReply = { ok: true, scan: agent.scan(msg.context) };
          sendResponse(reply);
          return;
        }
        case "ja:highlight":
          sendResponse(agent.highlight(msg.spec));
          return;
        case "ja:clear":
          agent.clear();
          sendResponse(true);
          return;
        case "ja:pulse":
          agent.pulse();
          sendResponse(true);
          return;
        case "ja:banner":
          if (window === window.top) agent.banner(msg.text);
          sendResponse(true);
          return;
        case "ja:wait-change":
          agent.waitForChange(msg.timeoutMs).then(sendResponse);
          return true; // async response
      }
    });
  },
});
