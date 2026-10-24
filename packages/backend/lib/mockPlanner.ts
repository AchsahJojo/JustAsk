import { checkStep, StepResponse, type PageSnapshot, type PlanRequest, type PlanResponse } from "@justask/shared";

/**
 * Deterministic stand-in for Claude, for local dev and e2e tests only. It reads a
 * test script (apps/fixtures/mock-script.json) keyed by page title. It is never used
 * when ANTHROPIC_API_KEY is set unless JUSTASK_MOCK=1.
 */
export interface MockRule {
  title: string;
  /** Only for a desktop window from one of these apps (the exe name without .exe, any case). */
  app?: string[];
  /** Skip this rule when the target field already has a value. */
  unlessFilled?: boolean;
  /** Only when the history contains this text. */
  afterHistory?: string;
  /** Only when her request contains this text (case-insensitive). */
  request?: string;
  /**
   * A guide-only step kind (`guide`, `clarify`, `wait`, `done`, `blocked`, or `open_browser` for desktop).
   * JustAsk never acts for her, so there is no `act` and no `text`. Rules that fail `checkStep` are skipped.
   */
  step: Omit<StepResponse, "target"> & { targetText?: string };
}

function findTarget(snapshot: PageSnapshot, text: string) {
  const t = text.toLowerCase();
  return (
    snapshot.elements.find((e) => e.text.toLowerCase() === t || (e.label ?? "").toLowerCase() === t) ??
    snapshot.elements.find((e) => e.text.toLowerCase().includes(t) || (e.label ?? "").toLowerCase().includes(t))
  );
}

export function mockPlan(req: PlanRequest, rules: MockRule[]): PlanResponse {
  const s = req.snapshot;
  const hist = req.history.join("\n");
  const appName = s.app?.name.toLowerCase();
  for (const r of rules) {
    if (!s.title.includes(r.title)) continue;
    if (r.app && !(appName && r.app.some((a) => a.toLowerCase() === appName))) continue;
    if (r.afterHistory && !hist.includes(r.afterHistory)) continue;
    if (r.request && !req.request.toLowerCase().includes(r.request.toLowerCase())) continue;
    // Only the StepResponse fields are copied, so a stray key in the script (like an old `text`) never reaches the client.
    const { kind, say, expect, option, risk, targetText } = r.step;
    let target: number | null = null;
    if (targetText) {
      const el = findTarget(s, targetText);
      if (!el) continue;
      if (r.unlessFilled && el.field?.hasValue) continue;
      target = el.n;
    }
    const step: StepResponse = { kind, say, target, expect, option, risk };
    // The schema check drops any kind the contract no longer has (such as the old `act`).
    if (StepResponse.safeParse(step).success && checkStep(step, s).ok) return { ok: true, snapshotId: s.snapshotId, step, latencyMs: 1 };
  }
  // Heuristic fallback: the element sharing the most words with the request.
  const words = new Set(req.request.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  let best: { n: number; score: number; text: string } | null = null;
  for (const e of s.elements) {
    const score = (e.text + " " + (e.label ?? "")).toLowerCase().split(/\W+/).filter((w) => words.has(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { n: e.n, score, text: e.text || e.label || "" };
  }
  if (best) {
    return {
      ok: true,
      snapshotId: s.snapshotId,
      latencyMs: 1,
      step: { kind: "guide", say: `Click the one that says ${best.text}.`.split(/\s+/).slice(0, 20).join(" "), target: best.n, expect: "click", option: null, risk: "none" },
    };
  }
  return { ok: true, snapshotId: s.snapshotId, latencyMs: 1, step: { kind: "blocked", say: "I'm not sure what to do on this page.", target: null, expect: null, option: null, risk: "none" } };
}
