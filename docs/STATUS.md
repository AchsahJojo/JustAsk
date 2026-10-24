# JustAsk: where we are

_As of 2026-10-24, branch `feature/cg-desktop-merge`. This merges `feature/caregvier` (Ami) with `feature/xander` (Xander)._

This page is a snapshot of the project. It covers what works today, how the pieces fit together, and what is missing. The other docs stay authoritative for detail:

| Doc | What it is |
|---|---|
| `docs/ARCHITECTURE.md` | System design. Sections marked "(target)" are partly built; see below. |
| `docs/refined-plan-2.md` | The current build plan (drive mode, desktop, accounts, agent waves). |
| `docs/MANUAL_SETUP.md` | How to run everything locally, plus manual test checklists. |
| `docs/eval.md` | The prompt eval harness. |
| `docs/possible_bugs.md` | An older bug audit. Most items are now fixed; see "Known bugs" below. |

---

## 1. The product in one paragraph

An older adult says or types what she wants to do ("refill my prescription"). JustAsk reads the page and does it for her one step at a time (**drive mode**). It says what it's doing and highlights each element before acting. She can press **Stop** at any time. It never types passwords, card numbers or other sensitive fields; for those it shows her where to type. It asks before payments and account changes. With **Show me instead** turned on, it guides every step and she does the clicking.

A caregiver is optional. When she has one, the caregiver can set JustAsk up for her, send her tasks, and hear when she finishes. Everything runs as a Chrome extension today. A Windows desktop app adds the same help inside native apps (Settings, Zoom, the print dialog).

---

## 2. What's built

### Chrome extension (`apps/extension`)
- **Side panel:**
  - voice or typed requests
  - the step loop with an orb, spoken captions, Say that again, I'm stuck and Stop
  - a big red Stop while JustAsk acts
- **Drive mode:**
  - `act` steps click, type, choose, scroll and submit, each announced first
  - it falls back to guiding for sensitive fields, failed actions and Show me instead
  - it switches to guiding after 3 actions that change nothing
- **Guide mode:** highlights an element and waits for her click, typing or choice. "I'm done typing" checks that the field really has a value.
- **Safety:**
  - money, personal-info and account-change steps ask first
  - `suspicious` pages block
  - page text is untrusted and goes inside `<page_content>`
  - field values never leave the page (sentinel leak test)
