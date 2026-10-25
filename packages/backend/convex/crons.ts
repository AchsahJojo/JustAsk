import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Stale stepCounts and expired pairingCodes.
crons.interval("hourly cleanup", { hours: 1 }, internal.cleanup.run, {});

export default crons;
