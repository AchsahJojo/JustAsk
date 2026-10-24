/** Limits for a task a caregiver sends. Checked in the caregiver app and again in Convex. */
export const TASK_LIMITS = { title: 80, spokenPrompt: 200, steps: 12, step: 200, startUrl: 2000 } as const;

/** A recipe's start page must be a plain web address. JustAsk opens it for the user, so no other schemes. */
export function isSafeStartUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** What a caregiver sees for a task. Without the senior's consent to share results, every sent task reads "sent". */
export type CaregiverTaskStatus = "sent" | "started" | "done" | "dismissed";
