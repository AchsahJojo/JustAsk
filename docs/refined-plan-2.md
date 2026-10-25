# JustAsk — Refined Plan 2

> Superseded for drive mode by docs/refined-plan-3.md (guide only).

## Context

This builds on `docs/refined-plan-1.md` and states only what changes. The system design these changes fit into is in `docs/ARCHITECTURE.md`, and section numbers like "§10" below refer to that document.

Testing the v1 extension on real sites found three problems:
1. Stuck "still opening, please wait" messages.
2. Nonsense steps, such as "Shop by room" for a water bottle.
3. No help with clicking and typing.

The product also needs accounts synced across installs.

This plan fixes those problems and splits the work across parallel Claude agents, with each agent owning its own paths.

**Decisions (2026-10-24)**
- **Drive by default.** JustAsk clicks, types, picks and submits for the user as much as is reasonable. It never types, stores or reads sensitive data: passwords, one-time codes, card numbers, SSNs and bank details. Those steps fall back to guiding the user. Normal app-safety gates apply.
- **Desktop app.** A companion app plus native guidance for a few high-value apps, chosen from senior-usage data (`ARCHITECTURE.md` §9). It is not a helper for every app.
- **Accounts.** The account is the user's profile. Each install joins it with a 6-digit code from any linked install or a caregiver. No passwords.
- **Teammates own `apps/caregiver`.** Agents never edit it.

## Changes to refined plan 1

1. **Guide mode becomes drive mode** (`ARCHITECTURE.md` §11). This reverses "No 'do it for me' this weekend". Guiding stays in three places: as the fallback for sensitive fields, as the fallback for failed actions, and as the **Show me instead** setting.
2. **The desktop app moves into the hackathon:** the companion app plus Windows native guidance for 3 target apps (Settings, Zoom, the print dialog). macOS only if a teammate has a Mac.
3. **Accounts become "the user's account, add installs by code"**, plus handoffs between the extension and the desktop app (§8, §9).
4. **The prompt changes:**
   - act by default, and guide for sensitive fields
   - use the search box first for specific things
   - no bias toward opening menus
   - history lines name the page
4. **The P1 and P2 root-cause fixes** (§10) are in scope.
5. **The prompt eval becomes a deliverable** (§12).
6. **Backend work uses Convex built-ins first** (`ARCHITECTURE.md` §8, "Backend: use Convex built-ins"): realtime queries, scheduled functions, crons, the rate-limiter component and convex-test.
7. **Decisions taken from the agents' plans:**
   - `devices:redeemCode` and `careLinks:redeemHelperCode` return `null` for a wrong code instead of throwing, so the failure count is saved.
   - New function `devices:peekCode({code}) → {displayName} | null`.
   - Only click and submit actions count toward the switch to guide mode after 3 actions that change nothing.
   - The duplicate check includes the nearby heading, so several "Add to cart" buttons survive.
   - The "payment iframe" sensitive-field rule is dropped. `cc-*` autocomplete covers it.

## Wave 0: contracts and scaffolds

One person does this wave, in order, in about an hour. After it, `packages/shared` is **frozen**. Agents request changes instead of editing them.

### `packages/shared`
- `StepKind` gains `"act"`.
- `Expect` gains `"scroll"` and `"submit"`.
- `StepResponse` gains `text: string | null`.
- `checkStep`:
  - an `act` with `type` needs `text`
  - an `act` never targets a `sensitive` field with `type`, `choose` or `submit`
- `FieldInfo` gains `sensitive?`.
- New messages:
  - `ja:act {localId, expect, text, option}`, which replies `{ok}`
  - `ja:watch {on}`

### `packages/core`
- `PageBridge` gains `act(ref, action)` and `watch(on)`.
- `Phase` gains `"acting"`.
- Stub implementations go in `ExtensionBridge` and the test fakes, so everything compiles.

### Mock planner
`lib/mockPlanner.ts` defaults `text: null`, so the existing guide-step e2e stays green.

### Convex API (names and signatures only)
The extension agent codes against these function names as strings, the same way `apps/extension/src/lib/backend.ts` already does. Here `device` is `{kind, platform, label}`.

| Function | Who calls it | Returns |
|---|---|---|
| `accounts:createSelf({displayName, device})` | first install | `{token}` |
| `devices:createLinkCode({token})` | a linked install | `{code, expiresAt}` |
| `devices:redeemCode({code, device?})` | a new install | `{token, displayName}` |
| `devices:list({token})`, `devices:revoke({token, deviceId})`, `devices:heartbeat({token})` | any install | — |
| `prefs:get({token})`, `prefs:set({token, voice?, rate?, consent?, showMeInstead?})` | any install | — |
| `handoffs:create({token, toKind, request, taskId?, recipe?})` | extension or desktop | `{handoffId}` |
| `handoffs:claim({token, handoffId})` | the receiving install | `{request, taskId, recipe}` or `null` |
| `handoffs:pendingForDevice({token})` | desktop app (live query) | — |
| `careLinks:createHelperCode({token})` | the user's install | `{code}` |
| `careLinks:redeemHelperCode({code})` | caregiver web app (auth) | — |
| `voice:cartesiaToken({token})` | any install | a short-lived token |

