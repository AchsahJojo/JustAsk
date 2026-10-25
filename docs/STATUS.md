# JustAsk: where we are

_As of 2026-10-24 (evening), after `docs/refined-plan-3.md`: **guide only, Chrome extension only**. The desktop app was removed, and drive mode is switched off in code._

This page is a snapshot of the project. It covers what works today, how the pieces fit together, and what is missing. The other docs stay authoritative for detail:

| Doc | What it is |
|---|---|
| `docs/ARCHITECTURE.md` | System design. Sections marked "(target)" are partly built; see below. |
| `docs/HOW-IT-WORKS.md` | The short version: pieces, flows, safety, decisions. |
| `docs/refined-plan-3.md` | The current plan: guide only, extension only, deploy, judging. |
| `docs/refined-plan-2.md` | The previous plan (drive mode, desktop, accounts, agent waves). Drive and desktop are superseded. |
| `docs/DEPLOY.md` | One-command deploy for any teammate. |
| `docs/MANUAL_SETUP.md` | How to run everything locally, plus manual test checklists. |
| `docs/eval.md` | The prompt eval harness. |
| `docs/possible_bugs.md` | An older bug audit. Most items are now fixed; see "Known bugs" below. |

---

## 1. The product in one paragraph

An older adult says or types what they want to do ("refill my prescription"). JustAsk reads the page, puts a glowing box around the one thing to use next, and says one short line about it ("Click the big blue Refill button"). **The user does every click and keystroke. JustAsk never does.** It moves on when it sees their click, typing or choice. It never reads passwords, card numbers or other sensitive fields; it points at them and says it can't see them. It asks before payments and account changes, and blocks pages that look like scams. **Stop** always works.

A caregiver is optional. When there is one, the caregiver can set JustAsk up for the user, send them tasks, and hear when they finish. Everything runs as a Chrome extension plus a caregiver web app.

---

## 2. What's built

### Chrome extension (`apps/extension`)
- **Side panel:**
  - voice (Cartesia, listening and speaking) or typed requests
  - the step loop with an orb, spoken captions, Say that again, I'm stuck and Stop
- **Guide only:** every step is a guide step. The core only acts with `allowDrive: true`, which the extension never sets, and the prompt tells Claude never to use `act`. Drive-mode code stays in `packages/core/src/drive.ts` and `packages/page-agent/src/act.ts` for later.
- **Guide mode:** highlights an element and waits for the user's click, typing or choice. "I'm done typing" checks that the field really has a value.
- **Safety:**
  - money, personal-info and account-change steps ask first, and say exactly what would be pressed and where ("Next, I'd press “Place order” on pharmacy.example.")
  - `suspicious` pages block (fake virus warnings, pay-with-gift-cards, fee-for-a-prize, lookalike sites)
  - **scam check on the user's own words** before anything happens (gift card codes, money to someone who called, remote access, sharing a code); see section 5
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
  - **I have a code**: a code from another browser or a helper links this browser into that account, after confirming whose it is
- **Persistent task list:** open tasks stay until the user finishes or removes them.
  - The first task is a card with Start (or Keep going) and I did it. The rest go under "Also on your list", plus a Done / Manage list.
  - The list updates live over a `ConvexClient` subscription, with a polling fallback.
  - The toolbar badge counts open tasks.
- **Handoffs and links:**
  - `#justask-link=<code>` asks "Link to Alex's JustAsk?" before linking
- **Resilience:** survives rerenders (fingerprint rebinding), open and closed shadow roots, same- and cross-origin iframes, new tabs, `<dialog>` modals, late-loading editors (watches until the page settles), and resume after the panel reloads.
- **Starting from nothing:**
  - On an empty New Tab page, JustAsk asks "Do you want me to search the web for that?" Yes searches in that tab with their default search engine, using words Claude rewrote from the request ("I want to buy a pink owala on Amazon" becomes "pink owala water bottle amazon"), and carries on from the results. No waits until the user opens a site, then carries on.
  - If a session lands on an empty tab, the panel offers **Look it up for me** instead of a dead end.
  - When nothing is on the user's list, the start screen shows example requests.
  - When Chrome opens with tasks waiting, a notification says "You have N things on your list"; clicking it opens the panel.
