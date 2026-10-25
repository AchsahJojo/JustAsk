# JustAsk — System Architecture

The detailed map of the system: what runs where, how one step flows, the contracts between parts, and where new code goes. For the short version read [`HOW-IT-WORKS.md`](HOW-IT-WORKS.md) first. How to ship it: [`DEPLOY.md`](DEPLOY.md). What's done and missing: [`STATUS.md`](STATUS.md).

This describes the code on `main` as of `a4cc91c` (final scope: **Chrome extension + caregiver web app + Convex, guide only**). The history and reasons are in `initial-plan.md` and `refined-plan-1/2/3.md`. `refined-plan-3.md` dropped drive mode and the desktop app.

## 1. The product

- **The user** (an older adult) presses one big button and says what they want: "help me refill my prescription".
- **JustAsk** reads the page, puts a glowing box around the one thing to use next, and says one short line in a calm voice (Cartesia). The user clicks, types or chooses. JustAsk sees it and gives the next step, until "All done, you did it!"
- **Guide only.** JustAsk never clicks, types, chooses or submits for the user. The one thing it does on its own is a web search on an empty tab, after the user says yes.
- **A caregiver is optional.** They can set JustAsk up for the user, send tasks with a plain-language recipe, and get a note when a task is finished, only if the user agrees.

## 2. Ground rules

`CLAUDE.md` is the enforced copy of these rules. Change both together.

1. **Guide only.** The core acts only with `allowDrive: true`, and the extension never sets it. Drive-mode code (`act` steps, `packages/page-agent/src/act.ts`) is kept but switched off.
2. **Sensitive fields are never read or stored:** passwords, one-time codes, card numbers and CVV, SSN, bank fields. JustAsk highlights them and says it can't see them.
3. **Risk steps ask first** (`money`, `personal_info`, `account_change`), naming exactly what would be pressed and where. `suspicious` blocks.
4. **Scam check** on the user's own words before anything happens (`packages/core/src/scam.ts`).
5. **Claude returns an element number** for the current snapshot. Never a selector or coordinates.
6. **No navigation to URLs Claude produced.** Only the recipe's `https://` start page, links the user clicks, or (on an empty tab, after a yes) a web search with their default search engine.
7. **No field values leave the page.** Only the booleans `hasValue`, `valid`, `matched` and `sensitive` do, plus a count of entries added as chips. Text the user typed (including chip text) is never sent.
8. **Page text is untrusted data,** inside `<page_content>` in the prompt.
9. **No API keys in client code.** Anthropic and Cartesia keys live only in Convex env.
10. **No site-specific code.** Fixtures are tests, not special cases.
11. **Shared types come only from `packages/shared`.** The Zod `StepResponse` is the single source for the JSON Schema.
12. **Platform APIs stay in their layers.** Browser APIs in `apps/extension` (browser-specific calls in `src/platform`). `packages/voice` may use WebSocket, Web Audio and the microphone. `packages/core` and `packages/page-agent` stay platform-free (page-agent may use the DOM).
13. **Snapshots are never written to Convex tables or logs.** Only `events` are stored.

## 3. System context

```
 the user's computer (Chrome) ─────────────────────────────────────────
 │ Side panel (React)                                                 │
 │  SessionHost → core.SessionController                              │
 │  ExtensionBridge   HttpPlanner   voice: CartesiaSpeech/Listener    │
 │      │ scan/settle/highlight            │ Sonic TTS, ink-whisper   │
 │ ┌────▼──────────────────────────┐      │ (WebSocket, short token) │
 │ │ Content script in every frame │      ▼                          │
 │ │  page-agent.PageAgent         │   Cartesia                      │
 │ └───────────────────────────────┘                                 │
 │ Setup page: account, consent, helpers, devices                     │
 │ Background worker: task alarm, badge, notifications, link fragments│
 └───────┬──────────────────────────────────────────────────────────┘
         │ POST /plan, /search-query (HTTPS) · Convex queries/mutations (device token)
  ┌──────▼─────────────────────────────────────────────────────────┐
  │ Convex: /plan → planStep → Claude · /search-query → Claude      │
  │ accounts, devices, pairing, careLinks, tasks, taskCheck, prefs, │
  │ sessions/events, notifications, voice tokens, rate limits, cron │
  └──────▲─────────────────────────────────────────────────────────┘
         │ Convex Auth (email + password)
  ┌──────┴──────────────────────┐
  │ Caregiver web app (Vercel)  │  people, setup codes, task composer
  └─────────────────────────────┘  (Claude task check), activity feed
```

