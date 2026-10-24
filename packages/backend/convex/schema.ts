import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Caregivers. Convex Auth adds its own tables when wired up (see docs/MANUAL_SETUP.md).
  caregivers: defineTable({ tokenIdentifier: v.string(), name: v.string(), email: v.optional(v.string()) }).index("by_token", ["tokenIdentifier"]),
  seniors: defineTable({
    name: v.string(),
    displayName: v.string(),
    consent: v.object({ notifyOnComplete: v.boolean(), notifyOnStuck: v.boolean() }),
  }),
  careLinks: defineTable({ caregiverId: v.id("caregivers"), seniorId: v.id("seniors"), relation: v.string() })
    .index("by_caregiver", ["caregiverId"])
    .index("by_senior", ["seniorId"]),
  pairingCodes: defineTable({ seniorId: v.id("seniors"), code: v.string(), expiresAt: v.number() }).index("by_code", ["code"]),
  devices: defineTable({ seniorId: v.id("seniors"), tokenHash: v.string(), pairedAt: v.number() }).index("by_token", ["tokenHash"]),
  tasks: defineTable({
    seniorId: v.id("seniors"),
    assignedBy: v.id("caregivers"),
    title: v.string(),
    spokenPrompt: v.string(),
    recipe: v.optional(v.object({ startUrl: v.optional(v.string()), steps: v.array(v.string()) })),
    status: v.union(v.literal("pending"), v.literal("active"), v.literal("done"), v.literal("dismissed")),
    createdAt: v.number(),
  }).index("by_senior_status", ["seniorId", "status"]),
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
  notifications: defineTable({ toCaregiverId: v.id("caregivers"), text: v.string(), at: v.number(), read: v.boolean() }).index("by_caregiver", ["toCaregiverId"]),
});
