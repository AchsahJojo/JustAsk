import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Stale stepCounts, expired pairingCodes and expired handoffs.
crons.interval("hourly cleanup", { hours: 1 }, internal.cleanup.run, {});

export default crons;