- **Accuracy:**
  - JustAsk waits for a page to finish loading (quiet DOM, nothing `aria-busy`) before reading it.
  - Page text includes any visible text, so answers shown in cards (a forecast, prices) can be read out directly.
  - The prompt says: answer from the screen when the answer is there; never pick something just because it shares a word; prefer search or sort over category menus.
- **Plain wording:** "Ask for something else" (not "Start again"), "Say something" (not "Talk to me"). The done screen says "I did 3 steps for you, and you did 2", and never "0 clicks".
- **Voice:** JustAsk holds its own spoken lines while the mic is open, so recognition never hears it say "stop" or "again".
- **Dev only:** "Save snapshot" exports a request for the eval harness.

### Caregiver web app (`apps/caregiver`, Vite + React + Clayzo)
- **Sign-up / sign-in:** email + password through Convex Auth, with validation and friendly errors.
- **Setup wizard:** About them → Connect their computer (6-digit code, countdown, "make a different code") → Send a task (optional). The page flips to "connected" live when the user types the code.
- **"Do they already use JustAsk?":** type the helper code the user gets from their settings.
- **Person page:**
  - **Send a task:** type or speak it (Cartesia, listening only). `taskCheck:review` (Claude) asks one question at a time until it's clear, then shows a draft to review and edit. `tasks:assign` only accepts a checked draft (`taskChecks` table, single use, 1 hour). Tests set `JUSTASK_TASKCHECK_MOCK=1` on local Convex instead of calling Claude.
  - **Tasks you sent:** take one back while it's still waiting
  - **What they share with you:** consent-gated status and stats
  - **How JustAsk helps:** a plain note that JustAsk only guides and they do the clicking
  - **Computers:** add another computer
  - **Details:** edit, or Stop helping
- **Home:** the people you help, plus an activity feed (finished, stuck, disconnected) with mark-all-read.
- **Layout:** works at phone width and in dark mode, with a not-found page and redirects after profiles merge.

### Backend (`packages/backend`, Convex)
- **Planner:** the `/plan` HTTP action calls Claude with structured output, prompt caching and model fallbacks, with a per-device hourly step budget. A local planner runs on :8787 (Claude if `ANTHROPIC_API_KEY` is set, otherwise a scripted mock).
- **The user's account:** `accounts:createSelf`, device tokens (only the hash is stored), revoke, heartbeat, and 6-digit link codes with `peekCode`.
- **Caregivers:** Convex Auth (Password provider), the `caregivers` profile, care links in both directions (caregiver code → senior, helper code → caregiver), and profile merge with `seniorAliases` redirects.
- **Tasks:**
  - assign with validation and a safe start URL
  - the user's list (`tasks:listForDevice`)
  - stopped or blocked tasks go back to pending
  - "I did it" sends a consent-gated note
- **Prefs:** voice, speed, Show me instead and consent, synced across installs. `showMeSetBy` records whether the user or a caregiver set it.
- **Handoffs** (desktop to browser): the code is still there but unused since the desktop app was removed.
- **Platform features:**
  - `@convex-dev/rate-limiter`: code attempts per prefix, globally and per caregiver, plus account creation
  - hourly cleanup cron
  - Cartesia token action
- **Data rule:** only `events` are stored. Snapshots are never written to tables.

### Shared packages
- `packages/shared`: Zod `StepResponse` (single source for the JSON Schema), `checkStep`, message and API types, caregiver task limits.
- `packages/core`: `SessionController` (plan → check → act or guide → verify), the prompt, spoken lines and voice commands. No browser APIs.
- `packages/voice`: JustAsk's voice, **Cartesia only**: Sonic TTS and `ink-whisper` STT over WebSockets with one shared short-lived token, used by the extension. No browser speech APIs anywhere. If Cartesia fails, the panel says the voice is off; captions and typing keep working.
- `packages/page-agent`: scanner, visibility, sensitive-field classifier, `watch`, and fingerprint rebinding (plus the unused `act` executor). DOM only.

