import { describe, expect, it } from "vitest";
import { filterSnoozedTasks } from "../src/ui/taskVisibility";
import type { PendingTask } from "../src/lib/backend";

const task = (id: string): PendingTask => ({ id, title: `Task ${id}`, spokenPrompt: "Help me", recipe: null, from: "Sam" });

describe("filterSnoozedTasks", () => {
  it("keeps a task hidden when a live refresh returns it again", () => {
    const snoozed = new Set(["later"]);

    expect(filterSnoozedTasks([task("later"), task("next")], snoozed).map((x) => x.id)).toEqual(["next"]);
    expect(filterSnoozedTasks([task("later")], snoozed)).toEqual([]);
  });

  it("shows unsnoozed tasks and leaves the source list unchanged", () => {
    const tasks = [task("a"), task("b")];
    expect(filterSnoozedTasks(tasks, new Set())).toEqual(tasks);
    expect(tasks.map((x) => x.id)).toEqual(["a", "b"]);
  });
});
