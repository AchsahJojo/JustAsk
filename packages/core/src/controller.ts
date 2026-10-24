import { checkStep, type ActResult, type ActSpec, type EventType, type FrameScan, type FromContent, type HighlightSpec, type PageSnapshot, type PlanRequest, type PlanResponse, type Recipe, type StepResponse } from "@justask/shared";
import { mergeScans, type TargetRef } from "./merge";
import * as L from "./lines";
import { parseCommand } from "./commands";

export type Phase = "idle" | "planning" | "confirming" | "acting" | "guiding" | "verifying" | "asking" | "waiting" | "paused" | "done" | "blocked";

export interface SessionView {
  phase: Phase;
  request: string;
  /** The current caption (what was last said). */
  line: string;
  stepNo: number;
  expect: StepResponse["expect"];
  risk: StepResponse["risk"];
  /** Small status note, e.g. "Still looking…". */
  note: string;
  pauseReason: "other-tab" | "tab-closed" | "cant-see" | "no-access" | null;
  taskId: string | null;
  clicks: number;
}

export interface PageBridge {
  /** Scan every frame of the session tab. An empty array means the page can't be injected. */
  scan(context: string[]): Promise<FrameScan[]>;
  highlight(ref: TargetRef, spec: HighlightSpec): Promise<boolean>;
  clear(): Promise<void>;
  pulse(ref: TargetRef): Promise<void>;
  /** Resolves true when the page navigated or the DOM settled after changing. */
  waitForChange(timeoutMs: number): Promise<boolean>;
  /** Perform one action for her (drive mode). Resolves `{ok: false}` when it could not, so the step falls back to guide. */
  act(ref: TargetRef, spec: ActSpec): Promise<ActResult>;
  /** While on, report settled page changes as `ja:page-changed` (used in the waiting phase). */
  watch(on: boolean): void;
}

export interface Planner {
  plan(req: PlanRequest, signal: AbortSignal): Promise<PlanResponse>;
}

export interface SpeechOut {
  speak(text: string, opts?: { interrupt?: boolean }): void;
  stop(): void;
}

export interface SessionStore {
  save(view: SessionView, extra: { history: string[]; recipe: Recipe | null }): void;
}

export interface EventSink {
  log(type: EventType, extra?: { latencyMs?: number }): void;
}

export interface ControllerDeps {
  bridge: PageBridge;
  planner: Planner;
  speech: SpeechOut;
  store?: SessionStore;
  events?: EventSink;
  deviceToken?: () => string | null;
  /** Synced account preferences. `showMeInstead`: turn every act step into a guide step. */
  prefs?: () => { showMeInstead: boolean };
  /** Ids for snapshots; injectable for tests. */
  newId?: () => string;
  timing?: Partial<typeof DEFAULT_TIMING>;
}

export const DEFAULT_TIMING = {
  stepTimeoutMs: 10_000,
  slowNoteMs: 3_000,
  changeTimeoutMs: 4_000,
  quietChangeMs: 700,
  maxSteps: 40,
  wrongDebounceMs: 250,
};

const INITIAL: SessionView = {
  phase: "idle",
  request: "",
  line: "",
  stepNo: 0,
  expect: null,
  risk: "none",
  note: "",
  pauseReason: null,
  taskId: null,
  clicks: 0,
};

/**
 * The session state machine and step loop. No browser APIs: everything goes through
 * the injected PageBridge / Planner / SpeechOut, so the same controller runs in the
 * side panel, in the background (dock mode), or in tests.
 */
export class SessionController {
  private view: SessionView = { ...INITIAL };
  private listeners = new Set<(v: SessionView) => void>();
  private history: string[] = [];
  private recipe: Recipe | null = null;
  private snapshot: PageSnapshot | null = null;
  private map = new Map<number, TargetRef>();
  private step: StepResponse | null = null;
  private target: TargetRef | null = null;
  private gen = 0;
  private replans = 0;
  private lostCount = 0;
  private abort: AbortController | null = null;
  private sessionId: string | null = null;
  private lastWrongAt = 0;
  private t: typeof DEFAULT_TIMING;

  constructor(private deps: ControllerDeps) {
    this.t = { ...DEFAULT_TIMING, ...deps.timing };
  }

  get state(): SessionView {
    return this.view;
  }

  get currentSnapshot(): PageSnapshot | null {
    return this.snapshot;
  }

  get currentHistory(): string[] {
    return [...this.history];
  }

  subscribe(fn: (v: SessionView) => void): () => void {
    this.listeners.add(fn);
    fn(this.view);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<SessionView>) {
    this.view = { ...this.view, ...patch };
    this.deps.store?.save(this.view, { history: this.history, recipe: this.recipe });
    for (const fn of this.listeners) fn(this.view);
  }

