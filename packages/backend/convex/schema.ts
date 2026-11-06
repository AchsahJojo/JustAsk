import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { deviceKind, recipeValidator, voiceKind } from "./validators";

export default defineSchema({
  // Convex Auth: users, sessions, accounts, refresh tokens. Only caregivers sign in this way.
  ...authTables,
  // One row per caregiver account, created on first sign-in (`caregivers:ensureProfile`).
  // `userId` is unset only for dev seed rows that have no login.
  caregivers: defineTable({
    userId: v.optional(v.id("users")),
    name: v.string(),
    email: v.optional(v.string()),
    // Legacy (pre-Convex Auth seed rows). Cleared by `npx convex run migrations:caregiversToAuth`; remove after.
    tokenIdentifier: v.optional(v.string()),
  }).index("by_user", ["userId"]),
  // "The user's account". A senior works on their own (`createdBy: "self"`, made by an install) or was set up by a
  // caregiver (`createdBy: "caregiver"`). Either way a caregiver is optional: careLinks may be empty.
  // Synced preferences live here (ARCHITECTURE.md §8).
  seniors: defineTable({
    name: v.string(),
    displayName: v.string(),
    consent: v.object({ notifyOnComplete: v.boolean(), notifyOnStuck: v.boolean() }),
    prefs: v.optional(v.object({ voice: voiceKind, rate: v.number(), showMeInstead: v.boolean() })),
    // Who last chose Show me instead: the user did, or a linked caregiver did.
    showMeSetBy: v.optional(v.union(v.literal("self"), v.literal("caregiver"))),
    createdBy: v.optional(v.union(v.literal("self"), v.literal("caregiver"))),
    createdAt: v.optional(v.number()),
  }),
  // `pendingSince`: a helper code was typed in the caregiver app, and the user hasn't said yes yet on their computer.
  // A pending link gives no access (lib.findLink ignores it). Dropped after a day by the cleanup cron.
  careLinks: defineTable({
    caregiverId: v.id("caregivers"),
    seniorId: v.id("seniors"),
    relation: v.string(),
    linkedAt: v.optional(v.number()),
    pendingSince: v.optional(v.number()),
  })
    .index("by_pendingSince", ["pendingSince"])
    .index("by_caregiver", ["caregiverId"])
    .index("by_senior", ["seniorId"])
    .index("by_caregiver_and_senior", ["caregiverId", "seniorId"]),
  // When two profiles merge (see lib.mergeSenior), the deleted id points at the one that was kept,
  // so a caregiver's open page can follow it.
  seniorAliases: defineTable({ from: v.string(), to: v.id("seniors") })
    .index("by_from", ["from"])
    .index("by_to", ["to"]),
  // 6-digit single-use codes. Missing `purpose` = "device" (legacy caregiver pairing codes).
  pairingCodes: defineTable({
    seniorId: v.id("seniors"),
    code: v.string(),
    expiresAt: v.number(),
    purpose: v.optional(v.union(v.literal("device"), v.literal("caregiver"))),
    createdByDeviceId: v.optional(v.id("devices")),
    machineId: v.optional(v.string()),
  })
    .index("by_code", ["code"])
    .index("by_senior", ["seniorId"])
    .index("by_expiresAt", ["expiresAt"]),
  // One row per install. Only the token hash is stored. Legacy rows have no `kind` (= extension).
  devices: defineTable({
    seniorId: v.id("seniors"),
    tokenHash: v.string(),
    pairedAt: v.number(),
    kind: v.optional(deviceKind),
    platform: v.optional(v.string()),
    label: v.optional(v.string()),
    machineId: v.optional(v.string()),
    lastSeenAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    // Waiting for the user to press Allow on a computer they already use (a caregiver's code typed on a
    // new computer after the first one). `joinSeniorId` is the account it wants to join; `seniorId` stays
    // the install's own account until then. A pending install's token works for nothing but devices:joinStatus.
    joinSeniorId: v.optional(v.id("seniors")),
    pendingSince: v.optional(v.number()),
  })
    .index("by_token", ["tokenHash"])
    .index("by_senior", ["seniorId"])
    .index("by_joinSeniorId", ["joinSeniorId"])
    .index("by_pendingSince", ["pendingSince"]),
  tasks: defineTable({
    seniorId: v.id("seniors"),
    assignedBy: v.id("caregivers"),
    title: v.string(),
    spokenPrompt: v.string(),
    recipe: v.optional(recipeValidator),
    status: v.union(v.literal("pending"), v.literal("active"), v.literal("done"), v.literal("dismissed")),
    createdAt: v.number(),
    // When it became done. Older rows have none; readers fall back to createdAt.
    doneAt: v.optional(v.number()),
    // Last time a run touched it (started, or any session event). The cleanup cron sends a task that sat
    // "active" with no word for 2 hours back to pending (the browser closed mid-task).
    touchedAt: v.optional(v.number()),
    // How the last run ended, so the caregiver can see more than "Sent": deferred (put off, for example
    // no code yet), blocked (paused for safety or trouble), loop, abandoned.
    lastOutcome: v.optional(v.string()),
  })
    .index("by_senior_status", ["seniorId", "status"])
    .index("by_status_and_touchedAt", ["status", "touchedAt"])
    .index("by_assigner", ["assignedBy"]),
  // A task the check said is clear (taskCheck:review). tasks:assign sends only from one of these,
  // so a vague task can't reach the older adult. Deleted when sent, or after an hour.
  taskChecks: defineTable({
    caregiverId: v.id("caregivers"),
    seniorId: v.id("seniors"),
    title: v.string(),
    spokenPrompt: v.string(),
    recipe: v.optional(recipeValidator),
    expiresAt: v.number(),
  }).index("by_expiresAt", ["expiresAt"]),
  sessions: defineTable({
    seniorId: v.id("seniors"),
    taskId: v.optional(v.id("tasks")),
    deviceId: v.optional(v.id("devices")),
    request: v.string(),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    outcome: v.optional(v.string()),
    // The caregiver already heard "got stuck" for this run: one note per run, however many presses.
    notifiedStuck: v.optional(v.boolean()),
  }).index("by_senior", ["seniorId"]),
  // Only events are stored. Snapshots are never written to tables or logs.
  events: defineTable({
    sessionId: v.id("sessions"),
    type: v.string(),
    at: v.number(),
    latencyMs: v.optional(v.number()),
  }).index("by_session", ["sessionId"]),
  // Per-device step budget (plan §3.7 runaway cost).
  stepCounts: defineTable({ deviceId: v.id("devices"), hour: v.number(), count: v.number() })
    .index("by_device_hour", ["deviceId", "hour"])
    .index("by_hour", ["hour"]),
  notifications: defineTable({ toCaregiverId: v.id("caregivers"), seniorId: v.optional(v.id("seniors")), text: v.string(), at: v.number(), read: v.boolean() }).index(
    "by_caregiver",
    ["toCaregiverId"],
  ),
  // Moves one session between the extension and the desktop app on the same machine (§9).
  // Carries only request, taskId, recipe and a fixed note. Never page content.
  handoffs: defineTable({
    seniorId: v.id("seniors"),
    fromDeviceId: v.id("devices"),
    toKind: deviceKind,
    toMachineId: v.optional(v.string()),
    request: v.string(),
    taskId: v.optional(v.id("tasks")),
    recipe: v.optional(recipeValidator),
    note: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    claimedByDeviceId: v.optional(v.id("devices")),
    claimedAt: v.optional(v.number()),
  })
    .index("by_senior_and_toKind_and_expiresAt", ["seniorId", "toKind", "expiresAt"])
    .index("by_expiresAt", ["expiresAt"]),
});