- Only Convex calls Claude: `packages/backend/lib/planStep.ts` (steps), `searchQuery.ts` (web search words), `taskCheck.ts` (caregiver task check). All use `claude-opus-5-5`, effort `low`, JSON-schema output and server-side fallbacks.
- The side panel owns the session, because it survives page loads. Content scripts hold no state and are injected again on every load.
- The background service worker is stopped when idle, so it only handles alarms, the badge, notifications and link fragments, and polls with `ConvexHttpClient`. The side panel uses live `ConvexClient` subscriptions.

## 4. Code map

| Path | Owns | Runs in |
|---|---|---|
| `packages/shared` | Zod contracts: `PageSnapshot`, `StepResponse` (+ JSON Schema), `checkStep`, `PlanRequest`/`PlanResponse`, `QueryRequest`/`QueryResponse`, messages, `EventType`, caregiver task limits and `TaskDraft` | everywhere |
| `packages/core` | `SessionController` (state machine, step loop, gates), `mergeScans`, the prompt, voice commands, spoken lines, `scamCheck`, `searchQueryFor`, `gateAct` | side panel, Convex (prompt only), tests |
| `packages/page-agent` | scanner and ranker, visibility, `sensitive` classifier, chips (`chipsOf`), fingerprint, overlay ring, `PageAgent` (observers, `settle`, `waitForChange`, `watch`) | content script, happy-dom tests |
| `packages/voice` | `CartesiaSpeech` (Sonic TTS), `CartesiaListener` (ink-whisper STT, `TurnTimer`), `CartesiaTokens` | side panel, setup page, caregiver app |
| `packages/backend` | Convex schema and functions; `lib/planStep.ts`, `lib/searchQuery.ts`, `lib/taskCheck.ts`; `dev/server.ts` (local planner) | Convex, Node |
| `apps/extension` | WXT: `entrypoints/` (background, content, sidepanel, setup), `lib/` (`SessionHost`, `ExtensionBridge`, `HttpPlanner`, backend client, live subscriptions, prefs, voice wiring), `ui/`, `platform/` | Chrome |
| `apps/caregiver` | Vite + React: sign-in, people, setup wizard, `TaskComposer`, activity, install page | browser (Vercel) |
| `apps/fixtures`, `e2e/` | mock pharmacy and test pages (:5174, :5175), `mock-script.json`, Puppeteer e2e | Node, Vercel |
| `eval/` | prompt eval: capture snapshots from fixtures, run them against Claude, report | Node |
| `scripts/deploy.mjs` | one-command deploy (`docs/DEPLOY.md`) | Node |

## 5. One step, end to end

