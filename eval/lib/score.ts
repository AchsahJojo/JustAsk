import { checkStep, type PageSnapshot, type Recipe, type StepResponse } from "../../packages/shared/src/index";

/** One eval case: eval/cases/<id>.case.json. */
export interface EvalCase {
  id: string;
  /** `{FIXTURES}` is replaced with the local fixture server by capture. */
  url: string;
  request: string;
  history?: string[];
  recipe?: Recipe | null;
  /** Public real site: captured only with `--live`; its snapshot is not committed. */
  live?: boolean;
  /** Fixture page not built yet: capture skips it on 404. */
  pendingFixture?: boolean;
  /** Extra wait before scanning (late-loading editors). Default 400 ms. */
  settleMs?: number;
  /** Optional action before the scan, e.g. open a composer. */
  prepare?: { clickText?: string };
  note?: string;
  expected: {
    kind: StepResponse["kind"];
    allowKinds?: StepResponse["kind"][];
    /** Case-insensitive substring of the chosen element's text or label. A list means any of them. */
    targetText?: string | string[];
    forbidTargetText?: string[];
  };
}

export interface Score {
  kindOk: boolean;
  targetOk: boolean;
  checkOk: boolean;
  checkReason: string | null;
  /** Text + label of the chosen element, for the report. */
  targetDesc: string | null;
  pass: boolean;
}

const TARGETING = new Set(["guide", "act"]);

/** Score one step against a case's expectations. Pure; no I/O. */
export function scoreStep(c: EvalCase, step: StepResponse, snapshot: PageSnapshot): Score {
  const allowed = c.expected.allowKinds ?? [c.expected.kind];
  const kindOk = allowed.includes(step.kind);

  const el = step.target === null ? undefined : snapshot.elements.find((e) => e.n === step.target);
  const hay = el ? `${el.text} ${el.label ?? ""}`.toLowerCase() : "";
  const forbidden = !!el && (c.expected.forbidTargetText ?? []).some((f) => hay.includes(f.toLowerCase()));
  const wanted = c.expected.targetText === undefined ? [] : [c.expected.targetText].flat();
  let targetOk: boolean;
  if (forbidden) targetOk = false;
  else if (TARGETING.has(step.kind) && wanted.length) targetOk = !!el && wanted.some((w) => hay.includes(w.toLowerCase()));
  else targetOk = true;

  const check = checkStep(step, snapshot);
  const checkOk = check.ok;
  return {
    kindOk,
    targetOk,
    checkOk,
    checkReason: check.ok ? null : check.reason,
    targetDesc: el ? [el.text, el.label].filter(Boolean).join(" / ") : step.target === null ? null : `#${step.target} (not in list)`,
    pass: kindOk && targetOk && checkOk,
  };
}

/** Nearest-rank percentile; 0 for an empty list. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
