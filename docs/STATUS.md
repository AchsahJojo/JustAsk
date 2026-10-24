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
  - money, personal-info and account-change steps ask first, and say exactly what would be pressed and where ("Next, I'd press “Place order” on pharmacy.example.")
  - `suspicious` pages block (fake virus warnings, pay-with-gift-cards, fee-for-a-prize, lookalike sites)
  - **scam check on her own words** before anything happens (gift card codes, money to someone who called, remote access, sharing a code); see section 5
  - gift card numbers and claim codes count as sensitive, so JustAsk never types them
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
- **Starting from nothing:**
  - On an empty New Tab page, JustAsk searches her words (without "help me" or "please") with her default search engine in that tab, then carries on from the results.
  - If a session lands on an empty tab, the panel offers **Look it up for me** instead of a dead end.
  - When nothing is on her list, the start screen shows example requests.
  - When Chrome opens with tasks waiting, a notification says "You have N things on your list"; clicking it opens the panel.
- **Plain wording:** "Ask for something else" (not "Start again"), "Say something" (not "Talk to me"). The done screen says "I did 3 steps for you, and you did 2", and never "0 clicks".
- **Voice:** JustAsk holds its own spoken lines while the mic is open, so recognition never hears it say "stop" or "again".
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
| `npm test` | 387 unit tests (Vitest), including the convex-test backend suites | passing |
| `npm run test:e2e` | 15 Puppeteer scenarios with the real extension and the mock planner on :8788 | passing |
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

Fixed in this pass (2026-10-24):
- **`/plan` and Convex logs:** the HTTP action now calls the planner in-process (`runPlan` in `convex/plan.ts`) instead of `runAction`, so page text is never a function argument Convex could record.
- **Dev planner:** it keeps request bodies and serves `GET /__received` only in mock mode (what e2e uses). With Claude it keeps nothing.
- **Voice:** JustAsk's spoken lines wait while the mic is open (`BrowserSpeech.hold`).
- **Colors:** `colorName` reads `oklch()`, `oklab()`, `lab()`, `lch()` and `color()`, so "the blue button" works on modern CSS.
- **Iframes:** over the 150 cap, elements from every frame are ranked together (`crossFrameScore`), so a payment or sign-in iframe's button isn't crowded out. Child frames under 50×50 skip themselves.
- **Shadow DOM:** dialog detection, page text and the main heading look inside web components (`queryAllComposed`), and a component's button gets the heading around it. The main heading now prefers the h1 over an earlier h2.
- **Dropdowns:** long lists (over 30 options) send the first 10 plus every option matching her words or answers, so "Texas" can be chosen. Placeholder options with no `value` were already handled.
- **Empty New Tab:** JustAsk searches her words instead of a dead end (see "Starting from nothing" above).

Still open:
- [ ] `about:blank` / `srcdoc` iframes aren't injected (`executeScript` can't target them; it would need a registered content script with `matchOriginAsFallback` on every page).
- [ ] Dock mode (Opera, Safari, popup windows) and Firefox/Safari builds aren't tested.
- [ ] The scam check runs on her first request only, not on later answers or "Say something" (section 5, phase 2).

### Caregiver app refinements
- [ ] The person page has no list of her devices and can't revoke one (her own settings can).
- [ ] Notifications are in-app only: no email or push to the caregiver.
- [ ] Recipe authoring is plain text steps. There are no templates beyond the chips.
- [ ] Real-device phone testing. Phone width is checked in Puppeteer only.

---

## 5. Scam protection (plan)

**Why it matters.** Older adults lose billions of dollars a year to online and phone fraud. The FBI's 2023 Elder Fraud Report counts over $3.4 billion reported by people over 60 in one year. The biggest losses are tech-support and government-impersonation scams, investment and crypto scams, romance scams, and "grandparent" emergencies. Many of these end with a scammer *talking her through* a payment on her own computer. JustAsk sits at exactly that moment. It hears what she wants to do and sees the page she does it on, so it can notice the pattern and slow things down before money or codes leave.

### Principles
- **Her choice, not ours.** JustAsk asks one plain question and explains why. It doesn't lecture, shame or silently refuse. The only hard lines are typing passwords, texted codes, card numbers and gift card codes for her, which JustAsk never does anyway.
- **Ask, then slow down, then stop.** First a question, then a pause with "talk to someone you trust". It blocks outright only on pages that are clearly a trap.
- **Deterministic first.** Fixed rules in code (like the `sensitive` classifier), with Claude as a second opinion. They are testable, explainable, and work with no network.
- **Privacy.** The checks on her words and the page run on her device. Anything that needs a lookup sends only the site's domain (or a hash prefix), never the page or what she said. A caregiver is told only with her consent, and only *that* JustAsk stepped in, never the content.

### What we look for