1. **Start.** `SessionHost.start` ([session.ts](../apps/extension/src/lib/session.ts)) starts a Convex session and calls `controller.start`.
   - **Scam check** runs on the request first (§8).
   - A caregiver recipe's `startUrl` opens in the session tab.
   - **Empty tab** (New Tab, `about:blank`) with no start page: JustAsk asks "Do you want me to search the web for that?". Yes searches with `chrome.search.query` in that tab, using words from `POST /search-query` (Claude rewrites only the user's request: "I want to buy a pink owala on Amazon" becomes "pink owala water bottle amazon"; it falls back to `searchQueryFor` if that fails). No waits until the user opens a site.
2. **Settle.** `ExtensionBridge.scan` ([bridge.ts](../apps/extension/src/lib/bridge.ts)) sends `ja:settle` to the top frame first: it waits until the page is loaded, its DOM has been quiet for 0.7 s, and nothing is `aria-busy` (4 s at most). Then it sends `ja:scan` to every frame.
3. **Scan.** `scanDocument` ([scanner.ts](../packages/page-agent/src/scanner.ts)) walks the composed tree (open and closed shadow roots), applies the visibility and modal rules, flags sensitive fields, counts chips, ranks and keeps 150. Page text is any visible text, on-screen first, never typed text. Child frames under 50×50 skip themselves.
4. **Merge.** `mergeScans` ([merge.ts](../packages/core/src/merge.ts)) numbers everything into one `PageSnapshot` and maps each number to `(frameId, localId)`. Over 150, all frames are ranked together (`crossFrameScore`).
5. **Plan.** `HttpPlanner` POSTs `/plan`. Convex ([http.ts](../packages/backend/convex/http.ts) → `runPlan` in [plan.ts](../packages/backend/convex/plan.ts)) checks the device token and the 60-steps-per-hour budget (`devices:consumeStep`), then `planStep` calls Claude. The planner runs in-process, so page text is never a Convex function argument.
6. **Check.** The controller drops replies for a stale `snapshotId`. `checkStep` ([step.ts](../packages/shared/src/step.ts)) enforces what the schema can't (the number exists, choose options exist, `say` is 20 words or fewer). On failure: one re-plan with `retryNote`, then `blocked`.
7. **Handle.** `handleStep` ([controller.ts](../packages/core/src/controller.ts)):
   - `act` and `guide` both become **guide** (no `allowDrive`). A risk step asks first, naming what would be pressed and the site.
   - **guide:** `PageAgent.highlight` re-finds the element (WeakRef, then fingerprint, then role + text) and draws a top-layer ring with click, typing and choice observers. If the element is swapped or collapses, the ring hides and follows the replacement, or reports `ja:lost`.
   - `clarify`, `wait`, `done`, `blocked`: the phases `asking`, `waiting`, `done`, `blocked`.
8. **The user acts.** The page agent sends `ja:step-done`, `ja:wrong` or `ja:lost`. "I'm done typing" checks the field really has a value (or chips).
9. **Verify.** `verifying` waits for a navigation or a quiet DOM (600 ms; 4 s at most after a click, 0.7 s after typing), then plans the next step. Each step is logged as an outcome event.

```
idle ─start→ [scam? confirming] → [empty tab? confirming(search)] → planning
planning ─guide→ guiding ─step-done→ verifying → planning
         ├─guide+risk→ confirming ─yes→ guiding │ ─no→ done
         ├─clarify→ asking ─answer→ planning
         ├─wait→ waiting ─(page change | "I'm ready" | voice)→ planning
         ├─done→ done      └─blocked→ blocked
any active ─(other tab | can't see | empty tab | tab closed)→ paused ─resume→ planning
any ─Stop→ idle
```

Caps: 40 steps per session, 60 Claude calls per device per hour.

## 6. Contracts

Change these only in `packages/shared`, then update every implementer.

- **`StepResponse`** ([step.ts](../packages/shared/src/step.ts)): `{kind, say, target, expect, option, text, risk}`.
  - `kind`: `act` (kept, gated off) | `guide` | `clarify` | `wait` | `done` | `blocked`.
  - `expect`: `click` | `type` | `choose` | `hover` | `file` | `scroll` | `submit` | null.
  - `risk`: `none` | `money` | `personal_info` | `account_change` | `suspicious`.
- **`PageSnapshot`** ([snapshot.ts](../packages/shared/src/snapshot.ts)): stripped `url`, `title`, `heading`, `pageText` (2,000 characters per frame, 2,400 merged), `elements[]` (`n`, `role`, `text`, `label`, `nearby`, `color`, `big`, `disabled`, `inModal`, `inViewport`, `region`, `field{kind, hasValue, valid, options, optionCount, checked, formatHint, sensitive, items}`), `omitted{count, regions}`, `surface`.
- **Messages** ([messages.ts](../packages/shared/src/messages.ts)):
  - to the content script: `ja:ping`, `ja:settle`, `ja:scan`, `ja:highlight`, `ja:clear`, `ja:pulse`, `ja:watch`, `ja:wait-change`, `ja:banner`, `ja:act` (unused while guide only)
  - from it: `ja:step-done`, `ja:wrong`, `ja:lost`, `ja:clicked`, `ja:page-changed`, `ja:banner-start`
- **HTTP** (Convex HTTP actions): `POST /plan` (`PlanRequest` → `PlanResponse`), `POST /search-query` (`QueryRequest` → `QueryResponse`). Both take the device token and share the step budget.
- **Convex functions.** Device functions take the device `token` and call `requireDevice`. Caregiver functions use Convex Auth and call `requireCaregiver` / `requireLink`. The extension calls functions by string name ([backend.ts](../apps/extension/src/lib/backend.ts)); the caregiver app uses the generated `api`.

| Module | Device side (token) | Caregiver side (Convex Auth) |
|---|---|---|
| `accounts` | `createSelf` | |
| `devices` | `redeemCode` (merges with an existing account), `peekCode`, `createLinkCode`, `me`, `setDisplayName`, `setConsent`, `leaveHelpers`, `list`, `revoke`, `heartbeat` | `createSeniorWithCode`, `newCode`, `activeCode` |
| `careLinks` | `createHelperCode` | `redeemHelperCode` |
| `prefs` | `get`, `set` | |
| `tasks` | `pendingForDevice`, `listForDevice`, `setStatus` | `assign` (only a cleared check), `cancel` |
| `taskCheck` | | `review` (Claude: one question at a time until the task is clear) |
| `sessions` | `start`, `logEvent` | |
| `people`, `activity`, `caregivers` | | `list`, `get`, `update`, `setShowMe`, `remove`; `feed`, `markAllRead`; `me`, `ensureProfile`, `rename` |
| `voice` | `cartesiaToken` (STT + TTS) | `caregiverToken` (STT only, to speak a task) |
| `handoffs` | `create`, `claim`, `pendingForDevice` (kept from the desktop app, unused) | |

## 7. Data and privacy

| | What |
|---|---|
| Leaves the page | the snapshot (labels, visible text, booleans, chip counts), the user's request, history lines |
| Sent to Claude | the above for `/plan`; only the user's request for `/search-query`; only the caregiver's words for `taskCheck:review` |
| Stored in Convex | `seniors` (+ prefs, consent), `devices` (token hashes only), `pairingCodes`, `careLinks`, `seniorAliases`, `caregivers`, `tasks` (+ recipes), `taskChecks` (cleared drafts, 1 hour), `sessions` (request clipped to 200 characters), `events` (type, time, latency), `stepCounts`, `notifications`, `handoffs` |
| Never stored or logged | snapshots, page text, field values, chip text, voice audio |
| Logged | numbers only: stop reason, tokens, cache reads, check outcomes |

Caregivers see outcomes and counts, consent-gated, never page content or what the user asked for themselves.

## 8. Safety mechanisms

| Rule | How | Where |
|---|---|---|
| The user does every click | the core acts only with `allowDrive`; the extension never sets it | `core/src/controller.ts` |
| Sensitive fields | type, autocomplete, masked style, name and label rules; when unsure, sensitive | `page-agent/src/sensitive.ts` |
| No typed values | booleans only; chip text left out of page text, nearby text and names | `page-agent/src/scanner.ts` |
| Valid targets only | the number must exist in this snapshot | `shared/src/step.ts` |
| Ask before risk | yes/no with "Next, I'd show you “Place order” on pharmacy.example." | `core/src/controller.ts` |
| Scam check | gift cards, money to someone who called, remote access, sharing codes: one plain question, the user decides | `core/src/scam.ts` |
| Scam pages | the prompt marks them `suspicious`, which blocks | `core/src/prompt.ts` |
| Untrusted page text | inside `<page_content>` | `core/src/prompt.ts` |
| Clear caregiver tasks | `tasks:assign` needs a `taskChecks` row from `taskCheck:review` | `backend/convex/taskCheck.ts`, `tasks.ts` |
| Keys stay server-side | Claude and Cartesia keys in Convex env; clients get short-lived Cartesia tokens | `backend/convex/plan.ts`, `voice.ts` |
| Abuse limits | `@convex-dev/rate-limiter`: wrong codes (per prefix, global, per caregiver), account creation, voice tokens, task checks | `backend/convex/rateLimits.ts` |

## 9. Accounts and sync

- **One account per user:** a `seniors` row. Each install is a `devices` row with its own revocable token (only its hash is stored).
- **Joining:**
  - "I'm new: create my JustAsk" → `accounts:createSelf`. No caregiver needed.
  - "I have a code" (setup page) → `devices:redeemCode`. On a browser that already has an account, the two profiles merge and the user's own name, settings and history are kept; the caregiver's page follows via `seniorAliases`.
  - "Add another device" → `devices:createLinkCode` (6 digits, single use, 15 minutes).
- **Caregivers** sign in with email and password (Convex Auth). They link by making the user's profile and code in the wizard, or by typing a helper code the user shows in Settings ("Share with my helper" → `careLinks:redeemHelperCode`). Linking is shown on the user's side ("Your helpers", with Stop).
- **Sync:** voice, speech speed and consent live on the account (`prefs`). The side panel subscribes live to `tasks:listForDevice` and `prefs:get`; the background polls every minute for the badge and notifications.

## 10. Voice (Cartesia only)

- **Speaking:** Cartesia Sonic (`sonic-3`) over the TTS WebSocket, one request per line, raw float PCM played gap-free with Web Audio. The speed setting maps to `generation_config.speed`. Stop and new lines cancel the old context. Lines wait while the mic is open, so it never hears JustAsk.
- **Listening:** Cartesia `ink-whisper`, press-to-talk. Recording starts on the press; audio is buffered until the socket opens, so the first words aren't lost. A turn ends after 2 s of quiet (3 s to start, 30 s at most), measured from the mic level (`TurnTimer`).
- **Tokens:** `voice:cartesiaToken` mints a 10-minute token (STT + TTS) shared by both; the panel fetches it when it opens. The caregiver app gets an STT-only token to speak a task.
- **Fallback:** without a token (no account, or the service down) captions and typing keep working, and the panel says so. No browser speech APIs anywhere.
- **Voice choice:** `VITE_CARTESIA_VOICE_ID` at build time, else `DEFAULT_VOICE_ID` in `packages/voice/src/tts.ts`.

## 11. The caregiver app

- **Sign-in:** Convex Auth, email and password (no email verification or reset yet).
- **Add a person:** the wizard makes the profile and a 6-digit code with a countdown; the page turns "connected" live when the code is used. Or type the user's helper code.
- **Send a task:** describe it by typing or speaking. `taskCheck:review` asks one question at a time until it knows what, which one and where, then returns a draft (title, spoken prompt, `https://` start page, steps). The caregiver can edit it (it's checked again) and sends it with `tasks:assign`.
- **See outcomes:** the activity feed and the person page show finished and stuck notes and counts, only with the user's consent.
- **Install page:** `/install.html` hosts the extension zip and steps.

## 12. Backend: Convex built-ins

| Need | Convex feature |
|---|---|
| Live tasks, prefs, people and "connected" | realtime queries |
| Caregiver sign-in | Convex Auth (Password provider) |
| Rate limits | `@convex-dev/rate-limiter`; wrong codes return `null` instead of throwing, so the failure count is saved |
| Hourly cleanup of step counts, codes, handoffs | cron (`convex/crons.ts` → `cleanup:run`) |
| `/plan`, `/search-query` | HTTP actions |
| Tests | `convex-test` in memory, plus integration scripts against a local deployment |

Read `packages/backend/convex/_generated/ai/guidelines.md` before writing Convex code.

## 13. Problems found on real sites, and what fixed them

| Problem | Fix |
|---|---|
| "Still opening, please wait" stuck on composers | the page agent reports settled changes while waiting; re-plans only when the interactive elements change |
| Nonsense steps ("Shop by room" for a water bottle) | stricter visibility, real modals only, search boxes labelled, prompt: search first, no menu bias |
| Picks something that only shares a word ("Weather-inspired Halloween costumes") | prompt accuracy rules; answer from the screen when shown; page text includes cards built from divs and spans; the dev planner never quietly falls back to the word-matching mock |
| Reads results before they load | `ja:settle` before every scan |
| An email's To box looks empty after the address became a chip | chips count as filled (`items`), and the prompt moves on |
| The ring jumps to the top-left when a site swaps the editor | the ring hides on a zero-size or detached target and follows the replacement |
| Long dropdowns (50 states) hide the user's option | send the first 10 plus options matching their words |
| Iframe buttons crowded out by a busy page | cross-frame ranking over the 150 cap |

## 14. Testing and evaluation

| What | Command | Notes |
|---|---|---|
| Unit | `npm test` | Vitest + happy-dom, includes convex-test suites |
| Types | `npm run typecheck` | all workspaces |
| Extension e2e | `npm run test:e2e` | Puppeteer, fixtures on :5174/:5175, scripted planner on :8788 (`JUSTASK_MOCK=1`); `CONVEX_CODE=…` adds the accounts flow |
| Caregiver e2e | `npm run test:caregiver` | needs the caregiver app on :5176 and local Convex |
| Accounts / Convex | `npm run test:accounts`, `npm run test:convex` | against local Convex |
| Voice | `CONVEX_URL=… npm run test:voice` | live Cartesia check (needs `CARTESIA_API_KEY` on that deployment) |
| Prompt eval | `npm run eval:capture`, `npm run eval` | captured snapshots from fixtures; accuracy, latency, cache reads (needs an API key) |

The sentinel leak test (`SENTINEL-7Q2`) checks that typed text never reaches the planner, in unit and e2e tests.

## 15. Where new code goes

- **A new step field or kind:** `packages/shared` → `packages/core` (controller, prompt) → `packages/page-agent` if it needs the DOM → the mock planner and `apps/fixtures/mock-script.json`.
- **A new browser:** `apps/extension/src/platform` and `wxt.config.ts`. Feature detection, not sniffing.
- **A new Convex function:** device functions take `token` and call `requireDevice`; caregiver functions call `requireCaregiver` or `requireLink`.
- **A new Claude call:** in `packages/backend/lib/`, reached through a Convex action or HTTP action; follow `planStep.ts` (model, effort, JSON schema, fallbacks, numbers-only logs).
- **A new spoken line:** `packages/core/src/lines.ts`. Short, warm, plain words: "button", not "element".