### Tests and tooling
| Command | What | Status |
|---|---|---|
| `npm test` | 415 unit tests (Vitest), including the convex-test backend suites | passing |
| `npm run test:e2e` | 15 Puppeteer scenarios with the real extension and the mock planner on :8788 | passing |
| `CONVEX_CODE=… npm run test:e2e` | adds pairing, task card, recipe and completion against local Convex | passing |
| `npm run test:accounts` | accounts against local Convex (auth, merge, helper codes, Show me instead, task list) | passing |
| `npm run test:convex` | pairing, tasks and the `/plan` route against local Convex | passing |
| `npm run test:caregiver` | caregiver app end to end in Puppeteer (desktop, phone, dark mode) | passing |
| `CONVEX_URL=… npm run test:voice` | live Cartesia check: Convex mints a token, Sonic speaks a line, STT accepts audio (needs `CARTESIA_API_KEY` on that deployment) | run against Xander's deployment |
| `npm run eval` / `eval:capture` | prompt accuracy and latency on 17 cases (pharmacy, gap fixtures, 3 live sites) | built; needs an API key |
| `npm run typecheck` | all workspaces | 0 errors |

---

## 3. Architecture

```
              ┌──────────────────────────── Convex ────────────────────────────┐
              │  /plan (HTTP action) ──► Claude (structured StepResponse)       │
              │  accounts · devices · careLinks · tasks · prefs · events        │
              │  notifications · rate limiter · cron · auth · Cartesia token    │
              └──────▲──────────────────────▲───────────────────────▲──────────┘
       device token  │         live queries │            Convex Auth │
┌──────────── Chrome extension ─────────────┴──────┐   ┌── Caregiver web app ──┐
│ side panel (React) ── SessionController ─────────┤   │ people · tasks ·      │
│        (packages/core)      │                    │   │ activity · stats      │
│                     ExtensionBridge              │   └───────────────────────┘
│                             │ messages           │
│ content script ── page-agent (scan, highlight,   │
│                   watch)                         │
└──────────────────────────────────────────────────┘
```

**One step:**
1. The bridge scans every frame (or the native window). `mergeScans` numbers the elements.
2. The controller sends `{request, history, recipe, snapshot}` to `/plan`.
3. Claude returns a `StepResponse` that names an element **number**, never a selector.
4. `checkStep` validates it. The deterministic gates run: sensitive field → guide, risk → ask, suspicious → block.
5. JustAsk highlights the target, says the line, and waits for the user (`guide`).
6. The page reports done, wrong or changed, and the loop continues.

**Accounts:**
- One `seniors` row per person ("the user's account"). Each install is a `devices` row with its own token.
- Caregivers are Convex Auth users, joined to the user through `careLinks`.
- A caregiver is never required.

**Where code goes:** see `CLAUDE.md` and `ARCHITECTURE.md` §4 and §13.
- Browser APIs only in `apps/extension`.
- `packages/core` and `packages/page-agent` stay platform-free.

---

## 4. What's missing

### Deployment (blocking a shared demo)
- [ ] **The cloud dev Convex (`aromatic-salamander-969`) has none of the merged code.** Someone with access runs `npx convex dev` (or deploys), then `npx @convex-dev/auth` to set `JWT_PRIVATE_KEY`, `JWKS` and `SITE_URL`. Until then, everything runs against the local anonymous Convex.
- [ ] `ANTHROPIC_API_KEY` in the cloud Convex env, so `/plan` uses Claude (local currently answers "server not configured").
- [ ] **Email verification and password reset** for caregivers: Resend (`AUTH_RESEND_KEY` plus a verified domain) in the Convex project, then wire `Password({ verify, reset })`.
- [ ] Hosting the caregiver app and fixtures: `npm run deploy -- --vercel` (see `docs/DEPLOY.md`).

### Planned in refined-plan-2 but not done
- [ ] **Wave 2 e2e scenarios:**
  - guided store search plus add-to-cart
  - login (password guided, never typed)
  - payment (asks first; card entry guided)
  - late-loading composer (P1)
  - off-canvas drawer (P2)

  The fixtures exist (`apps/fixtures/public/gaps/store*.html`, `checkout`, `login`, `composer`), and the mock script has the rules.
- [ ] **Run the eval** before and after the prompt and scanner changes, and pick the model and effort from the data. Several cases are still marked "pending fixtures" in `docs/eval.md`.

