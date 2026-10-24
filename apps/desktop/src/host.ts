// Hosts the SessionController in the desktop app: wires NativeBridge, the HTTP planner and speech,
// keeps the Convex live queries (tasks, handoffs) and the heartbeat, and runs handoffs both ways.
import { SessionController, type SessionView } from "@justask/core";
import type { EventType, Recipe } from "@justask/shared";
import { NativeBridge } from "./bridge";
import { HttpPlanner } from "./planner";
import { BrowserSpeech } from "./speech";
import { CartesiaListener } from "./stt";
import { DesktopBackend, type PendingHandoff, type PendingTask } from "./backend";
import { deviceInfo, detectPlatform, newMachineId, type DeviceInfo } from "./device";
import { handoffUrl, isOpenableUrl } from "./links";
import { getSaved, persist, save } from "./store";
import { notify, openExternal, showWindow } from "./os";

export const HEARTBEAT_MS = 60_000;
export const HANDOFF_LINE = "I'll keep helping you here.";
export const OPENED_IN_BROWSER_LINE = "I opened it in your browser. I'll help you there.";

export interface HostState {
  ready: boolean;
  token: string | null;
  displayName: string;
  tasks: PendingTask[];
  online: boolean;
}

const RUNNING = (phase: SessionView["phase"]) => !["idle", "done", "blocked"].includes(phase);

export class DesktopHost {
  readonly backend = new DesktopBackend(import.meta.env.VITE_CONVEX_URL);
  readonly bridge = new NativeBridge();
  readonly speech = new BrowserSpeech();
  readonly listener: CartesiaListener;
  readonly controller: SessionController;

  private hs: HostState = { ready: false, token: null, displayName: "", tasks: [], online: false };
  private listeners = new Set<(s: HostState) => void>();
  private machineId = "";
  private sessionId: string | null = null;
  private offline: Array<() => void> = [];
  private seenTasks = new Set<string>();
  private firstTaskBatch = true;
  private seenHandoffs = new Set<string>();
  private lastHandoffs: PendingHandoff[] = [];
  private disconnectBridge: (() => void) | null = null;

  constructor() {
    this.listener = new CartesiaListener(async () => (this.hs.token ? this.backend.cartesiaToken(this.hs.token) : null));
    this.controller = new SessionController({
      bridge: this.bridge,
      planner: new HttpPlanner(() => import.meta.env.VITE_PLANNER_URL || "http://localhost:8787"),
      speech: this.speech,
      deviceToken: () => this.hs.token,
      events: { log: (type: EventType, extra) => this.onEvent(type, extra?.latencyMs) },
    });
    // When a session ends, pick up any handoff that arrived meanwhile.
    this.controller.subscribe((v) => {
      if (!RUNNING(v.phase)) void this.processHandoffs(this.lastHandoffs);
    });
  }

  get state(): HostState {
    return this.hs;
  }

  subscribe(fn: (s: HostState) => void): () => void {
    this.listeners.add(fn);
    fn(this.hs);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<HostState>) {
    this.hs = { ...this.hs, ...patch };
    for (const fn of this.listeners) fn(this.hs);
  }

  /** Load saved settings, connect native events, and go online if this install is linked. */
  async init() {
    const saved = await getSaved();
    this.machineId = saved.machineId ?? "";
    if (!this.machineId) {
      this.machineId = newMachineId();
      await save({ machineId: this.machineId });
    }
    this.disconnectBridge = await this.bridge.connect((e, frameId) => void this.controller.onContent(e, frameId));
    this.set({ ready: true, token: saved.deviceToken, displayName: saved.displayName });
    if (saved.deviceToken) this.goOnline(saved.deviceToken);
  }

  dispose() {
    this.goOffline();
    this.disconnectBridge?.();
  }

  /** The `device` argument for createSelf / redeemCode. */
  device(): DeviceInfo {
    return deviceInfo(detectPlatform(typeof navigator !== "undefined" ? navigator.userAgent : ""), this.machineId);
  }

  // ───── accounts ─────

  async createAccount(displayName: string) {
    const name = displayName.trim();
    const t0 = performance.now();
    const socketOpen = this.backend.connected;
    const { token } = await this.backend.createSelf(name, this.device());
    console.info(`[host] createSelf took ${Math.round(performance.now() - t0)} ms (socket ${socketOpen ? "open" : "not open"} at click)`);
    this.signedIn(token, name);
  }

  /** Returns false when the code didn't work. Throws on lockout. */
  async redeem(code: string): Promise<boolean> {
    const t0 = performance.now();
    const socketOpen = this.backend.connected;
    const res = await this.backend.redeemCode(code, this.device());
    console.info(`[host] redeemCode took ${Math.round(performance.now() - t0)} ms (socket ${socketOpen ? "open" : "not open"} at click)`);
    if (!res) return false;
    this.signedIn(res.token, res.displayName);
    return true;
  }

