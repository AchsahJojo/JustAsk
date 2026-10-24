import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

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
  // A senior works on their own (`origin: "self"`, created by the extension) or was set up by a caregiver
  // (`origin: "caregiver"`). Either way a caregiver is optional: careLinks may be empty.
  seniors: defineTable({
    name: v.string(),
    displayName: v.string(),
    consent: v.object({ notifyOnComplete: v.boolean(), notifyOnStuck: v.boolean() }),
    origin: v.optional(v.union(v.literal("self"), v.literal("caregiver"))),
    createdAt: v.optional(v.number()),
    // "Type it for me" on search boxes. Unset until she (or a linked caregiver) chooses.
    assistTyping: v.optional(v.boolean()),
    assistSetBy: v.optional(v.union(v.literal("self"), v.literal("caregiver"))),
  }),
  careLinks: defineTable({ caregiverId: v.id("caregivers"), seniorId: v.id("seniors"), relation: v.string(), linkedAt: v.optional(v.number()) })
    .index("by_caregiver", ["caregiverId"])
    .index("by_senior", ["seniorId"]),
  // When two profiles merge (see lib.mergeSenior), the deleted id points at the one that was kept,
  // so a caregiver's open page can follow it.
  seniorAliases: defineTable({ from: v.string(), to: v.id("seniors") }).index("by_from", ["from"])
    .index("by_to", ["to"]),
  pairingCodes: defineTable({ seniorId: v.id("seniors"), code: v.string(), expiresAt: v.number() })
    .index("by_code", ["code"])
    .index("by_senior", ["seniorId"]),
  devices: defineTable({ seniorId: v.id("seniors"), tokenHash: v.string(), pairedAt: v.number() })
    .index("by_token", ["tokenHash"])
    .index("by_senior", ["seniorId"]),
  tasks: defineTable({
    seniorId: v.id("seniors"),
    assignedBy: v.id("caregivers"),
    title: v.string(),
    spokenPrompt: v.string(),
    recipe: v.optional(v.object({ startUrl: v.optional(v.string()), steps: v.array(v.string()) })),
    status: v.union(v.literal("pending"), v.literal("active"), v.literal("done"), v.literal("dismissed")),
    createdAt: v.number(),
  })
    .index("by_senior_status", ["seniorId", "status"])
    .index("by_assigner", ["assignedBy"]),
  sessions: defineTable({
    seniorId: v.id("seniors"),
    taskId: v.optional(v.id("tasks")),
    request: v.string(),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    outcome: v.optional(v.string()),
  }).index("by_senior", ["seniorId"]),
  // Only events are stored. Snapshots are never written to tables or logs.
  events: defineTable({
    sessionId: v.id("sessions"),
    type: v.string(),
    at: v.number(),
    latencyMs: v.optional(v.number()),
  }).index("by_session", ["sessionId"]),
  // Per-device step budget (plan §3.7 runaway cost).
  stepCounts: defineTable({ deviceId: v.id("devices"), hour: v.number(), count: v.number() }).index("by_device_hour", ["deviceId", "hour"]),
  // Global hourly counters for unauthenticated endpoints: standalone sign-ups and failed pairing codes.
  hourlyCounts: defineTable({ kind: v.string(), hour: v.number(), count: v.number() }).index("by_kind_hour", ["kind", "hour"]),
  notifications: defineTable({ toCaregiverId: v.id("caregivers"), seniorId: v.optional(v.id("seniors")), text: v.string(), at: v.number(), read: v.boolean() }).index(
    "by_caregiver",
    ["toCaregiverId"],
  ),
});
