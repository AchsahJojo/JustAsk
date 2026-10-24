import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { openPanel, setPanelOnActionClick } from "../platform";
import { backend } from "../lib/backend";
import { getSettings } from "../lib/config";
import { parseHandoffFragment, parseLinkFragment } from "../lib/fragments";
import type { PendingHandoff } from "../lib/session";

const CONTENT_FILE = "/content-scripts/content.js";
const HANDOFF_BANNER = "Press Start to keep going";
const claimingHandoffs = new Set<string>();
const openingLinkCodes = new Set<string>();

// The background only does notifications, badge, permission plumbing and handoff links
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
    if (!id.startsWith("task:") && !id.startsWith("handoff:")) return;
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

  // Handoff (`#justask=<id>`) and link (`#justask-link=<code>`) fragments (ARCHITECTURE.md §8, §9).
  browser.tabs.onUpdated.addListener((tabId, info, tab) => {
    const url = info.url ?? (info.status === "complete" ? tab.url : undefined);
    if (!url || !url.includes("#justask")) return;
    const handoffId = parseHandoffFragment(url);
    if (handoffId) void claimHandoff(tabId, handoffId);
    const code = parseLinkFragment(url, import.meta.env.VITE_LINK_ORIGIN);
    if (code) void openLinkSetup(tabId, code);
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

async function hasSeen(key: string, id: string): Promise<boolean> {
  const got = (await browser.storage.session.get(key).catch(() => ({}))) as Record<string, string[] | undefined>;
  return (got[key] ?? []).includes(id);
}

async function remember(key: string, id: string): Promise<void> {
  const got = (await browser.storage.session.get(key).catch(() => ({}))) as Record<string, string[] | undefined>;
  const seen = got[key] ?? [];
  await browser.storage.session.set({ [key]: [...seen.filter((x) => x !== id), id].slice(-20) }).catch(() => {});
}

async function claimHandoff(tabId: number, handoffId: string) {
  if (claimingHandoffs.has(handoffId) || (await hasSeen("claimedHandoffs", handoffId))) return;
  claimingHandoffs.add(handoffId);
  try {
    const h = await backend.claimHandoff(handoffId);
    if (!h) return; // Network/temporary failures can retry on a later tab update.
    const pending: PendingHandoff = { ...h, tabId, at: Date.now() };
    try {
      await browser.storage.session.set({ pendingHandoff: pending });
    } catch {
      return;
    }
    await remember("claimedHandoffs", handoffId);
    if (await showBanner(tabId, HANDOFF_BANNER)) return;
    // No host access on this page: a toast whose click opens the panel instead.
    browser.notifications.create(`handoff:${handoffId}`, {
      type: "basic",
      iconUrl: browser.runtime.getURL("/icon/128.png"),
      title: "JustAsk is ready to keep going",
      message: "Click here, or the JustAsk button at the top right, then press Start.",
      priority: 2,
    });
  } finally {
    claimingHandoffs.delete(handoffId);
  }
}

async function openLinkSetup(tabId: number, code: string) {
  const key = `${tabId}:${code}`;
  if (openingLinkCodes.has(key) || (await hasSeen("seenLinkCodes", key))) return;
  openingLinkCodes.add(key);
  try {
    await browser.tabs.create({ url: browser.runtime.getURL(`/setup.html?link=${code}`) });
    await remember("seenLinkCodes", key);
  } catch {
    // A later tab update can retry if the setup tab couldn't be opened.
  } finally {
    openingLinkCodes.delete(key);
  }
}
