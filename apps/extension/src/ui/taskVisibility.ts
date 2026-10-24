import type { PendingTask } from "../lib/backend";

/** Hide locally snoozed tasks for the lifetime of this side-panel session. */
export function filterSnoozedTasks(tasks: PendingTask[], snoozedTaskIds: ReadonlySet<string>): PendingTask[] {
  return tasks.filter((task) => !snoozedTaskIds.has(task.id));
}
