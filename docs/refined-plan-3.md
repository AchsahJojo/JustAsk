# JustAsk: finish for judging

## Context
The planning doc (brief, build plan, repo review, Demo tab) and `docs/STATUS.md` show the product is mostly built: extension, caregiver app, Convex backend, Cartesia voice, scam check, 428 unit + 15 e2e tests. What's missing for judging is mostly not features:

1. **The story and the code disagree.** Merged code has opt-in drive mode (JustAsk clicks/types) and a Windows desktop app. The pitch is "she clicks, JustAsk never does." Scope is extension only. **Decision: guide only, hide drive, ignore desktop.**
2. **Nothing is deployed.** Cloud Convex (`aromatic-salamander-969`) has none of the merged code. The caregiver app has no hosting config. Judges can't try it, and teammates can't deploy easily.
3. **Submission pieces are missing.** README has no Cartesia features, setup or limitations (a Cartesia rule). No metrics slide, senior quote, video or Devpost text yet.
4. **Small breakages.**
   - The worklet test fails on Windows (CRLF).
   - The completion note says "finished X on their own", not the brief's "refilled her prescription herself".
   - `people.ts:121` comment is wrong about the default.
   - Scam stats in STATUS.md (FBI 2023, $3.4B) don't match the brief (IC3 2025, $7.7B).

**Timeline:** publishable demo by **midnight tonight (Sat Oct 24)**, final submission **9 AM Sun Oct 25**. Freeze features at ~8 PM. Ami approved edits to `apps/caregiver` for this work.

## 0. Save this plan (~5 min)
- Copy this plan to `docs/refined-plan-3.md`, following the `refined-plan-N` pattern.
- Point CLAUDE.md's "current build plan" line at it.

## 1. Guide only (~1 h)
- **Core gate:** in `packages/core/src/drive.ts` `gateAct` (line ~85), always return guide. Every act step passes through it (`controller.ts:684-690`), and `asGuide` (`controller.ts:734`) already converts it.
- **Prompt:** `packages/core/src/prompt.ts:14-15,24` says "act is the usual choice". Change it to guide only, so Claude stops proposing acts. Keep the `act` schema kind so nothing else breaks.
- **Backend:** `packages/backend/convex/people.ts:125-134` `setShowMe` always stores `true`. Fix the comment at `:121-124`. `DEFAULT_PREFS` (`lib.ts:14`) is already `true`.
- **Extension UI:** remove the "Let JustAsk click and type for me" checkbox (`apps/extension/src/ui/SetupSettings.tsx:36-38`). Make sure `Panel.tsx` drive-only bits (big red Stop while acting, "I did N steps for you") can't appear.
- **Caregiver UI:** remove the `HowItHelps` toggle in `apps/caregiver/src/ui/Person.tsx:417-453`.
- **Tests:** update the drive-mode tests in `packages/core/test/controller.test.ts` and `drive.test.ts` to expect guide. The e2e drive scenarios in `e2e/run.mjs` either expect guide or are skipped.

## 2. Extension only (~20 min)
- Delete `apps/desktop`, then run `npm install` to refresh `package-lock.json`. Nothing imports it.
- Keep the backend handoff code. It's harmless, and deleting it touches tests.
- Hide desktop wording in the extension UI (handoff banner text, "code from the JustAsk desktop app" in setup).
- Update CLAUDE.md, README, STATUS.md: extension only, guide only.

## 3. Caregiver and senior workflows (~2 h)
**Caregiver:** sign up → add person → 6-digit code → send task (recipe + `https://` start page) → feed shows "finished" note → person page shows stats.
**Senior:** install → I have a code → consent switches → task card → Start → guided 4 steps on the fixture pharmacy → "All done, you did it!" → I did it.

- **Completion note:** change `sessions.ts:45` and `tasks.ts:103` to "`${name}` did "`${title}`" herself/themselves" style: `"${displayName} finished "${title}" by themself."` is awkward. Use `"${displayName} did "${title}" on their own."` and keep the consent checks at `sessions.ts:41` and `tasks.ts:101`.
- **Metrics:** extend `people.ts:67-88` and `Person.tsx:393-411` with steps per task and "Say that again" presses. Reuse the existing `events`, consent-gated as now.
  - Assigned vs self-started stays private by design. For the slide, use aggregate counts from the dashboard.