### Product decisions still open
- [x] Guide or drive? **Decided: guide only** (refined-plan-3). The user always does the clicking.
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
- **Voice:** JustAsk's spoken lines wait while the mic is open (`CartesiaSpeech.hold`).
- **Colors:** `colorName` reads `oklch()`, `oklab()`, `lab()`, `lch()` and `color()`, so "the blue button" works on modern CSS.
- **Iframes:** over the 150 cap, elements from every frame are ranked together (`crossFrameScore`), so a payment or sign-in iframe's button isn't crowded out. Child frames under 50×50 skip themselves.
- **Shadow DOM:** dialog detection, page text and the main heading look inside web components (`queryAllComposed`), and a component's button gets the heading around it. The main heading now prefers the h1 over an earlier h2.
- **Dropdowns:** long lists (over 30 options) send the first 10 plus every option matching the user's words or answers, so "Texas" can be chosen. Placeholder options with no `value` were already handled.
- **Empty New Tab:** JustAsk searches the user's words instead of a dead end (see "Starting from nothing" above).

Still open:
- [ ] `about:blank` / `srcdoc` iframes aren't injected (`executeScript` can't target them; it would need a registered content script with `matchOriginAsFallback` on every page).
- [ ] Dock mode (Opera, Safari, popup windows) and Firefox/Safari builds aren't tested.
- [ ] The scam check runs on the user's first request only, not on later answers or "Say something" (section 5, phase 2).

