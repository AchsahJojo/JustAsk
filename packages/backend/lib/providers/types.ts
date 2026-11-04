import type { PlanRequest, PlanResponse, QueryResponse } from "@justask/shared";
import type { PlanLog } from "../planStep";
import type { TaskCheckInput, TaskCheckOutcome } from "../taskCheck";

export type ProviderName = "anthropic" | "deepseek";

/**
 * One model provider behind `/plan`, `/search-query` and the caregiver task check. The prompts
 * (`SYSTEM_PROMPT`, `buildTurn`, `QUERY_SYSTEM`, `TASK_CHECK_SYSTEM`) and the deterministic gates
 * (`StepResponse`, `checkStep`, `tidyReply`) are the same for every provider; only the HTTP call differs.
 */
export interface StepProvider {
  name: ProviderName;
  /** One planner step. Logs numbers only, never the page. */
  planStep(req: PlanRequest, log?: (l: PlanLog) => void): Promise<PlanResponse>;
  /** The user's request rewritten as a web search (their words only, never a page). */
  searchQuery(request: string): Promise<QueryResponse>;
  /** The caregiver's task, checked until it's clear. `timeoutMs` per attempt. */
  checkTask(input: TaskCheckInput, timeoutMs?: number): Promise<TaskCheckOutcome>;
}
