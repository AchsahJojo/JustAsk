/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accounts from "../accounts.js";
import type * as auth from "../auth.js";
import type * as careLinks from "../careLinks.js";
import type * as cleanup from "../cleanup.js";
import type * as crons from "../crons.js";
import type * as devSeed from "../devSeed.js";
import type * as devices from "../devices.js";
import type * as handoffs from "../handoffs.js";
import type * as http from "../http.js";
import type * as lib from "../lib.js";
import type * as plan from "../plan.js";
import type * as prefs from "../prefs.js";
import type * as rateLimits from "../rateLimits.js";
import type * as sessions from "../sessions.js";
import type * as tasks from "../tasks.js";
import type * as validators from "../validators.js";
import type * as voice from "../voice.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounts: typeof accounts;
  auth: typeof auth;
  careLinks: typeof careLinks;
  cleanup: typeof cleanup;
  crons: typeof crons;
  devSeed: typeof devSeed;
  devices: typeof devices;
  handoffs: typeof handoffs;
  http: typeof http;
  lib: typeof lib;
  plan: typeof plan;
  prefs: typeof prefs;
  rateLimits: typeof rateLimits;
  sessions: typeof sessions;
  tasks: typeof tasks;
  validators: typeof validators;
  voice: typeof voice;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
