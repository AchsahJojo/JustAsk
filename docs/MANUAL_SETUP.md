# JustAsk v1 — Manual setup and testing

This is the list of things a person has to do by hand. Everything else has an automated test (see "What is already tested" at the end).

Status: the Chrome extension, the step loop, the page agent, the Convex backend and the fixtures are built. The caregiver web app and the desktop app are not built yet.

## 1. Keys and accounts you need

| What | Where it goes | Who | Notes |
|---|---|---|---|
| **Anthropic API key** | Convex env: `npx convex env set ANTHROPIC_API_KEY sk-ant-…` (run in `packages/backend`) | One person | Never put it in the extension, `.env` files for the extension, or the caregiver app. For local dev only, you can `export ANTHROPIC_API_KEY=…` before `npm run planner:dev`. |
| **Convex account + project** | `cd packages/backend && npx convex dev` (log in when asked) | One person | This creates the project and writes `packages/backend/.env.local`. The repo was tested against an anonymous *local* Convex deployment only. |
| **Extension env** | `apps/extension/.env` (copy `.env.example`) | Everyone who builds | `VITE_PLANNER_URL` = the Convex **HTTP actions** URL (`https://<name>.convex.site`). `VITE_CONVEX_URL` = the Convex **client** URL (`https://<name>.convex.cloud`). Both are public, not secrets. |
| **Cartesia API key** (later) | Convex env: `CARTESIA_API_KEY` | B | Not used yet. Voice is the browser's `speechSynthesis` and Web Speech. See §4. |
| **Convex Auth for caregivers** (later) | `npx @convex-dev/auth` in `packages/backend` | C/D | Caregiver functions call `ctx.auth.getUserIdentity()` and look up `caregivers.by_token`. Wire Convex Auth (email + password or OTP) and create the `caregivers` row on first sign-in. Until then, use `npx convex run devSeed:seed` to make test data. |
| Chrome Web Store developer account | — | Later | $5 one-time. Needed for Phase 1 publishing. |

### Local Node version for Convex

The Convex local backend refuses `"use node"` actions on Node 25. `convex/plan.ts` therefore runs in Convex's default runtime, and the Anthropic SDK works there (verified locally: the deploy succeeds and `/plan` answers). If you ever need `"use node"`, install Node 20, 22 or 24 (`nvm install 22`).

## 2. First-time run (about 10 minutes)

1. `npm install` at the repo root (Node 22+).
2. `cd packages/backend && npx convex dev` and leave it running. Then set the key: `npx convex env set ANTHROPIC_API_KEY sk-ant-…`.
3. Create `apps/extension/.env` from `.env.example` with your Convex URLs.
4. `npm run build -w @justask/extension`. Load `apps/extension/.output/chrome-mv3` with **Load unpacked** at `chrome://extensions` (Developer mode on).
5. The setup tab opens by itself. Click **Turn JustAsk on** and allow it. Click **Turn on the microphone** and allow it.
6. To pair: run `npx convex run devSeed:seed` in `packages/backend`. Type the printed 6-digit `code` into setup step 3. (The seed also creates a "Refill your prescription" task with a recipe that starts at `http://localhost:5174/`.)
7. `npm run fixtures`, open `http://localhost:5174/`, click the JustAsk toolbar icon, and press **Start** on the task card.

For offline work without a key: `npm run planner:dev` (mock planner), and leave `VITE_PLANNER_URL=http://localhost:8787`.

## 3. Day-one spikes that need a real key (plan §9)

These could not be run here because no Anthropic credentials were available. The request shape is unit-tested against a stubbed API (`packages/backend/test/planStep.test.ts`), but it has not been sent to the real API.

