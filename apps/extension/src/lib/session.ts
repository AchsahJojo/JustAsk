import { browser } from "wxt/browser";
import { SessionController, lines, type SessionView } from "@justask/core";
import type { EventType, FromContent, Recipe } from "@justask/shared";
import { ExtensionBridge } from "./bridge";
import { HttpPlanner } from "./planner";
import { BrowserSpeech } from "./speech";
import { getSettings, type Settings } from "./config";
import { backend } from "./backend";
import { isInjectable } from "../platform";

const FOLLOW_WINDOW_MS = 5000;

/**
 * Hosts the SessionController in the side panel: owns the session tab id, relays
 * content-script events, and watches tabs (plan §3.5).
 */
export class SessionHost {
  readonly controller: SessionController;
  readonly speech: BrowserSpeech;
  readonly bridge: ExtensionBridge;
  private settings: Settings | null = null;
  sessionTabId: number | null = null;
  private lastClickAt = 0;
  private sessionId: string | null = null;
  private pinnedTabId: number | null;
  private recipe: Recipe | null = null;

  constructor(opts: { pinnedTabId?: number | null } = {}) {
    this.pinnedTabId = opts.pinnedTabId ?? null;
    this.speech = new BrowserSpeech();
    this.bridge = new ExtensionBridge(() => this.sessionTabId);
    this.controller = new SessionController({
      bridge: this.bridge,
      planner: new HttpPlanner(() => this.settings?.plannerUrl ?? "http://localhost:8787"),
      speech: this.speech,
      deviceToken: () => this.settings?.deviceToken ?? null,
      store: {
        save: (view, extra) => {
          void browser.storage.session.set({ session: { view, ...extra, tabId: this.sessionTabId } }).catch(() => {});
          if (view.phase === "idle" || view.phase === "done") void browser.storage.local.remove("resume");
          else void browser.storage.local.set({ resume: { request: view.request, taskId: view.taskId, stepNo: view.stepNo } });
        },
      },
      events: { log: (type: EventType, extra) => this.onEvent(type, extra?.latencyMs) },
    });
  }

  async init() {
    this.settings = await getSettings();
    this.speech.rate = this.settings.rate;
    this.speech.muted = false;
    browser.storage.onChanged.addListener(async (changes) => {
      if (!changes.settings) return;
      this.settings = await getSettings();
      this.speech.rate = this.settings.rate;
    });
    browser.runtime.onMessage.addListener((msg: unknown, sender) => {
      const m = msg as FromContent;
      if (!m?.type?.startsWith("ja:") || sender.tab?.id !== this.sessionTabId) return;
      if (m.type === "ja:step-done" || m.type === "ja:clicked") this.lastClickAt = Date.now();
      void this.controller.onContent(m, sender.frameId ?? 0);
    });
    this.watchTabs();
    // Rehydrate after the panel reloads (storage.session survives panel restarts, not browser restarts).
    const saved = (await browser.storage.session.get("session").catch(() => ({}))) as {
      session?: { view: SessionView; history: string[]; recipe: Recipe | null; tabId: number | null };
    };
    const prev = saved.session;
    const live = prev && !["idle", "done", "blocked"].includes(prev.view.phase) && prev.tabId !== null;
    const sameTab = prev && (this.pinnedTabId === null || this.pinnedTabId === prev.tabId);
    if (prev && live && sameTab) {
      this.sessionTabId = prev.tabId;
      this.recipe = prev.recipe;
      this.controller.restore(prev.view, prev.history, prev.recipe);
    }
  }

  private async activeTabId(): Promise<number | null> {
    if (this.pinnedTabId !== null) return this.pinnedTabId;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    return tab?.id ?? null;
  }

  async start(request: string, opts: { recipe?: Recipe | null; taskId?: string | null } = {}) {
    this.sessionTabId = await this.activeTabId();
    const recipe = opts.recipe ?? null;
    this.recipe = recipe;
    // A recipe startUrl opens in the session tab, never a new one, and only from a caregiver recipe.
    if (recipe?.startUrl && this.sessionTabId !== null) {
      const tab = await browser.tabs.get(this.sessionTabId);
      if (!sameUrl(tab.url, recipe.startUrl)) {
        const loaded = waitForLoad(this.sessionTabId);
        await browser.tabs.update(this.sessionTabId, { url: recipe.startUrl });
        await loaded;
      }
    }
    this.sessionId = await backend.startSession(request, opts.taskId ?? null);
    if (opts.taskId) await backend.setTaskStatus(opts.taskId, "active");
    await this.controller.start(request, { recipe, taskId: opts.taskId ?? null, sessionId: this.sessionId });
  }