### Caregiver app refinements
- [ ] The person page has no list of the person's devices and can't revoke one (the user's own settings can).
- [ ] Notifications are in-app only: no email or push to the caregiver.
- [ ] Recipe authoring is plain text steps. There are no templates beyond the chips.
- [ ] Real-device phone testing. Phone width is checked in Puppeteer only.

---

## 5. Scam protection (plan)

**Why it matters.** Older adults lose billions of dollars a year to online and phone fraud. People 60+ reported about $7.7 billion in losses to the FBI's IC3 in 2025, up 59% on 2024 (as summarized by AARP; confirm in the IC3 report before quoting). The biggest losses are tech-support and government-impersonation scams, investment and crypto scams, romance scams, and "grandparent" emergencies. Many of these end with a scammer *talking the victim through* a payment on their own computer. JustAsk sits at exactly that moment. It hears what the user wants to do and sees the page they do it on, so it can notice the pattern and slow things down before money or codes leave.

### Principles
- **The user's choice, not ours.** JustAsk asks one plain question and explains why. It doesn't lecture, shame or silently refuse. The only hard lines are typing passwords, texted codes, card numbers and gift card codes for the user, which JustAsk never does anyway.
- **Ask, then slow down, then stop.** First a question, then a pause with "talk to someone you trust". It blocks outright only on pages that are clearly a trap.
- **Deterministic first.** Fixed rules in code (like the `sensitive` classifier), with Claude as a second opinion. They are testable, explainable, and work with no network.
- **Privacy.** The checks on the user's words and the page run on their device. Anything that needs a lookup sends only the site's domain (or a hash prefix), never the page or what the user said. A caregiver is told only with the user's consent, and only *that* JustAsk stepped in, never the content.

### What we look for

| Pattern | The user's words (example) | On the page |
|---|---|---|
| Gift-card payment | "email the gift card codes to the IRS" | a request to pay a bill, fine or person with gift cards; a "read the numbers on the back" form |
| Money to someone who called | "wire $4,000, my grandkid's in jail" | wire, Zelle, Cash App, crypto or money order to a person; "urgent", "today only" |
| Prize, refund or inheritance with a fee | "pay the fee so I get my winnings" | "you won", "release fee", "overpaid refund" |
| Tech support and remote access | "install AnyDesk so Microsoft can fix it" | full-screen "virus" warnings with a phone number; remote-access downloads |
| Sharing codes | "tell the bank caller the code they texted me" | a field asking for a texted code outside a sign-in the user started |
| Fake or lookalike shop | "buy the cheap iPhone on this site" | the address doesn't match the brand (punycode, misspellings); prices far below normal; only wire, crypto or payment-app checkout; a brand-new domain |
| Romance and investment | "send money to my boyfriend I met online" | "guaranteed returns", "double your money", crypto ATM instructions |

### How it works, in layers
1. **The user's words: built.** `scamCheck` in `packages/core/src/scam.ts` runs on the user's request before JustAsk searches, opens or presses anything.
   - The user sees one short question with the fact behind it: "Did someone call, text or email asking you to do this?" Below it: "Real companies, banks and government offices never ask to be paid with gift card numbers."
   - The buttons are **Yes, someone asked me** and **No, it's my own idea**. Voice "yes" means someone asked.
   - **Someone asked:** JustAsk stops with "This looks like a scam. Please don't send anything." It says what to do next: hang up, talk to someone you trust, and call the bank right away if they already sent anything.
   - **Their own idea:** JustAsk carries on, and tells Claude to be careful: no codes typed, and every payment asks first.
   - Ordinary requests pass, like "buy a gift card for my grandkid's birthday" or "send money to my kid on Venmo". Tests cover 14 scam phrasings and 11 everyday requests.
2. **The page, Claude's judgment: built.** The prompt marks these as `suspicious`, which blocks: pay-with-gift-cards, wire, crypto or payment-app demands, fee-for-a-prize, stores that only take those, prices far below normal, and addresses that don't match the brand. Gift card and claim-code fields are `sensitive`, so they are never typed.
3. **The page, deterministic signals: phase 2.** Code checks that don't depend on Claude:
   - a lookalike or punycode domain, where a top brand in the title or heading doesn't match the hostname
   - payment-demand phrases next to gift card, wire or crypto words
   - fake virus pages (fullscreen or keyboard lock, a phone number, "virus" or "locked" words)
   - downloads of remote-access tools (`downloads.onCreated` in the extension)

   Each one raises the same kind of question, or blocks when it's a clear trap.
4. **The whole conversation: phase 2.** Run `scamCheck` on the user's later answers and "Say something", not only the first request. For example, the user starts with "help me buy gift cards", then says "the caller said to send them the numbers".
5. **Reputation lookups: phase 3.** These need keys in Convex env, and send only the domain or a hash prefix:
   - Google Safe Browsing / Web Risk, using hash-prefix lookups so the full address isn't sent
   - domain age through RDAP, so a store under 90 days old asks before checkout
   - an optional list of known-good stores

   All of it runs through a Convex action with caching, never from the page.
6. **Slow down, and a helper: phase 2.**
   - After "someone asked me": a "Let's wait and talk to someone first" screen, with a call-your-helper prompt if they have one.
   - A new, separate consent: **"Tell my helper if JustAsk thinks someone is trying to scam me."** The helper gets "JustAsk paused something that looked like a gift card scam", with no page content and nothing the user said. It shows in the caregiver app's activity feed.

### Measuring it
- **A phrase set:** grow `scam.test.ts` into a labelled list of real scam scripts (FTC and AARP examples) and everyday requests.
  - **Targets:** at least 90% of scams caught, and at most 1% of everyday requests flagged. A false alarm on a normal errand teaches the user to ignore the question.
- **Page fixtures:** a fake store (lookalike domain, crypto-only checkout), a fake virus page, and a gift-card payment form. Each gets an e2e scenario and an eval case (`docs/eval.md`), so Claude's `suspicious` rate is measured too.
- **Events:** `scam_check` and `scam_stopped` are logged as outcome events, with no content. They show how often it fires and how often the user says it was their own idea.

### Phases
| Phase | What | Size |
|---|---|---|
| 1 (done) | request check with plain question and stop screen; page rule in the prompt; gift card fields sensitive; unit + e2e tests | done |
| 2 | check every answer, not just the first request; deterministic page signals; remote-tool downloads; the "slow down" screen; consented helper alert; fixtures and eval cases | ~2 days |
| 3 | Safe Browsing / Web Risk, RDAP domain age, trusted-store list, all through a cached Convex action; measured false-alarm rate | ~2 days plus API keys |

### Open questions
- Should the helper alert be **on by default** when a helper is linked? Our default is **off**: it's the user's information. Setup and the caregiver's first-run flow would suggest turning it on.
- After "someone asked me", should JustAsk lock that request for a while (for example, a 24-hour cool-off) or only advise? Our proposal is to advise only, and offer to call their helper.
- How much page-level blocking is acceptable on a real store with low prices? Our proposal is to ask, never block, unless the address is a lookalike.

## 6. Running it locally (short version)

```bash
npm install
cd packages/backend && npx convex dev     # local or your dev deployment
cd packages/backend && npx convex env set ANTHROPIC_API_KEY …   # Claude for /plan, kept in Convex
npm run fixtures                           # :5174 / :5175 test sites
npm run caregiver                          # :5176 caregiver app
VITE_PLANNER_URL=http://127.0.0.1:3211 VITE_CONVEX_URL=http://127.0.0.1:3210 npm run build -w @justask/extension
# load apps/extension/.output/chrome-mv3 in chrome://extensions (Developer mode → Load unpacked)
```

The full steps are in `docs/MANUAL_SETUP.md`.