  private say(text: string, interrupt = true) {
    this.deps.speech.speak(text, { interrupt });
  }

  /** Restore after the panel or service worker restarts (state came from storage.session). */
  restore(view: SessionView, history: string[], recipe: Recipe | null) {
    this.view = { ...view, note: "" };
    this.history = history;
    this.recipe = recipe;
    for (const fn of this.listeners) fn(this.view);
    if (["planning", "guiding", "verifying", "confirming"].includes(view.phase)) void this.plan();
  }

  // ───────────── user actions ─────────────

  async start(request: string, opts: { recipe?: Recipe | null; taskId?: string | null; sessionId?: string | null } = {}) {
    const text = request.trim();
    if (!text) return;
    this.reset();
    this.recipe = opts.recipe ?? null;
    this.sessionId = opts.sessionId ?? null;
    this.set({ ...INITIAL, request: text, taskId: opts.taskId ?? null, stepNo: 1, line: L.FILLER_LINE, phase: "planning" });
    this.say(L.FILLER_LINE);
    await this.plan();
  }

  /** Free text from the mic or typed box while a session is running. */
  async input(raw: string) {
    const cmd = parseCommand(raw);
    switch (cmd.kind) {
      case "repeat":
        return this.repeat();
      case "stop":
        return this.stop();
      case "stuck":
        return this.stuck();
      case "yes":
        if (this.view.phase === "confirming") return this.confirm(true);
        break;
      case "no":
        if (this.view.phase === "confirming") return this.confirm(false);
        break;
      case "done-typing":
        if (this.view.phase === "guiding" && this.step?.expect === "type") return this.doneTyping();
        break;
    }
    if (this.view.phase === "asking" || this.view.phase === "waiting") return this.answer(raw);
    if (this.view.phase === "idle" || this.view.phase === "done" || this.view.phase === "blocked") return this.start(raw);
    this.repeat();
  }

  repeat() {
    if (!this.view.line) return;
    this.deps.events?.log("repeat");
    this.say(this.view.line);
    if (this.target && this.view.phase === "guiding") void this.deps.bridge.pulse(this.target);
  }

  async stop() {
    const wasActive = this.view.phase !== "idle" && this.view.phase !== "done";
    this.gen++;
    this.abort?.abort();
    this.deps.speech.stop();
    await this.deps.bridge.clear();
    if (wasActive) this.deps.events?.log("abandoned");
    this.reset();
    this.set({ ...INITIAL, line: wasActive ? L.STOPPED_LINE : "" });
  }

  async stuck() {
    if (this.view.phase === "idle") return;
    this.deps.events?.log("stuck");
    this.history.push("She said she is stuck or can't find it");
    this.say(L.STUCK_LINE);
    await this.deps.bridge.clear();
    this.set({ phase: "planning", line: L.STUCK_LINE });
    await this.plan();
  }

  async answer(text: string) {
    this.history.push(`She answered: ${JSON.stringify(text.slice(0, 200))}`);
    this.set({ phase: "planning", line: L.FILLER_LINE });
    await this.plan();
  }

  async confirm(yes: boolean) {
    if (this.view.phase !== "confirming" || !this.step) return;
    if (!yes) {
      this.history.push("She chose not to do that step");
      this.say("Okay, we won't do that.");
      await this.deps.bridge.clear();
      this.deps.events?.log("abandoned");
      this.set({ phase: "done", line: "Okay, we won't do that. Nothing was sent.", note: "" });
      return;
    }
    await this.showGuide(this.step);
  }

  doneTyping() {
    if (this.view.phase !== "guiding") return;
    void this.onStepDone("typed");
  }

  // ───────────── tab / environment events (from TabWatcher) ─────────────

  pause(reason: NonNullable<SessionView["pauseReason"]>) {
    if (this.view.phase === "idle" || this.view.phase === "done" || this.view.phase === "blocked") return;
    this.gen++;
    this.abort?.abort();
    void this.deps.bridge.clear();
    const line =
      reason === "cant-see"
        ? L.CANT_SEE_PAGE
        : reason === "other-tab"
          ? "Keep helping on this tab?"
          : reason === "no-access"
            ? "I need permission to see this page."
            : "The page closed. Want to keep going?";
    if (reason === "cant-see") this.say(line);
    this.set({ phase: "paused", pauseReason: reason, line });
  }

  /** Resume (after "Yes, here", a new followed tab, or returning to the session tab). */
  async resume(note?: string) {
    if (this.view.phase !== "paused" && this.view.phase !== "waiting") return;
    if (note) {
      this.history.push(note);
    }
    this.set({ phase: "planning", pauseReason: null, line: L.FILLER_LINE });
    await this.plan();
  }

