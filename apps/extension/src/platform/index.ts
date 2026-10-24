// All browser-specific calls live under src/platform (plan §1). Feature detection, not sniffing.
import { browser } from "wxt/browser";

export type PanelKind = "sidePanel" | "sidebar" | "dock";

export function panelKind(): PanelKind {
  const b = browser as unknown as { sidePanel?: unknown; sidebarAction?: unknown };
  if (b.sidePanel) return "sidePanel";
  if (b.sidebarAction) return "sidebar";
  return "dock";
}

/** Closed shadow roots: chrome.dom on Chromium, element.openOrClosedShadowRoot on Firefox, none on Safari. */
export function shadowRootGetter(): ((el: Element) => ShadowRoot | null) | undefined {
  const chromeDom = (globalThis as unknown as { chrome?: { dom?: { openOrClosedShadowRoot?: (el: Element) => ShadowRoot | null } } }).chrome?.dom;
  if (chromeDom?.openOrClosedShadowRoot) {
    return (el) => {
      try {
        return chromeDom.openOrClosedShadowRoot!(el) ?? null;
      } catch {
        return null;
      }
    };
  }
  if (typeof Element !== "undefined" && "openOrClosedShadowRoot" in Element.prototype) {
    return (el) => (el as unknown as { openOrClosedShadowRoot: ShadowRoot | null }).openOrClosedShadowRoot ?? null;
  }
  return undefined;
}

/** Open the panel. Must run inside a user gesture on Chrome/Firefox. */
export async function openPanel(opts: { windowId?: number; tabId?: number }): Promise<boolean> {
  const b = browser as unknown as {
    sidePanel?: { open(o: { windowId?: number; tabId?: number }): Promise<void> };
    sidebarAction?: { open(): Promise<void> };
  };
  try {
    if (b.sidePanel) {
      await b.sidePanel.open(opts.tabId !== undefined ? { tabId: opts.tabId } : { windowId: opts.windowId });
      return true;
    }
    if (b.sidebarAction) {
      await b.sidebarAction.open();
      return true;
    }
  } catch {
    /* gesture didn't carry over */
  }
  return false;
}

/** Toolbar icon always opens the panel without our code (fallback ladder step 1). */
export function setPanelOnActionClick() {
  const b = browser as unknown as { sidePanel?: { setPanelBehavior(o: { openPanelOnActionClick: boolean }): Promise<void> } };
  b.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

/** Pages content scripts can't run in (plan §3.5). */
export function isInjectable(url: string | undefined): boolean {
  if (!url) return false;
  if (!/^(https?|file):/.test(url)) return false;
  if (/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons|addons\.mozilla\.org)/.test(url)) return false;
  if (url.startsWith("file:")) return false;
  if (/\.pdf($|\?)/i.test(url)) return false;
  return true;
}

/** An empty tab: the browser's New Tab page or about:blank. Nothing to help with yet, so JustAsk searches. */
export function isBlankTab(url: string | undefined): boolean {
  if (!url) return true;
  return /^(about:(blank|newtab|home)|chrome:\/\/(newtab|new-tab-page)\/?|chrome-search:\/\/local-ntp|edge:\/\/newtab\/?|brave:\/\/newtab\/?|vivaldi:\/\/newtab\/?)/i.test(url);
}

/**
 * Search `text` in this tab with her own default search engine (chrome.search / browser.search).
 * No search site is built in. False when the browser has no search API.
 */
export async function searchInTab(tabId: number, text: string): Promise<boolean> {
  const b = browser as unknown as {
    search?: {
      query?: (o: { text: string; tabId: number }) => Promise<void>;
      search?: (o: { query: string; tabId: number }) => Promise<void>;
    };
  };
  try {
    if (b.search?.query) await b.search.query({ text, tabId });
    else if (b.search?.search) await b.search.search({ query: text, tabId });
    else return false;
    return true;
  } catch {
    return false;
  }
}
