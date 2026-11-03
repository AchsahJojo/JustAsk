import { anthropicProvider } from "./anthropic";
import { deepseekProvider } from "./deepseek";
import type { StepProvider } from "./types";

export type { ProviderName, StepProvider } from "./types";
export { anthropicProvider } from "./anthropic";
export { deepseekProvider } from "./deepseek";

export type Env = Record<string, string | undefined>;

/**
 * DeepSeek is allowed only where no real user's page goes through it, until the privacy review
 * (issue #18) is done: the local dev planner (no Convex URL), a local Convex backend, or a cloud dev
 * deployment someone marked by hand with `PLANNER_ALLOW_DEEPSEEK=dev`. Never set that on prod.
 * Fail closed: an unknown deployment counts as prod.
 */
export function deepseekAllowed(env: Env): boolean {
  const url = env.CONVEX_CLOUD_URL;
  if (!url) return true;
  if (/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/?$/.test(url)) return true;
  return env.PLANNER_ALLOW_DEEPSEEK === "dev";
}

export type Picked = { ok: true; provider: StepProvider; warning: string | null } | { ok: false; error: string };

/**
 * The provider for `/plan`, `/search-query` and task checks, from Convex env (or the dev planner's
 * shell). `PLANNER_PROVIDER` unset or `anthropic`: exactly today's Anthropic path. `deepseek` needs
 * `DEEPSEEK_API_KEY`; where DeepSeek isn't allowed it falls back to Anthropic with a warning, so a
 * misconfigured prod keeps working and never sends a page to DeepSeek. Keys come from env only.
 */
export function pickProvider(env: Env): Picked {
  const want = (env.PLANNER_PROVIDER ?? "anthropic").trim().toLowerCase() || "anthropic";
  let warning: string | null = null;
  if (want === "deepseek") {
    if (deepseekAllowed(env)) {
      const key = env.DEEPSEEK_API_KEY;
      if (!key) return { ok: false, error: "server not configured" };
      return { ok: true, provider: deepseekProvider(key), warning: null };
    }
    warning = "PLANNER_PROVIDER=deepseek is refused on this deployment until the privacy review; using anthropic";
  } else if (want !== "anthropic") {
    warning = `unknown PLANNER_PROVIDER "${want.slice(0, 20)}"; using anthropic`;
  }
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: "server not configured" };
  return { ok: true, provider: anthropicProvider(key), warning };
}