| Pattern | Her words (example) | On the page |
|---|---|---|
| Gift-card payment | "email the gift card codes to the IRS" | a request to pay a bill, fine or person with gift cards; a "read the numbers on the back" form |
| Money to someone who called | "wire $4,000, my grandson's in jail" | wire, Zelle, Cash App, crypto or money order to a person; "urgent", "today only" |
| Prize, refund or inheritance with a fee | "pay the fee so I get my winnings" | "you won", "release fee", "overpaid refund" |
| Tech support and remote access | "install AnyDesk so Microsoft can fix it" | full-screen "virus" warnings with a phone number; remote-access downloads |
| Sharing codes | "tell the bank man the code they texted me" | a field asking for a texted code outside a sign-in she started |
| Fake or lookalike shop | "buy the cheap iPhone on this site" | the address doesn't match the brand (punycode, misspellings); prices far below normal; only wire, crypto or payment-app checkout; a brand-new domain |
| Romance and investment | "send money to my boyfriend I met online" | "guaranteed returns", "double your money", crypto ATM instructions |

### How it works, in layers
1. **Her words: built.** `scamCheck` in `packages/core/src/scam.ts` runs on her request before JustAsk searches, opens or presses anything.
   - She sees one short question with the fact behind it: "Did someone call, text or email asking you to do this?" Below it: "Real companies, banks and government offices never ask to be paid with gift card numbers."
   - The buttons are **Yes, someone asked me** and **No, it's my own idea**. Voice "yes" means someone asked.
   - **Someone asked:** JustAsk stops with "This looks like a scam. Please don't send anything." It says what to do next: hang up, talk to someone you trust, and call the bank right away if she already sent anything.
   - **Her own idea:** JustAsk carries on, and tells Claude to be careful: no codes typed, and every payment asks first.
   - Ordinary requests pass, like "buy a gift card for my grandson's birthday" or "send money to my daughter on Venmo". Tests cover 14 scam phrasings and 11 everyday requests.
2. **The page, Claude's judgment: built.** The prompt marks these as `suspicious`, which blocks: pay-with-gift-cards, wire, crypto or payment-app demands, fee-for-a-prize, stores that only take those, prices far below normal, and addresses that don't match the brand. Gift card and claim-code fields are `sensitive`, so they are never typed.
3. **The page, deterministic signals: phase 2.** Code checks that don't depend on Claude:
   - a lookalike or punycode domain, where a top brand in the title or heading doesn't match the hostname
   - payment-demand phrases next to gift card, wire or crypto words
   - fake virus pages (fullscreen or keyboard lock, a phone number, "virus" or "locked" words)
   - downloads of remote-access tools (`downloads.onCreated` in the extension)

   Each one raises the same kind of question, or blocks when it's a clear trap.
4. **The whole conversation: phase 2.** Run `scamCheck` on her later answers and "Say something", not only the first request. For example, she starts with "help me buy gift cards", then says "the man said to send him the numbers".
5. **Reputation lookups: phase 3.** These need keys in Convex env, and send only the domain or a hash prefix:
   - Google Safe Browsing / Web Risk, using hash-prefix lookups so the full address isn't sent
   - domain age through RDAP, so a store under 90 days old asks before checkout
   - an optional list of known-good stores

   All of it runs through a Convex action with caching, never from the page.
6. **Slow down, and a helper: phase 2.**
   - After "someone asked me": a "Let's wait and talk to someone first" screen, with a call-your-helper prompt if she has one.
   - A new, separate consent: **"Tell my helper if JustAsk thinks someone is trying to scam me."** The helper gets "JustAsk paused something that looked like a gift card scam", with no page content and nothing she said. It shows in the caregiver app's activity feed.

### Measuring it
- **A phrase set:** grow `scam.test.ts` into a labelled list of real scam scripts (FTC and AARP examples) and everyday requests.
  - **Targets:** at least 90% of scams caught, and at most 1% of everyday requests flagged. A false alarm on a normal errand teaches her to ignore the question.
- **Page fixtures:** a fake store (lookalike domain, crypto-only checkout), a fake virus page, and a gift-card payment form. Each gets an e2e scenario and an eval case (`docs/eval.md`), so Claude's `suspicious` rate is measured too.
- **Events:** `scam_check` and `scam_stopped` are logged as outcome events, with no content. They show how often it fires and how often she says it was her own idea.

### Phases
| Phase | What | Size |
|---|---|---|
| 1 (done) | request check with plain question and stop screen; page rule in the prompt; gift card fields sensitive; desktop app uses the same buttons; unit + e2e tests | done |
| 2 | check every answer, not just the first request; deterministic page signals; remote-tool downloads; the "slow down" screen; consented helper alert; fixtures and eval cases | ~2 days |
| 3 | Safe Browsing / Web Risk, RDAP domain age, trusted-store list, all through a cached Convex action; measured false-alarm rate | ~2 days plus API keys |

### Open questions
- Should the helper alert be **on by default** when a helper is linked? Our default is **off**: it's her information. Setup and the caregiver's first-run flow would suggest turning it on.
- After "someone asked me", should JustAsk lock that request for a while (for example, a 24-hour cool-off) or only advise? Our proposal is to advise only, and offer to call her helper.
- How much page-level blocking is acceptable on a real store with low prices? Our proposal is to ask, never block, unless the address is a lookalike.

## 6. Running it locally (short version)

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
