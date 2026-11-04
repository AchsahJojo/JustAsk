import { makeClient, planStep } from "../planStep";
import { searchQuery } from "../searchQuery";
import { checkTask } from "../taskCheck";
import type { StepProvider } from "./types";

/**
 * Today's Anthropic calls, unchanged: `planStep`, `searchQuery` and `checkTask` keep their own files
 * (the eval and stress scripts import them directly). This only wraps them in the provider interface.
 */
export function anthropicProvider(apiKey: string): StepProvider {
  const client = makeClient(apiKey);
  return {
    name: "anthropic",
    planStep: (req, log) => planStep(client, req, log ?? (() => {})),
    searchQuery: (request) => searchQuery(client, request),
    // The caregiver is waiting on a form, not a live step: more time than /plan gets.
    checkTask: (input, timeoutMs = 45_000) => checkTask(makeClient(apiKey, timeoutMs), input),
  };
}