  /** A new tab opened from the session tab after a click: move there and keep going. */
  async followedNewTab() {
    if (this.view.phase === "idle" || this.view.phase === "done") return;
    this.gen++;
    this.abort?.abort();
    this.history.push("That opened a new tab");
    this.say(L.NEW_TAB_LINE);
    this.set({ phase: "planning", pauseReason: null, line: L.NEW_TAB_LINE });
    await this.plan();
  }

  /** A full navigation happened in the session tab (content script is gone and re-injected). */
  async navigated() {
    if (this.view.phase === "guiding") {
      // She navigated somehow without completing the target (back button, link elsewhere).
      this.history.push("The page changed before she clicked the highlighted thing");
      this.set({ phase: "planning", line: L.FILLER_LINE });
      await this.plan();
    } else if (this.view.phase === "waiting") {
      await this.resume("The page changed while she was waiting");
    }
  }

  // ───────────── content-script events ─────────────

  async onContent(e: FromContent, frameId: number) {
    if (this.target && "type" in e && frameId !== this.target.frameId && e.type !== "ja:page-changed") {
      // Events from other frames: a click elsewhere still counts as a wrong click.
      if (e.type === "ja:wrong" || e.type === "ja:clicked") return this.onWrong(e.type === "ja:wrong" ? e.what : "click");
      return;
    }
    switch (e.type) {
      case "ja:step-done":
        return this.onStepDone(e.how);
      case "ja:wrong":
        return this.onWrong(e.what);
      case "ja:lost":
        if (this.view.phase !== "guiding") return;
        this.history.push("The page changed before she could click");
        this.set({ phase: "planning", line: L.LOST_LINE, note: "" });
        return this.plan();
      case "ja:page-changed":
        if (this.view.phase === "waiting") return this.resume("The page changed while she was waiting");
        return;
    }
  }

  private onWrong(what: "click" | "typing" | "choice") {
    if (this.view.phase !== "guiding") return;
    const now = Date.now();
    if (now - this.lastWrongAt < this.t.wrongDebounceMs) return;
    this.lastWrongAt = now;
    const line = what === "typing" ? L.WRONG_TYPING : what === "choice" && this.step?.option ? L.choiceMismatch(this.step.option) : L.WRONG_CLICK;
    this.say(line);
    if (this.target) void this.deps.bridge.pulse(this.target);
  }

  private async onStepDone(how: string) {
    if (this.view.phase !== "guiding" || !this.step) return;
    const gen = ++this.gen;
    const did = this.step.say;
    const clicks = this.view.clicks + 1;
    this.history.push(`She did: ${JSON.stringify(did)} (${how})`);
    const p = L.praise(this.history.length);
    this.say(p);
    await this.deps.bridge.clear();
    this.target = null;
    this.set({ phase: "verifying", line: `${p} Let me look at the next page…`, clicks, note: "" });
    // Clicks usually change the page; typing and choosing usually don't, so don't make her wait.
    const changed = await this.deps.bridge.waitForChange(how === "click" ? this.t.changeTimeoutMs : this.t.quietChangeMs);
    if (gen !== this.gen) return;
    if (!changed && how === "click") {
      this.history.push(L.NO_CHANGE_NOTE);
      this.deps.events?.log("no_change");
    }
    this.set({ stepNo: this.view.stepNo + 1 });
    await this.plan(gen);
  }

  // ───────────── the loop ─────────────

  private async scanPage(): Promise<boolean> {
    const context = [this.view.request, this.view.line, ...(this.recipe?.steps ?? [])];
    const scans = await this.deps.bridge.scan(context);
    if (!scans.length) return false;
    const id = this.deps.newId?.() ?? Math.random().toString(36).slice(2, 10);
    const merged = mergeScans(scans, id);
    this.snapshot = merged.snapshot;
    this.map = merged.map;
    return true;
  }

  private async plan(genIn?: number) {
    const gen = genIn ?? ++this.gen;
    this.replans = 0;
    if (this.view.stepNo > this.t.maxSteps) {
      return this.block("This is taking a lot of steps. Let's take a break and ask your helper.");
    }
    this.set({ phase: "planning" });
    let ok: boolean;
    try {
      ok = await this.scanPage();
    } catch {
      ok = false;
    }
    if (gen !== this.gen) return;
    if (!ok) {
      this.pause("cant-see");
      return;
    }
    await this.requestStep(gen, null);
  }