### `CLAUDE.md`
- "Guide mode only" is replaced by the drive-mode rule (`ARCHITECTURE.md` §2, rule 1).
- The leak test still applies: JustAsk never reads field values.
- No site-specific code.
- Agents stay inside the paths they own.

### Done when
`npm test` passes, e2e passes, and the extension builds. Behavior is unchanged.

## Wave 1: agents in parallel

Each agent works in its own git worktree, on its own branch `agent/<name>`. Agents commit there and never push.

| # | Agent | Owns (writes only here) | Delivers | Done when |
|---|---|---|---|---|
| 1 | page-agent | `packages/page-agent/**`, `apps/extension/src/entrypoints/content.ts`, new pages in `apps/fixtures/public/` | P2 scanner fixes; the `sensitive` classifier; the `act` executor (click, type, choose, submit, scroll) with the `ja:acted` reply; P1 `watch` (reports page changes) | unit tests for each fix; `npm test` green |
| 2 | core-loop | `packages/core/**`, `packages/backend/lib/**`, `apps/fixtures/mock-script.json` | P1 re-check while waiting; the `act` flow (acting phase, the beat, fallback to guide, text gates, personal-data guard, switch to guide after 3 no-change actions); the drive-mode prompt rewrite; spoken lines | controller and planStep tests green |
| 3 | accounts-backend | `packages/backend/convex/**` (except Convex Auth wiring), `packages/backend/test/**` | schema changes (device fields, preferences, code purpose); the Wave 0 API; rate limits; the caregiver API kept stable | `convex-test` suite and `tsc` green; local deployment only |
| 4 | extension-shell | `apps/extension/src/**` except `content.ts` | live `ConvexClient` subscriptions; create-account and add-device setup; preference sync (including **Show me instead**); real `act` and `watch` in the bridge; panel UI for the acting phase; dev-only snapshot capture | builds; unit tests; loads by hand |
| 5 | eval | `eval/**`, `docs/eval.md` | capture with Puppeteer, which injects `page-agent` directly (no extension needed); the runner; the report | `npm run eval` prints accuracy and latency |

### Rules for every agent
- Never edit `apps/caregiver` (teammates), `packages/shared`, or another agent's paths.
- Don't run e2e. The ports are shared, so integration runs it.
- Never push to the shared cloud dev Convex deployment.
- New npm dependencies go only in your own workspace's `package.json`. Integration regenerates `package-lock.json`.
- Follow `CLAUDE.md`. Keep modules small, with doc comments on exported functions.

### Each agent's brief contains
- the goal
- owned and forbidden paths
- the contracts it codes against
- the tests to run
- the definition of done

### Each agent reports back
- what it changed
- the tests it ran
- open questions
- any contract changes it needs

## Wave 2: integration

1. Merge in this order: 1 and 2, then 3, then 4, then 5. Regenerate the lockfile.
2. Run `npm test` and every build.
3. Add e2e scenarios:
   - the composer that loads its editor late (P1)
   - the off-canvas drawer modal (P2)
   - a driven store search plus add-to-cart
   - a login form: the password is guided, never typed
   - a payment form: asks first, and card entry is guided
   - the injection banner
   - the sentinel leak test, with drive mode on
4. Push functions to dev Convex, then run `npm run test:convex`.
5. Run the eval before and after the prompt and scanner changes. Pick the model and effort from the data.
6. Update `docs/MANUAL_SETUP.md`.

## Timeline (Saturday, adjustable)

| When | What |
|---|---|
| 12–1 PM | Wave 0 |
| 1–6 PM | Wave 1 |
| 6–9 PM | Wave 2, then feature freeze |
| Sunday morning | rehearse; submit around noon |

The demo adds a store search and add-to-cart to the refill flow, stopping to ask before checkout.

## Prerequisites before Wave 1

- **Move the repo out of OneDrive, or pause sync.** Every worktree gets its own `node_modules`, and syncing them is slow and can lock files on Windows.
- **Agree with the teammates who wires Convex Auth** (`auth.ts` providers, `authTables`, the HTTP routes). The caregiver app needs it. Default: the teammates own it, and the accounts agent skips it.
- **Confirm that agents may commit to `agent/*` branches**, and that these are merged into `feature/xander` locally. Nothing is pushed.

## Open questions

- How long should the beat before each action be? 1 s is the default. Should a caregiver be able to change it?
- Should **Show me instead** be on by default for new accounts, so seniors learn first?
