import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { openPanel, setPanelOnActionClick } from "../platform";
import { backend } from "../lib/backend";
import { getSettings } from "../lib/config";

const CONTENT_FILE = "/content-scripts/content.js";

// The background only does notifications, badge and permission plumbing
// (it is killed when idle, so it polls on alarms instead of holding a socket).
export default defineBackground(() => {
  setPanelOnActionClick();

  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason === "install") {
      const s = await getSettings();
      if (!s.setupDone && !__JUSTASK_E2E__) browser.tabs.create({ url: browser.runtime.getURL("/setup.html") });
    }
    browser.alarms.create("tasks", { periodInMinutes: 1 });
  });

  browser.alarms.onAlarm.addListener(async (a) => {
    if (a.name !== "tasks") return;
    const tasks = await backend.pendingTasks();
    const seen = ((await browser.storage.local.get("seenTasks")) as { seenTasks?: string[] }).seenTasks ?? [];
    // The badge counts every open task (waiting or started), not just new ones.
    const open = (await backend.taskList())?.open.length ?? tasks.length;
    await browser.action.setBadgeText({ text: open ? String(open) : "" });
    await browser.action.setBadgeBackgroundColor({ color: "#E8654A" });
    const fresh = tasks.filter((t) => !seen.includes(t.id));
    for (const t of fresh) {
      browser.notifications.create(`task:${t.id}`, {
        type: "basic",
        iconUrl: browser.runtime.getURL("/icon/128.png"),
        title: `${t.from} sent you a task`,
        message: `${t.title}. Click the JustAsk button at the top right.`,
        priority: 2,
      });
    }
    if (fresh.length) await browser.storage.local.set({ seenTasks: [...seen, ...fresh.map((t) => t.id)].slice(-50) });
    // In-page banner fallback (ladder step 3) on the active tab.
    if (fresh.length) {
      const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id) await showBanner(tab.id, `${fresh[0].from} sent you a task: ${fresh[0].title}`);
    }
  });

  // Ladder step 2: toast click. sidePanel.open may throw without a carried gesture; the badge stays on.
  browser.notifications.onClicked.addListener(async (id) => {
    if (!id.startsWith("task:")) return;
    const win = await browser.windows.getLastFocused();
    if (win.id !== undefined) {
      const opened = openPanel({ windowId: win.id }); // call first, while the gesture is fresh
      await browser.windows.update(win.id, { focused: true });
      await opened;
    }
  });

  // Ladder step 3: the in-page banner's Start button.
  browser.runtime.onMessage.addListener((msg: unknown, sender) => {
    const m = msg as { type?: string };
    if (m?.type === "ja:banner-start" && sender.tab?.id !== undefined) {
      void openPanel({ tabId: sender.tab.id, windowId: sender.tab.windowId });
    }
  });
});

/** Inject the content script and show the in-page banner. False when the page can't take it. */
async function showBanner(tabId: number, text: string): Promise<boolean> {
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: [CONTENT_FILE] });
    await browser.tabs.sendMessage(tabId, { type: "ja:banner", text }, { frameId: 0 });
    return true;
  } catch {
    return false; // no host access on this page
  }
}