- **Voice:** if Cartesia fails, captions and typing still work, and the step loop never blocks (confirmed). Add one visible note, "Voice is off right now — read the words below", when token minting returns null.
- Run each workflow 3 times on the cloud deployment. Fix only what breaks.

## 4. Easy deploy for any teammate (~1 h)
- **Root scripts in `package.json`:**
  - `deploy:backend`: `npx convex deploy` in `packages/backend`
  - `deploy:caregiver`: Vite build
  - `build:ext:cloud`: the extension build with `VITE_CONVEX_URL` / `VITE_PLANNER_URL` from `.env`
  - `package:ext`: zips `apps/extension/.output/chrome-mv3` for judges
- **Caregiver hosting:** add `apps/caregiver/vercel.json` with SPA rewrites to `index.html`.
- **`docs/DEPLOY.md`, one page:**
  - one-time setup: `npx convex login`, `npx @convex-dev/auth` for `JWT_PRIVATE_KEY`/`JWKS`/`SITE_URL`, `npx convex env set ANTHROPIC_API_KEY` and `CARTESIA_API_KEY`, Vercel project and env vars
  - then the three commands
- **Skip** email verification and password reset (Resend). List them as limitations.
- Run the deploy myself. Confirm each deploy command before running it.

## 5. Small fixes (~15 min)
- `.gitattributes`: `* text=auto eol=lf`, then renormalize. This fixes `apps/extension/test/worklet.test.ts`.
- Align the STATUS.md scam stat with the brief's IC3 2025 figure, marked "secondary, confirm in IC3 report".

## 6. Submission (tonight → 9 AM; team, I draft text)
- **README rewrite:**
  - pitch line
  - judge quick start (zip + caregiver URL + fixture URL)
  - setup
  - Cartesia features used: Sonic TTS, ink-whisper STT, Convex-minted short-lived token
  - safety model: guide only, sensitive fields never read, risk steps ask, suspicious blocks, page text untrusted
  - known limitations
- **Devpost:** one blurb each for Claude, Cartesia, People-First.
- **Demo video:**
  - Record Screen Studio on `localhost:5174` or the hosted fixture, plus phone footage of the senior with consent.
  - Cut it in Clipchamp with captions on.
  - Record a backup take.
- **Slides:**
  - problem stats (Pew 2016 survey, IC3, AARP)
  - demo
  - safety
  - metrics
  - built with Claude Code
  - senior quote

## 7. Final "how JustAsk works" doc (last, ~45 min)
Write `docs/HOW-IT-WORKS.md` (linked first in README) after everything above lands, so it describes the final code.

**Style rules:**
- short sections, each under ~6 lines or one small table
- one idea per bullet, no walls of text
- plain words, with jargon explained in a few words the first time
- a "TL;DR" line at the top of every section
- emoji-free headings that scan

**Sections:**
1. **JustAsk in 30 seconds:** what it does, for whom, the one rule (she clicks).
2. **The pieces:** one diagram (extension, Convex, Claude, Cartesia, caregiver app) and a one-line job for each.
3. **One step, start to finish:** a 6-line numbered flow (scan → number elements → Claude picks a number → safety gates → highlight + speak → her click).
4. **The senior's flow** and **the caregiver's flow:** a short numbered list each.
5. **Safety:** a table of rule, how it's enforced, where in code.
6. **Decisions we made:** a table of decision, why, what we gave up. Include:
   - guide only over drive mode
   - extension only (desktop dropped)
   - Convex backend
   - Claude returns numbers, not selectors
   - no field values leave the page
   - caregiver recipes instead of per-site scripts
   - pairing codes, not senior passwords
   - Cartesia voice with caption/typing fallback
   - scam check before acting
7. **What's not done yet:** a bullet list.
8. **Where things live:** a folder table with one line each.

The doc is for teammates and judges skimming the repo.

## Verification
- `npm test`, `npm run typecheck`, `npm run test:e2e`, `npm run test:caregiver` all green, including the worklet test.
- `npm run test:accounts` and `npm run test:convex` against local Convex.
- After deploy, run both workflows by hand in a fresh Chrome profile against the cloud deployment and the hosted caregiver app.
- Confirm no "click and type" toggle anywhere, and that JustAsk never clicks.
- DevTools Network on the side panel: no field values or keys in payloads.