- **Setup page:**
  - host access and microphone
  - **"I'm new: create my JustAsk"** or **"I have a code"**
  - synced settings: Show me instead and speech speed
  - **Your devices** (add or remove)
  - **Your helpers** (Stop per helper)
  - **Share with my helper** (makes a helper code)
  - **I have a code from my helper** (merges a caregiver's profile into her account)
- **Persistent task list:** open tasks stay until she finishes or removes them.
  - The first task is a card with Start (or Keep going) and I did it. The rest go under "Also on your list", plus a Done / Manage list.
  - The list updates live over a `ConvexClient` subscription, with a polling fallback.
  - The toolbar badge counts open tasks.
- **Handoffs and links:**
  - `#justask=<id>` claims a handoff from the desktop app and shows an in-page Start banner
  - `#justask-link=<code>` asks "Link to Margaret's JustAsk?" before linking
- **Resilience:** survives rerenders (fingerprint rebinding), open and closed shadow roots, same- and cross-origin iframes, new tabs, `<dialog>` modals, late-loading editors (watches until the page settles), and resume after the panel reloads.
- **Dev only:** "Save snapshot" exports a request for the eval harness.

### Caregiver web app (`apps/caregiver`, Vite + React + Clayzo)
- **Sign-up / sign-in:** email + password through Convex Auth, with validation and friendly errors.
- **Setup wizard:** About them → Connect their computer (6-digit code, countdown, "make a different code") → Send a task (optional). The page flips to "connected" live when she types the code.
- **"Do they already use JustAsk?":** type the helper code she gets from her settings.
- **Person page:**
  - **Send a task:** title, spoken prompt, an optional recipe of steps and an `https://` start page
  - **Tasks you sent:** take one back while it's still waiting
  - **What they share with you:** consent-gated status and stats
  - **How JustAsk helps:** turn Show me instead on or off for her
  - **Computers:** add another computer
  - **Details:** edit, or Stop helping
- **Home:** the people you help, plus an activity feed (finished, stuck, disconnected) with mark-all-read.
- **Layout:** works at phone width and in dark mode, with a not-found page and redirects after profiles merge.

### Desktop app (`apps/desktop`, Tauri 2)
- **Windows:**
  - Ask window with the orb, a tray menu, and Welcome and Settings screens
  - pairing (create an account, or link with a code)
  - a Convex client, OS task alerts and handoffs
  - Cartesia speech-to-text (token minted by Convex)
- **`NativeBridge`:** the same `PageBridge` the extension uses, over Tauri commands.
- **Windows UI Automation** (`src-tauri/src/native/windows.rs`):
  - scans the foreground window
  - highlights the target with an overlay
  - acts through UIA patterns, never on secure fields
  - polls for changes (`wait_for_change`)
  - `dump_snapshot` CLI for debugging
- Unit tests for the backend client, bridge, device, links and STT.

### Backend (`packages/backend`, Convex)
- **Planner:** the `/plan` HTTP action calls Claude with structured output, prompt caching and model fallbacks, with a per-device hourly step budget. A local planner runs on :8787 (Claude if `ANTHROPIC_API_KEY` is set, otherwise a scripted mock).
- **Her account:** `accounts:createSelf`, device tokens (only the hash is stored), revoke, heartbeat, and 6-digit link codes with `peekCode`.
- **Caregivers:** Convex Auth (Password provider), the `caregivers` profile, care links in both directions (caregiver code → senior, helper code → caregiver), and profile merge with `seniorAliases` redirects.
- **Tasks:**
  - assign with validation and a safe start URL
  - her list (`tasks:listForDevice`)
  - stopped or blocked tasks go back to pending
  - "I did it" sends a consent-gated note
- **Prefs:** voice, speed, Show me instead and consent, synced across installs. `showMeSetBy` records whether she or a caregiver set it.
- **Handoffs** between the extension and the desktop app, matched by `machineId`.
- **Platform features:**
  - `@convex-dev/rate-limiter`: code attempts per prefix, globally and per caregiver, plus account creation
  - hourly cleanup cron
  - Cartesia token action
- **Data rule:** only `events` are stored. Snapshots are never written to tables.

### Shared packages
- `packages/shared`: Zod `StepResponse` (single source for the JSON Schema), `checkStep`, message and API types, caregiver task limits.
- `packages/core`: `SessionController` (plan → check → act or guide → verify), the prompt, spoken lines and voice commands. No browser APIs.
- `packages/page-agent`: scanner, visibility, sensitive-field classifier, the `act` executor, `watch`, and fingerprint rebinding. DOM only.

### Tests and tooling
| Command | What | Status |
|---|---|---|
| `npm test` | 301 unit tests (Vitest), including the convex-test backend suites | passing |
| `npm run test:e2e` | 12 Puppeteer scenarios with the real extension and the mock planner on :8788 | passing |
| `CONVEX_CODE=… npm run test:e2e` | adds pairing, task card, recipe and completion against local Convex | passing |
| `npm run test:accounts` | accounts against local Convex (auth, merge, helper codes, Show me instead, task list) | passing |
| `npm run test:convex` | pairing, tasks and the `/plan` route against local Convex | passing |
| `npm run test:caregiver` | caregiver app end to end in Puppeteer (desktop, phone, dark mode) | passing |
| `npm run eval` / `eval:capture` | prompt accuracy and latency on 17 cases (pharmacy, gap fixtures, 3 live sites) | built; needs an API key |
| `npm run typecheck` | all workspaces | 0 errors |

---

## 3. Architecture

```
                      ┌──────────────────────────── Convex ─────────────────────────────┐
                      │  /plan (HTTP action) ──► Claude (structured StepResponse)        │
                      │  accounts · devices · careLinks · tasks · prefs · handoffs       │
                      │  sessions/events · notifications · rate limiter · cron · auth    │
                      └────▲──────────────▲──────────────────▲──────────────────▲────────┘
          device token     │              │ live queries     │ Convex Auth      │ device token
                           │              │                  │                  │
┌──────────── Chrome extension ───────────┴──┐   ┌── Caregiver web app ──┐   ┌── Desktop app (Tauri) ──┐
│ side panel (React) ── SessionController ───┤   │ people · tasks ·      │   │ Ask window ── Session-  │
│        (packages/core)      │              │   │ activity · setup      │   │ Controller ── Native-   │
│                     ExtensionBridge        │   └───────────────────────┘   │ Bridge ── Rust UIA scan │
│                             │ messages     │                               │ / overlay / act         │
│ content script ── page-agent (scan, act,   │◄────── handoff links ────────►│                         │
│                   highlight, watch)        │                               └─────────────────────────┘
└────────────────────────────────────────────┘
```

**One step:**
1. The bridge scans every frame (or the native window). `mergeScans` numbers the elements.
2. The controller sends `{request, history, recipe, snapshot}` to `/plan`.
3. Claude returns a `StepResponse` that names an element **number**, never a selector.
4. `checkStep` validates it. The deterministic gates run: sensitive field → guide, risk → ask, suspicious → block.
5. JustAsk acts (`act`) or highlights and waits (`guide`).
6. The page reports done, wrong or changed, and the loop continues.

**Accounts:**
- One `seniors` row per person ("her account"). Each install is a `devices` row with its own token.
- Caregivers are Convex Auth users, joined to her through `careLinks`.
- A caregiver is never required.

**Where code goes:** see `CLAUDE.md` and `ARCHITECTURE.md` §4 and §13.
- Browser APIs only in `apps/extension`.
- OS APIs only in `apps/desktop/src-tauri`.
- `packages/core` and `packages/page-agent` stay platform-free.

---

## 4. What's missing

### Deployment (blocking a shared demo)
- [ ] **The cloud dev Convex (`aromatic-salamander-969`) has none of the merged code.** Someone with access runs `npx convex dev` (or deploys), then `npx @convex-dev/auth` to set `JWT_PRIVATE_KEY`, `JWKS` and `SITE_URL`. Until then, everything runs against the local anonymous Convex.
- [ ] `ANTHROPIC_API_KEY` in the cloud Convex env, so `/plan` uses Claude (local currently answers "server not configured").
- [ ] **Email verification and password reset** for caregivers: Resend (`AUTH_RESEND_KEY` plus a verified domain) in the Convex project, then wire `Password({ verify, reset })`.
- [ ] Hosting the caregiver app, and a real link origin (`VITE_LINK_ORIGIN`) for `#justask-link=` codes from the desktop app.
- [ ] Code signing (Windows, and Apple if macOS ships). Owner not decided.

### Planned in refined-plan-2 but not done
- [ ] **Wave 2 e2e scenarios:**
  - driven store search plus add-to-cart
  - login (password guided, never typed)
  - payment (asks first; card entry guided)
  - late-loading composer (P1)
  - off-canvas drawer (P2)
  - the handoff link
  - the sentinel leak test with drive mode on

  The fixtures exist (`apps/fixtures/public/gaps/store*.html`, `checkout`, `login`, `composer`), and the mock script has the rules.
- [ ] **Run the eval** before and after the prompt and scanner changes, and pick the model and effort from the data. Several cases are still marked "pending fixtures" in `docs/eval.md`.
- [ ] **macOS native** (`native/macos`): only if a teammate runs it on a Mac.
- [ ] **Desktop target apps checked by hand:** Windows Settings text size, Zoom join, print dialog.
- [ ] **Desktop to browser and back,** tested end to end on one machine.

### Product decisions still open
- [ ] Should **Show me instead** be on by default for new accounts? (It's off today. Caregivers can switch it per person.)
- [ ] The pause before each action: 1 s by default. Should a caregiver be able to change it?
- [ ] The first-run question. The old "Type it for me" asked her once whether JustAsk should type for her; drive mode has no such question. Decide whether setup should ask "Should JustAsk do the clicking, or show you?"
- [ ] Per-IP abuse limits on unauthenticated endpoints. This needs an HTTP action in front; today the limits are global and per code prefix.

### Known bugs and gaps
Fixed since `docs/possible_bugs.md` was written:
- voice commands eating requests (now whole-phrase matches)
- duplicate buttons collapsing (the key now includes the nearby heading)
- tasks vanishing (they requeue, and the list is persistent)
- "I'm done typing" not re-checking the field
- a mismatched snapshot id hanging the session
- hover finishing after the pointer left
- clarify input losing focus
- editor-text leaks
- unlimited code guessing
- `ja:page-changed` never being sent (`watch`)
- unchecked recipe start URLs (now `https://` only)

Still open, or not yet re-checked:
- [ ] `/plan` passes the whole request body (page text included) as a Convex action argument. Check whether Convex execution logs keep arguments; if they do, that breaks the "snapshots never logged" rule.
- [ ] The dev planner's `GET /__received` serves every request body with `Access-Control-Allow-Origin: *`. It's dev only, but should be limited to e2e runs.
- [ ] Speech recognition isn't muted while JustAsk speaks, so it can hear itself say "stop".
- [ ] `colorName` only parses `rgb()` / `rgba()`. `oklch()`, `lab()` and `color()` become "no color".
- [ ] Iframes are merged top frame first up to 150 elements, with no second ranking pass. `visibleFrames` is unused, and `about:blank` / `srcdoc` frames aren't injected.
- [ ] Shadow DOM: modal detection, headings and page text use light-DOM queries.
- [ ] Select fields: check how placeholder options (no `value=""`) and clipped option labels (60 characters; lists over 30 send only 10 options) behave.
- [ ] Dock mode (Opera, Safari, popup windows) and Firefox/Safari builds aren't tested.

### Caregiver app refinements
- [ ] The person page has no list of her devices and can't revoke one (her own settings can).
- [ ] Notifications are in-app only: no email or push to the caregiver.
- [ ] Recipe authoring is plain text steps. There are no templates beyond the chips.
- [ ] Real-device phone testing. Phone width is checked in Puppeteer only.

---

## 5. Running it locally (short version)

```bash
npm install
cd packages/backend && npx convex dev     # local or your dev deployment
npm run planner:dev                        # :8787 (export ANTHROPIC_API_KEY for Claude)
npm run fixtures                           # :5174 / :5175 test sites
npm run caregiver                          # :5176 caregiver app
VITE_PLANNER_URL=http://localhost:8787 VITE_CONVEX_URL=http://127.0.0.1:3210 npm run build -w @justask/extension
# load apps/extension/.output/chrome-mv3 in chrome://extensions (Developer mode → Load unpacked)
```

The full steps are in `docs/MANUAL_SETUP.md`.