  async createLinkCode() {
    if (!this.hs.token) throw new Error("not linked");
    return this.backend.createLinkCode(this.hs.token);
  }

  async signOut() {
    await this.controller.stop();
    this.goOffline();
    await save({ deviceToken: null, displayName: "" });
    this.set({ token: null, displayName: "", tasks: [] });
  }

  /** Show the main screen right away; write the token to disk in the background. */
  private signedIn(token: string, displayName: string) {
    this.set({ token, displayName });
    // createSelf / redeemCode just set lastSeenAt, so the first heartbeat can wait.
    this.goOnline(token, { heartbeatNow: false });
    const t0 = performance.now();
    persist({ deviceToken: token, displayName }).then(
      () => console.info(`[host] saved sign-in in ${Math.round(performance.now() - t0)} ms`),
      (e) => console.warn("[host] could not save sign-in; she may need to link again after a restart", e),
    );
  }

  private goOnline(token: string, opts: { heartbeatNow?: boolean } = {}) {
    this.goOffline();
    if (!this.backend.configured) return;
    if (opts.heartbeatNow !== false) void this.backend.heartbeat(token);
    const iv = setInterval(() => void this.backend.heartbeat(token), HEARTBEAT_MS);
    this.offline.push(() => clearInterval(iv));
    this.offline.push(this.backend.onTasks(token, (t) => this.onTasks(t)));
    this.offline.push(this.backend.onHandoffs(token, (h) => void this.processHandoffs(h)));
    this.set({ online: true });
  }

  private goOffline() {
    this.offline.splice(0).forEach((off) => off());
    if (this.hs.online) this.set({ online: false });
  }

  // ───── tasks ─────

  private onTasks(tasks: PendingTask[]) {
    const fresh = tasks.filter((t) => !this.seenTasks.has(t.id));
    fresh.forEach((t) => this.seenTasks.add(t.id));
    // On first load, one notification is enough; afterwards one per new task.
    const toNotify = this.firstTaskBatch ? fresh.slice(0, 1) : fresh;
    this.firstTaskBatch = false;
    for (const t of toNotify) void notify("JustAsk", `${t.from} sent you a task`);
    this.set({ tasks });
  }

  /** "Start" on a task. A task with a web start page goes to the browser (desktop -> browser handoff). */
  async startTask(t: PendingTask) {
    this.set({ tasks: this.hs.tasks.filter((x) => x.id !== t.id) });
    const startUrl = t.recipe?.startUrl;
    if (isOpenableUrl(startUrl) && this.hs.token) {
      let url = startUrl;
      try {
        const id = await this.backend.createHandoff(this.hs.token, { toKind: "extension", request: t.spokenPrompt, taskId: t.id, recipe: t.recipe });
        url = handoffUrl(startUrl, id);
      } catch (e) {
        console.warn("[host] handoff create failed; opening the start page only", e);
      }
      await openExternal(url);
      this.speech.speak(OPENED_IN_BROWSER_LINE);
      return;
    }
    await this.start(t.spokenPrompt, { recipe: t.recipe, taskId: t.id });
  }

  laterTask(t: PendingTask) {
    this.set({ tasks: this.hs.tasks.filter((x) => x.id !== t.id) });
    if (this.hs.token) void this.backend.setTaskStatus(this.hs.token, t.id, "pending");
  }

  // ───── handoffs (browser -> desktop) ─────

  private async processHandoffs(rows: PendingHandoff[]) {
    this.lastHandoffs = rows;
    const token = this.hs.token;
    if (!token || RUNNING(this.controller.state.phase)) return;
    const next = rows.find((h) => !this.seenHandoffs.has(h.id) && (h.toKind === null || h.toKind === "desktop"));
    if (!next) return;
    this.seenHandoffs.add(next.id);
    const claimed = await this.backend.claimHandoff(token, next.id);
    if (!claimed || !claimed.request) return;
    await showWindow();
    await this.speech.speakAndWait(HANDOFF_LINE);
    await this.start(claimed.request, { recipe: claimed.recipe ?? null, taskId: claimed.taskId ?? null });
  }

  // ───── sessions ─────

  async start(request: string, opts: { recipe?: Recipe | null; taskId?: string | null } = {}) {
    const text = request.trim();
    if (!text) return;
    const token = this.hs.token;
    this.sessionId = token ? await this.backend.startSession(token, text, opts.taskId ?? null) : null;
    if (token && opts.taskId) void this.backend.setTaskStatus(token, opts.taskId, "active");
    await this.controller.start(text, { recipe: opts.recipe ?? null, taskId: opts.taskId ?? null, sessionId: this.sessionId });
  }

  private onEvent(type: EventType, latencyMs?: number) {
    if (this.sessionId && this.hs.token) void this.backend.logEvent(this.hs.token, this.sessionId, type, latencyMs);
  }
}