  /** The recipe of the current session (for the dev snapshot capture). */
  get currentRecipe(): Recipe | null {
    return this.recipe;
  }

  /** "Yes, here": move the session to the tab she is on now. */
  async continueHere() {
    this.sessionTabId = await this.activeTabId();
    await this.controller.resume("She moved to a different tab and wants help there");
  }

  async goBack() {
    if (this.sessionTabId === null) return;
    await browser.tabs.update(this.sessionTabId, { active: true });
    await this.controller.resume();
  }

  async retry() {
    await this.controller.resume();
  }

  private onEvent(type: EventType, latencyMs?: number) {
    if (this.sessionId) void backend.logEvent(this.sessionId, type, latencyMs);
  }

  private watchTabs() {
    const active = () => !["idle", "done", "blocked"].includes(this.controller.state.phase);

    // New tab opened from the session tab shortly after a click: follow it.
    browser.tabs.onCreated.addListener((tab) => {
      if (!active() || tab.openerTabId !== this.sessionTabId || tab.id === undefined) return;
      if (Date.now() - this.lastClickAt > FOLLOW_WINDOW_MS) return;
      this.follow(tab.id);
    });
    browser.webNavigation.onCreatedNavigationTarget.addListener((d) => {
      if (!active() || d.sourceTabId !== this.sessionTabId) return;
      if (Date.now() - this.lastClickAt > FOLLOW_WINDOW_MS) return;
      this.follow(d.tabId);
    });

    browser.tabs.onActivated.addListener(({ tabId }) => {
      if (!active() || this.pinnedTabId !== null) return;
      if (tabId === this.sessionTabId) {
        if (this.controller.state.phase === "paused" && this.controller.state.pauseReason === "other-tab") void this.controller.resume();
        return;
      }
      if (this.followingTo === tabId) return;
      this.controller.pause("other-tab");
    });

    browser.tabs.onRemoved.addListener((tabId) => {
      if (!active() || tabId !== this.sessionTabId) return;
      this.controller.pause("tab-closed");
    });

    browser.tabs.onUpdated.addListener((tabId, info, tab) => {
      if (tabId !== this.sessionTabId || !active()) return;
      if (info.status === "complete") {
        if (!isInjectable(tab.url)) {
          this.controller.pause("cant-see");
          return;
        }
        if (this.controller.state.phase === "paused" && this.controller.state.pauseReason === "cant-see") {
          void this.controller.resume("She went back to a page I can see");
          return;
        }
        // Full navigation while guiding (the content script and overlay are gone).
        if (this.controller.state.phase === "guiding") void this.controller.navigated();
        else if (this.controller.state.phase === "waiting") void this.controller.navigated();
      }
    });
  }

  private followingTo: number | null = null;
  private follow(tabId: number) {
    if (this.followingTo === tabId) return;
    this.followingTo = tabId;
    this.sessionTabId = tabId;
    setTimeout(() => (this.followingTo = null), 3000);
    void this.controller.followedNewTab();
  }

  speak(text: string) {
    this.speech.speak(text);
  }
}

function sameUrl(a: string | undefined, b: string): boolean {
  try {
    const x = new URL(a ?? "");
    const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search;
  } catch {
    return false;
  }
}

/** Resolves when the tab next finishes loading (or after `ms`). Subscribe before navigating. */
function waitForLoad(tabId: number, ms = 10_000): Promise<void> {
  return new Promise((resolve) => {
    let started = false;
    const done = () => {
      browser.tabs.onUpdated.removeListener(on);
      clearTimeout(timer);
      resolve();
    };
    const on = (id: number, info: { status?: string }) => {
      if (id !== tabId) return;
      if (info.status === "loading") started = true;
      if (started && info.status === "complete") done();
    };
    const timer = setTimeout(done, ms);
    browser.tabs.onUpdated.addListener(on);
  });
}

export { lines };
