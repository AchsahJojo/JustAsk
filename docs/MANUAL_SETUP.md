# JustAsk v1 — Manual setup and testing

This is the list of things a person has to do by hand. Everything else has an automated test (see "What is already tested" at the end).

Status: the Chrome extension, the step loop, the page agent, the Convex backend, the fixtures and the caregiver web app are built. The desktop app is not built yet.

## 1. Keys and accounts you need

| What | Where it goes | Who | Notes |
|---|---|---|---|
| **Anthropic API key** | Convex env: `npx convex env set ANTHROPIC_API_KEY sk-ant-…` (run in `packages/backend`) | One person | Never put it in the extension, `.env` files for the extension, or the caregiver app. For local dev only, you can `export ANTHROPIC_API_KEY=…` before `npm run planner:dev`. |
| **Convex account + project** | `cd packages/backend && npx convex dev` (log in when asked) | One person | This creates the project and writes `packages/backend/.env.local`. The repo was tested against an anonymous *local* Convex deployment only. |
| **Extension env** | `apps/extension/.env` (copy `.env.example`) | Everyone who builds | `VITE_PLANNER_URL` = the Convex **HTTP actions** URL (`https://<name>.convex.site`). `VITE_CONVEX_URL` = the Convex **client** URL (`https://<name>.convex.cloud`). Both are public, not secrets. |
| **Cartesia API key** (later) | Convex env: `CARTESIA_API_KEY` | B | Not used yet. Voice is the browser's `speechSynthesis` and Web Speech. See §4. |
| **Convex Auth keys** | Convex env: `JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL` (run in `packages/backend`) | One person, once per deployment | Caregiver sign-in (email + password). Easiest: `npx @convex-dev/auth` and follow the prompts. `SITE_URL` is the caregiver app's URL (`http://localhost:5176` locally). Already set on the local anonymous deployment. |
| **Caregiver app env** | `apps/caregiver/.env.local` (copy `.env.example`) | Everyone who runs it | `VITE_CONVEX_URL` = the Convex **client** URL. `VITE_EXTENSION_URL` = the Chrome Web Store link once published. Public, not secrets. |
| Chrome Web Store developer account | — | Later | $5 one-time. Needed for Phase 1 publishing. |

### Local Node version for Convex

The Convex local backend refuses `"use node"` actions on Node 25. `convex/plan.ts` therefore runs in Convex's default runtime, and the Anthropic SDK works there (verified locally: the deploy succeeds and `/plan` answers). If you ever need `"use node"`, install Node 20, 22 or 24 (`nvm install 22`).

## 2. First-time run (about 10 minutes)

1. `npm install` at the repo root (Node 22+).
2. `cd packages/backend && npx convex dev` and leave it running. Then set the key: `npx convex env set ANTHROPIC_API_KEY sk-ant-…`.
3. Create `apps/extension/.env` from `.env.example` with your Convex URLs.
4. `npm run build -w @justask/extension`. Load `apps/extension/.output/chrome-mv3` with **Load unpacked** at `chrome://extensions` (Developer mode on).
5. The setup tab opens by itself. Click **Turn JustAsk on** and allow it. Click **Turn on the microphone** and allow it.
6. JustAsk now works with no caregiver: with `VITE_CONVEX_URL` set, the extension signs itself up in the background (a device token, no password). To try the caregiver side, run `npm run caregiver` and open `http://localhost:5176`. Create an account, click **Set up JustAsk for someone**, and type the code into setup step 4 ("Connect to a helper"). For a quick seeded pair instead, run `npx convex run devSeed:seed` in `packages/backend` and type the printed `code`. The seed also makes a "Refill your prescription" task with a recipe that starts at `http://localhost:5174/`.
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

- **Caregiver password reset.** There is no email provider, so "forgot password" isn't offered. Add `reset` to the `Password` provider in `convex/auth.ts` with Resend (needs `AUTH_RESEND_KEY`).
- **Caregiver app deploy** (Vercel). `npm run build -w @justask/caregiver` writes `apps/caregiver/dist`. Set `SITE_URL` in Convex to the deployed URL.
- **Cartesia**: Sonic TTS (via a token minted by a Convex action) and STT for Brave, Firefox and Safari. They plug in behind `SpeechOut` / `BrowserListener`.
- **Dock mode** (Phase 1): the in-page panel for Opera, Safari and popup windows. The panel already accepts `?tabId=` and `sidepanel.html` is web-accessible.
- **Firefox and Safari** builds compile (`wxt build -b firefox`) but are not tested.
- `matchOriginAsFallback` for `about:blank` / `srcdoc` frames: `executeScript` doesn't support it. A registered content script would.
- Desktop companion app (Phase 4).
- Muting recognition while JustAsk speaks. Using `storage.local` to resume after a browser restart is built but not e2e-tested.

