import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { deviceKind, recipeValidator, voiceKind } from "./validators";

export default defineSchema({
  // Caregivers. Convex Auth adds its own tables when wired up (see docs/MANUAL_SETUP.md).
  caregivers: defineTable({ tokenIdentifier: v.string(), name: v.string(), email: v.optional(v.string()) }).index("by_token", ["tokenIdentifier"]),
  // "Her account". Synced preferences live here (ARCHITECTURE.md §8).
  seniors: defineTable({
    name: v.string(),
    displayName: v.string(),
    consent: v.object({ notifyOnComplete: v.boolean(), notifyOnStuck: v.boolean() }),
    prefs: v.optional(v.object({ voice: voiceKind, rate: v.number(), showMeInstead: v.boolean() })),
    createdBy: v.optional(v.union(v.literal("self"), v.literal("caregiver"))),
  }),
  careLinks: defineTable({ caregiverId: v.id("caregivers"), seniorId: v.id("seniors"), relation: v.string() })
    .index("by_caregiver", ["caregiverId"])
    .index("by_senior", ["seniorId"])
    .index("by_caregiver_and_senior", ["caregiverId", "seniorId"]),
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
  })
    .index("by_token", ["tokenHash"])
    .index("by_senior", ["seniorId"]),
  tasks: defineTable({
    seniorId: v.id("seniors"),
    assignedBy: v.id("caregivers"),
    title: v.string(),
    spokenPrompt: v.string(),
    recipe: v.optional(recipeValidator),
    status: v.union(v.literal("pending"), v.literal("active"), v.literal("done"), v.literal("dismissed")),
    createdAt: v.number(),
  }).index("by_senior_status", ["seniorId", "status"]),
  sessions: defineTable({
    seniorId: v.id("seniors"),
    taskId: v.optional(v.id("tasks")),
    deviceId: v.optional(v.id("devices")),
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
  stepCounts: defineTable({ deviceId: v.id("devices"), hour: v.number(), count: v.number() })
    .index("by_device_hour", ["deviceId", "hour"])
    .index("by_hour", ["hour"]),
  notifications: defineTable({ toCaregiverId: v.id("caregivers"), text: v.string(), at: v.number(), read: v.boolean() }).index("by_caregiver", ["toCaregiverId"]),
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