- [ ] **Spike 2:** one real `/plan` call returns valid JSON with `fallbacks: "default"`, the `server-side-fallback-2026-07-01` beta header, `output_config.format` and `effort: "low"`. Quick check: `ANTHROPIC_API_KEY=… npm run planner:dev`, then run the extension against the fixtures. The planner logs `[plan] {"stopReason":…,"outputTokens":…,"cacheReadTokens":…}` for each step.
- [ ] **Spike 3:** the second call shows `cacheReadTokens > 0`. If it stays 0, the system prompt may be under the cache minimum for the model; add more worked examples to `SYSTEM_PROMPT` in `packages/core/src/prompt.ts`.
- [ ] Look at `outputTokens` across a few runs. If it stays well under 4096, consider lowering `max_tokens`.
- [ ] Run the **prompt eval** (not built yet): saved snapshots + expected targets, Opus 5.5 vs Sonnet 5.5, accuracy and p50/p90 latency. `mockPlan` in `packages/backend/lib/mockPlanner.ts` shows the snapshot shape.
- [ ] Confirm the gift-card banner on the fixture home page does **not** steer Claude (the mock planner can't test this).

## 4. Manual tests (can't be automated here)

Run these in a real, headed Chrome with the production build (`apps/extension/.output/chrome-mv3`).

### Side panel and gestures (plan §3.6)
- [ ] The toolbar icon opens the side panel (`setPanelBehavior`).
- [ ] **Spike 4a:** with a pending task, the "Sam sent you a task" notification appears within a minute. Clicking it opens the side panel. Record whether `sidePanel.open` works from `notifications.onClicked`.
- [ ] **Spike 4b:** the in-page banner's **Start** button opens the side panel (gesture relayed through `runtime.sendMessage`). Record the result. Dock mode, the fallback if it fails, is not built yet.
- [ ] Revoke host access (`chrome://extensions` → JustAsk → Site access → On click). The panel shows **Turn JustAsk on**, and clicking it brings back the permission prompt.

### Voice
- [ ] The microphone works in the side panel after it was allowed on the setup page. Say "help me refill my prescription".
- [ ] While she speaks, the orb shows the listening ripples. "Say that again", "stop" and "I'm stuck" work by voice.
- [ ] Text-to-speech uses a clear US English voice at a slow rate. Pick a voice on the senior's actual machine. The choice logic is in `apps/extension/src/lib/speech.ts`.
- [ ] Recognition is not muted while JustAsk speaks yet (planned). Check whether JustAsk hears itself on laptop speakers.

### Tabs and pages (plan §3.5) — partly automated
- [ ] In the real side panel (not the pinned test window): switch to another tab mid-session. The panel asks **Keep helping on this tab?** Check that **Yes, here** and **Go back** both work.
- [ ] Close the session tab mid-session. The panel pauses.
- [ ] A sign-in **popup window** (`/gaps/newtab` → "Sign in with popup"). Side panels don't show in popups, and dock mode isn't built, so expect this to be unsupported for now.
- [ ] Open the built-in PDF viewer or a Chrome Web Store page mid-session. JustAsk says it can't see the page and resumes when she goes back.

### Real sites (CP3)
- [ ] Two real tasks end to end with no code changes, for example Gmail settings and joining a Zoom meeting on the web. Log failures in the prompt or scanner, not as site-specific code.
- [ ] Strict-CSP sites (Gmail, GitHub): the highlight ring shows. The overlay uses `adoptedStyleSheets`.
- [ ] A site with a cookie banner in a `<dialog>`. The ring draws above it.

### Field types without e2e coverage
- [ ] `expect: "file"` — the file picker opens and the step advances after a file is picked.
- [ ] `expect: "hover"` — a real hover menu.
- [ ] Date input — the format hint matches the browser locale.
- [ ] Autofill — Chrome autofill on an address form advances typing steps.

### Edge (spike 6, feature freeze)
- [ ] In `apps/extension`, run `npx wxt build -b edge`. Load `.output/edge-mv3` unpacked in Edge, and check that the side panel and Web Speech work.

### Accessibility
- [ ] Zoom the panel to 200%. Nothing is cut off.
- [ ] Use VoiceOver on macOS. Captions are announced, because the caption is `aria-live`.
- [ ] Turn on reduced motion. The ring becomes a steady outline, and the orb holds still frames.
- [ ] A senior user test on Saturday, with a quote for the slide.

### Privacy check before demo
- [ ] Open DevTools → Network on the side panel during a real session with typed passwords and emails. Confirm no field values appear in `/plan` bodies. The automated leak test covers the fixtures. Do the same on one real site.
- [ ] In the Convex dashboard logs, confirm only `plan {"stopReason"…}` lines appear and no page text.

## 5. Not built yet

- **Caregiver web app** (`apps/caregiver`): sign in, add a senior + pairing code, assign a task with a recipe, activity feed. The Convex functions exist (`devices:createSeniorWithCode`, `tasks:assign`). Auth and the UI are missing.
- **Cartesia**: Sonic TTS (via a token minted by a Convex action) and STT for Brave, Firefox and Safari. They plug in behind `SpeechOut` / `BrowserListener`.
- **Dock mode** (Phase 1): the in-page panel for Opera, Safari and popup windows. The panel already accepts `?tabId=` and `sidepanel.html` is web-accessible.
- **Firefox and Safari** builds compile (`wxt build -b firefox`) but are not tested.
- `matchOriginAsFallback` for `about:blank` / `srcdoc` frames: `executeScript` doesn't support it. A registered content script would.
- Desktop companion app (Phase 4).
- Muting recognition while JustAsk speaks. Using `storage.local` to resume after a browser restart is built but not e2e-tested.

## 6. What is already tested (and how to rerun)

- `npm test` — 49 unit tests: StepResponse schema + validator rules, scanner (numbering, hidden elements, `.value` never used as a label, the **sentinel leak test** across every field type, select options cap, open and closed shadow roots, the modal-only rule, ranking before the 150 cap, duplicate collapse), fingerprint rebinding, click/typing/select/lost observers, the controller loop (multi-step, re-plan then block, risk confirm, suspicious, clarify, frames, wrong click, stop with a late reply, password line), and the `planStep` request shape (beta header, `fallbacks`, effort, schema, caching, no sampling params or `thinking`, refusal and `max_tokens` handling).
- `npm run test:e2e` — 11 Puppeteer scenarios in Chrome for Testing with the real extension: the full pharmacy refill (4 clicks, wrong click, done), 500 ms rerenders, open + closed shadow roots, same- and cross-origin iframes plus the money confirmation, typing + password + select with the **sentinel leak test against the planner's received requests**, the `<dialog>` modal-only rule, new-tab follow, 1,000 links, `chrome://` pages, the setup page, and the production build (no pre-granted host access). Screenshots land in `e2e/screenshots/`.
- `CONVEX_CODE=<code> node e2e/run.mjs accounts` — pairing through the setup page against local Convex, the task card, the recipe `startUrl`, a completed task, and the completion note in Convex.
- `npm run test:convex` — pairing (one use only), device token checks, pending tasks, events closing a task, and the `/plan` HTTP route.