## 5b. Accounts (how they work)

- **Seniors never get a password.** The extension creates its own account on first run (`devices:registerStandalone`) and keeps a device token. Everything works with no caregiver.
- **Caregivers** sign in with email + password (Convex Auth). A `caregivers` row is made on first sign-in (`caregivers:ensureProfile`).
- **Connecting** is always the senior typing a caregiver's 6-digit code (15 minutes, one use). On a new install, the computer joins the profile the caregiver made. On a computer that already uses JustAsk, the two profiles merge and the senior's own name, consent and history are kept (the caregiver's page follows via `seniorAliases`).
- **Leaving.** The senior can stop working with any helper in setup (`devices:leaveHelpers`). A caregiver can **Stop helping** (`people:remove`). Either way the senior's JustAsk keeps working.
- **Privacy.** Caregivers see task status and stats only if the senior turned on "Tell my helper when I finish". They never see sessions the senior started on her own.
- **Abuse caps.** 500 standalone sign-ups and 300 failed codes per hour, globally (`convex/lib.ts`). Per-IP limits need an HTTP action in front; not done.
- **Migration.** Old seed rows had `caregivers.tokenIdentifier`. Run `npx convex run migrations:caregiversToAuth` once per deployment, then the field can be removed from the schema.

- **Type it for me.** Off until chosen. JustAsk asks her at the first search box (or in setup step 5), and a linked caregiver can turn it on or off under **Typing help**. It only fills boxes `isSearchBox` accepts, re-checked in the page, and never submits.
- **Task list.** Tasks stay in her panel until she finishes or removes them (`tasks:listForDevice`). Started tasks show **Keep going**; **I did it** marks one done and sends the consent-gated note.

### Manual checks for accounts
- [ ] Real Chrome: install fresh, skip step 4, and use JustAsk with no caregiver against the Convex `/plan` (needs the API key).
- [ ] Caregiver app on a phone (layout was checked at 390 px in Puppeteer, not on a device).
- [ ] Two caregivers connected to one senior: both get the completion note for their own tasks only.
- [ ] Type it for me on real search boxes (Google, Amazon, a store search) with a real key. Check it never fills a sign-in or checkout box.
- [ ] Email verification and password reset need Resend: whoever owns the Convex project sets `AUTH_RESEND_KEY` and verifies a sending domain.

## 6. What is already tested (and how to rerun)

- `npm test` — 49 unit tests: StepResponse schema + validator rules, scanner (numbering, hidden elements, `.value` never used as a label, the **sentinel leak test** across every field type, select options cap, open and closed shadow roots, the modal-only rule, ranking before the 150 cap, duplicate collapse), fingerprint rebinding, click/typing/select/lost observers, the controller loop (multi-step, re-plan then block, risk confirm, suspicious, clarify, frames, wrong click, stop with a late reply, password line), and the `planStep` request shape (beta header, `fallbacks`, effort, schema, caching, no sampling params or `thinking`, refusal and `max_tokens` handling).
- `npm run test:e2e` — 13 Puppeteer scenarios in Chrome for Testing with the real extension: the full pharmacy refill (4 clicks, wrong click, done), 500 ms rerenders, open + closed shadow roots, same- and cross-origin iframes plus the money confirmation, typing + password + select with the **sentinel leak test against the planner's received requests**, the `<dialog>` modal-only rule, new-tab follow, 1,000 links, `chrome://` pages, the setup page, and the production build (no pre-granted host access). Screenshots land in `e2e/screenshots/`.
- `CONVEX_CODE=<code> node e2e/run.mjs accounts` — pairing through the setup page against local Convex, the task card, the recipe `startUrl`, a completed task, and the completion note in Convex.
- `npm run test:convex` — pairing (one use only), device token checks, pending tasks, events closing a task, and the `/plan` HTTP route.
- `npm run test:accounts` — against local Convex: caregiver sign-up/sign-in (wrong password, duplicate email, short password, bad email), standalone seniors, pairing (spaces, one use, replaced codes, stale tokens), merging a standalone senior with a caregiver profile (and the page redirect), second computers, task validation (`javascript:` and credential URLs, step limits), consent-gated status and stats, isolation between caregivers, disconnect and remove.
- `npm run test:caregiver` — Puppeteer against the caregiver app (`npm run caregiver` running): sign-up validation, setup wizard, code countdown and replacement, live "connected" when the senior redeems, sending a task with a recipe, Done + stats after consent, take back, activity feed, not-found page, phone width (no horizontal scroll), dark mode, sign out/in, duplicate sign-up. Screenshots land in `e2e/screenshots/caregiver/`.