  private async requestStep(gen: number, retryNote: string | null): Promise<void> {
    const snapshot = this.snapshot!;
    const req: PlanRequest = {
      deviceToken: this.deps.deviceToken?.() ?? null,
      sessionId: this.sessionId,
      request: this.view.request,
      history: this.history.slice(-30),
      recipe: this.recipe,
      snapshot,
      retryNote,
    };
    const res = await this.callPlanner(req, gen);
    if (gen !== this.gen) return;
    if (!res) return; // superseded
    if (!res.ok) {
      this.deps.events?.log("blocked");
      return this.block(L.TROUBLE_LINE, false);
    }
    if (res.snapshotId !== snapshot.snapshotId) return; // stale
    const check = checkStep(res.step, snapshot);
    if (!check.ok) {
      if (this.replans++ < 1) return this.requestStep(gen, check.reason);
      return this.block(L.TROUBLE_LINE, false);
    }
    await this.handleStep(res.step, res.latencyMs);
  }

  /** 10 s per attempt, "Still looking…" at 3 s, one retry. Returns null when superseded. */
  private async callPlanner(req: PlanRequest, gen: number): Promise<PlanResponse | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (gen !== this.gen) return null;
      const ctrl = new AbortController();
      this.abort = ctrl;
      const slow = setTimeout(() => gen === this.gen && this.set({ note: L.STILL_LOOKING }), this.t.slowNoteMs);
      const timeout = setTimeout(() => ctrl.abort(), this.t.stepTimeoutMs);
      try {
        const res = await this.deps.planner.plan(req, ctrl.signal);
        if (res.ok || !res.retryable) return res;
      } catch {
        if (gen !== this.gen) return null;
      } finally {
        clearTimeout(slow);
        clearTimeout(timeout);
        if (gen === this.gen) this.set({ note: "" });
      }
    }
    return { ok: false, error: "planner failed twice", retryable: false };
  }

  private async handleStep(step: StepResponse, latencyMs: number) {
    this.step = step;
    if (step.risk === "suspicious") {
      this.deps.events?.log("blocked");
      return this.block(step.say || L.SUSPICIOUS_LINE);
    }
    switch (step.kind) {
      // Wave 0 stub: drive mode (docs/ARCHITECTURE.md §11) lands with the core-loop work. Until then act = guide.
      case "act":
      case "guide":
        this.deps.events?.log("step_shown", { latencyMs });
        if (step.risk !== "none" && L.RISK_QUESTION[step.risk]) {
          const q = L.RISK_QUESTION[step.risk];
          this.say(q);
          this.set({ phase: "confirming", line: q, risk: step.risk, expect: step.expect });
          return;
        }
        return this.showGuide(step);
      case "clarify":
        this.deps.events?.log("clarify");
        this.say(step.say);
        await this.deps.bridge.clear();
        this.set({ phase: "asking", line: step.say, expect: null, risk: "none" });
        return;
      case "wait":
        this.say(step.say);
        this.set({ phase: "waiting", line: step.say, expect: null, risk: "none" });
        return;
      case "done":
        this.deps.events?.log("done");
        await this.deps.bridge.clear();
        this.say(step.say || L.DONE_LINE);
        this.set({ phase: "done", line: step.say || L.DONE_LINE, expect: null, risk: "none" });
        return;
      case "blocked":
        this.deps.events?.log("blocked");
        return this.block(step.say);
    }
  }

  private async showGuide(step: StepResponse) {
    const ref = this.map.get(step.target!);
    if (!ref) return this.block(L.TROUBLE_LINE, false);
    this.target = ref;
    const el = this.snapshot?.elements.find((e) => e.n === step.target);
    const shown = await this.deps.bridge.highlight(ref, {
      localId: ref.localId,
      expect: step.expect ?? "click",
      option: step.option,
      label: labelFor(step.expect),
    });
    if (!shown) {
      // Resolve failed (rerender with no unique fingerprint match): re-plan once.
      this.history.push("The page changed before she could click");
      if (this.lostCount++ < 1) {
        this.set({ phase: "planning", line: L.LOST_LINE });
        return this.plan();
      }
      return this.block(L.TROUBLE_LINE, false);
    }
    const line = step.expect === "type" && el?.field?.kind === "password" && !/can'?t see/i.test(step.say) ? `${step.say} I can't see it.` : step.say;
    this.lostCount = 0;
    this.say(line);
    this.set({ phase: "guiding", line, expect: step.expect, risk: step.risk, note: "" });
  }

  private async block(line: string, speak = true) {
    this.gen++;
    await this.deps.bridge.clear();
    if (speak || line) this.say(line);
    this.set({ phase: "blocked", line, note: "" });
  }

  private reset() {
    this.gen++;
    this.history = [];
    this.recipe = null;
    this.snapshot = null;
    this.map = new Map();
    this.step = null;
    this.target = null;
    this.replans = 0;
    this.lostCount = 0;
  }
}

function labelFor(expect: StepResponse["expect"]): string {
  switch (expect) {
    case "type":
      return "Type here";
    case "choose":
      return "Pick here";
    case "hover":
      return "Point here";
    case "file":
      return "Click here";
    default:
      return "Click here";
  }
}
