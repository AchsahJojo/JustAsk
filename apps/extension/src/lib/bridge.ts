import { browser } from "wxt/browser";
import type { PageBridge, TargetRef } from "@justask/core";
import type { FrameScan, HighlightSpec, ScanReply, ToContent } from "@justask/shared";
import { isInjectable } from "../platform";

const CONTENT_FILE = "/content-scripts/content.js";

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      () => (clearTimeout(t), resolve(fallback)),
    );
  });
}

/**
 * PageBridge over chrome.scripting + tabs messaging. Every frame of the session tab runs
 * its own content script; the controller merges their reports (plan §3.3).
 */
export class ExtensionBridge implements PageBridge {
  constructor(public tabId: () => number | null) {}

  private async tab() {
    const id = this.tabId();
    if (id === null) return null;
    try {
      return await browser.tabs.get(id);
    } catch {
      return null;
    }
  }

  /** Wait (up to `ms`) for the tab to finish loading. */
  private async settled(ms = 5000) {
    const start = Date.now();
    for (;;) {
      const t = await this.tab();
      if (!t || t.status === "complete" || Date.now() - start > ms) return t;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async ensureInjected(): Promise<boolean> {
    const t = await this.settled();
    if (!t || !isInjectable(t.url)) return false;
    try {
      await browser.scripting.executeScript({ target: { tabId: t.id!, allFrames: true }, files: [CONTENT_FILE] });
      return true;
    } catch {
      // Some subframes may refuse; the top frame is what matters.
      try {
        await browser.scripting.executeScript({ target: { tabId: t.id! }, files: [CONTENT_FILE] });
        return true;
      } catch {
        return false;
      }
    }
  }

  private send<T>(msg: ToContent, frameId: number, ms = 1500, fallback: T): Promise<T> {
    const tabId = this.tabId();
    if (tabId === null) return Promise.resolve(fallback);
    return withTimeout(browser.tabs.sendMessage(tabId, msg, { frameId }) as Promise<T>, ms, fallback);
  }

  private async frames(): Promise<Array<{ frameId: number; url: string }>> {
    const tabId = this.tabId();
    if (tabId === null) return [];
    try {
      const all = (await browser.webNavigation.getAllFrames({ tabId })) ?? [];
      return all.filter((f) => isInjectable(f.url) || f.url === "about:blank").map((f) => ({ frameId: f.frameId, url: f.url }));
    } catch {
      return [{ frameId: 0, url: "" }];
    }
  }

  async scan(context: string[]): Promise<FrameScan[]> {
    if (!(await this.ensureInjected())) return [];
    const frames = await this.frames();
    const replies = await Promise.all(
      frames.map(async (f) => {
        const r = await this.send<ScanReply>({ type: "ja:scan", context }, f.frameId, 1500, { ok: false });
        return r.ok && r.scan ? { ...r.scan, frameId: f.frameId, isTop: f.frameId === 0 } : null;
      }),
    );
    const scans = replies.filter((x): x is FrameScan => !!x);
    // Skip tiny/hidden frames: a child frame with nothing interactive adds nothing.
    return scans.filter((s) => s.isTop || s.snapshot.elements.length > 0);
  }

  async highlight(ref: TargetRef, spec: HighlightSpec): Promise<boolean> {
    return this.send<boolean>({ type: "ja:highlight", spec }, ref.frameId, 2000, false);
  }

  async clear(): Promise<void> {
    const frames = await this.frames();
    await Promise.all(frames.map((f) => this.send({ type: "ja:clear" }, f.frameId, 500, null)));
  }

  async pulse(ref: TargetRef): Promise<void> {
    await this.send({ type: "ja:pulse" }, ref.frameId, 500, null);
  }

  async banner(text: string): Promise<boolean> {
    if (!(await this.ensureInjected())) return false;
    return this.send<boolean>({ type: "ja:banner", text }, 0, 1000, false);
  }

  /** Navigation (tab starts loading) or a settled DOM change in the top frame. */
  waitForChange(timeoutMs: number): Promise<boolean> {
    const tabId = this.tabId();
    if (tabId === null) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: boolean) => {
        if (done) return;
        done = true;
        browser.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        resolve(v);
      };
      let navigating = false;
      const onUpdated = (id: number, info: { status?: string; url?: string }) => {
        if (id !== tabId) return;
        if (info.status === "loading" || info.url) navigating = true;
        if (navigating && info.status === "complete") finish(true);
      };
      browser.tabs.onUpdated.addListener(onUpdated);
      const timer = setTimeout(() => finish(navigating), timeoutMs + 4000);
      this.send<boolean>({ type: "ja:wait-change", timeoutMs }, 0, timeoutMs + 500, false).then((changed) => {
        // A navigation tears down the content script (the reply fails); give onUpdated a moment to report it.
        setTimeout(() => {
          if (!navigating) finish(changed);
          // If navigating, wait for status complete (or the outer timer).
        }, changed ? 0 : 400);
      });
    });
  }
}
