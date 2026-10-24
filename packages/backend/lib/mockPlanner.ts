import { checkStep, type PageSnapshot, type PlanRequest, type PlanResponse, type StepResponse } from "@justask/shared";

/**
 * Deterministic stand-in for Claude, for local dev and e2e tests only. It reads a
 * test script (apps/fixtures/mock-script.json) keyed by page title. It is never used
 * when ANTHROPIC_API_KEY is set unless JUSTASK_MOCK=1.
 */
export interface MockRule {
  title: string;
  /** Skip this rule when the target field already has a value. */
  unlessFilled?: boolean;
  /** Only when the history contains this text. */
  afterHistory?: string;
  step: Omit<StepResponse, "target" | "fill"> & { targetText?: string; fill?: string | null };
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
  for (const r of rules) {
    if (!s.title.includes(r.title)) continue;
    if (r.afterHistory && !hist.includes(r.afterHistory)) continue;
    const { targetText, ...rest } = r.step;
    let target: number | null = null;
    if (targetText) {
      const el = findTarget(s, targetText);
      if (!el) continue;
      if (r.unlessFilled && el.field?.hasValue) continue;
      target = el.n;
    }
    const step: StepResponse = { ...rest, fill: rest.fill ?? null, target };
    if (checkStep(step, s).ok) return { ok: true, snapshotId: s.snapshotId, step, latencyMs: 1 };
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
      step: { kind: "guide", say: `Click the one that says ${best.text}.`.split(/\s+/).slice(0, 20).join(" "), target: best.n, expect: "click", option: null, fill: null, risk: "none" },
    };
  }
  return { ok: true, snapshotId: s.snapshotId, latencyMs: 1, step: { kind: "blocked", say: "I'm not sure what to do on this page.", target: null, expect: null, option: null, fill: null, risk: "none" } };
}
