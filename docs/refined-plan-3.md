# Refined plan 3: guide-only JustAsk

## Context

Today JustAsk "drives": it clicks, types, chooses, scrolls, submits and (on the desktop) opens the browser for her. The product decision is that it must not act for her. It should only break the task into steps and highlight the one element she should use next, and she does every action herself. This needs to land fast.

There is no clean commit to roll back to. Drive mode is spread across commits that also contain the desktop app, accounts, handoffs and Ami's caregiver work (`d16dfe8`, `9fdcb7f`, `b4e13a5`, `36f6323`, `03cb89a`, `f73173f`). So we remove it by hand on top of `feature/xander`.

## Decisions (from the user)

- **open_browser**: keep the step kind, as guidance only. JustAsk says "Please open your web browser, like Chrome or Edge. I'll wait." and waits; it never opens anything. Delete the Rust launcher.
- **showMeInstead**: remove it from core, the extension and desktop. The Convex backend keeps the field, `people.get`, `people.setShowMe` and `prefs` unchanged, so Ami's caregiver app and stored data still work. Ami is told to remove her "Click and type for…" card.
- **Desktop fixes**: add the missing `type` field to native events, and remove `set_focus()` from highlight.
- **Git**: edit on `feature/xander`. Don't commit unless asked.
- **Defaults**:
  - Remove the step `text` field.
  - Keep the risk "check first" question on guide steps (money, personal_info, account_change); `suspicious` still blocks.
  - Keep `submit` and `scroll` as guide hints ("Press Enter here", "Scroll to here").
- **Process**: test-driven. Each agent first updates or writes tests for guide-only behavior, runs them and sees them fail, then changes the code, then sees them pass. Each agent reports the before and after test output.

## Shared contract (every agent codes against this)

**`packages/shared`**
- `StepKind = ["guide","clarify","wait","done","blocked","open_browser"]`. `"act"` is removed.
- `StepResponse` loses the `text` field. The JSON schema derives from it automatically.
- `checkStep`:
  - guide needs a target and expect.
  - Remove all act-only rules.
  - open_browser: target, expect and option must be null, risk must be `"none"`, and only on the native surface.
  - Only guide and clarify may have a target.
- `messages.ts`: remove `ActSpec`, `ActResult` and the `ja:act` member of `ToContent`.

**`packages/core`**
- `PageBridge`: remove `act` and `openBrowser`.
- `Phase`: remove `"acting"`.
- `SessionView`: remove `actions`. Keep `clicks` and `guidedSteps`.
- `ControllerDeps`: remove `prefs`.
- Delete `drive.ts` and its export. Move the `snapshotSignature` test to its own file.
- Controller:
  - Remove `doAct`, `asGuide`, `askText`, `openBrowser` (the act path), `pending` other than the risk flow, `guideMode`, `noChange`, `browserOpened`, `actBeatMs` and `NO_CHANGE_LIMIT`.
  - Remove `sleep()` if nothing else uses it.
  - `case "open_browser"` goes straight to the existing guide wait with `OPEN_BROWSER_GUIDE`.
  - Risk confirm: yes runs `showGuide`; no ends the session the same way it does now.
- `lines.ts`:
  - Remove `ACT_LABEL`, `ACT_FAILED_NOTE`, `GUIDE_MODE_NOTE`, `SHOW_ME_NOTE`, `TEXT_DECLINED_NOTE`, `OPENING_BROWSER`, `OPENED_BROWSER_NOTE`, `typeConfirm`, `doneActed` and `guideInstead`.
  - Keep `LOOKING_NEXT`, `SEE_IT_NOW` and `OPEN_BROWSER_GUIDE`.
- `prompt.ts`:
  - Rewrite the drive parts. Guide is the only way to show a step. `say` tells her what to do, for example "Click the big blue button that says Refill a prescription." or "Type water bottle in the search box.", using only her words.
  - Remove `text` from every example, and convert the act examples (#1–4, #9) to guide.
  - open_browser asks her to open her browser.
  - History lines are always "She did".
  - Keep the prompt longer than 3000 characters; tests check this.

## Agents (parallel, separate paths)

1. **Shared + core** (`packages/shared/**`, `packages/core/**`): the contract above, plus tests.
   - Turn the drive tests in `controller.test.ts` into guide versions. Move the 2 guide tests out of the "drive mode" describe block.
   - Waiting tests use `guide` as the follow-up step.
   - Delete `drive.test.ts`, keeping the `snapshotSignature` test.
   - Remove the act and `text` cases from `step.test.ts`.
2. **Extension + page-agent** (`apps/extension/**`, `packages/page-agent/**`).
   - Delete `page-agent/src/act.ts`, its export and `act.test.ts`.
   - Remove `PageAgent.act` and the `this.done` handling only it needs.
   - Remove the `ja:act` case in `content.ts` and `ExtensionBridge.act`.
   - `Panel.tsx`: remove the `acting` phase, `actionsOf`/actions, and the red "Stop. JustAsk will not do anything else" button. Keep the normal Stop. Done line is "You made N clicks yourself."
   - Remove the Show me instead toggle (`SetupSettings.tsx`) and its config, prefs, session and backend wiring. `mergePrefs` ignores the remote field.
   - `Setup.tsx` onboarding copy: "JustAsk shows you exactly where to click."
   - Remove the `.acting` / `.stop-now` styles.
   - Update `prefs.test.ts` and `live.test.ts`.
3. **Desktop** (`apps/desktop/**`, TypeScript and Rust).
   - Remove `act` and `openBrowser` from `native.ts` and `bridge.ts`.
   - Remove the prefs wiring in `host.ts` and `getPrefs` in `backend.ts`.
   - `Ask.tsx`: remove the `acting` UI. Keep the risk confirm UI.
   - Rust:
     - Delete the `act` and `open_browser` commands, stubs, handlers, the registry helpers and the parser test. Remove the `Win32_System_Registry` feature.
     - Add `"type": "<event name>"` to every `emit_native` payload. TDD: add a pure `event_payload(name, fields)` helper with a unit test that checks `type` is set.
     - Delete `element.set_focus()` from `highlight`.
   - Update `bridge.test.ts`.
4. **Backend + fixtures + eval** (`packages/backend/**`, `apps/fixtures/**`, `eval/**`, `e2e/**`).
   - The Convex functions and schema stay as they are. Only update the `people.setShowMe` doc comment to say the field is no longer used.
   - `mockPlanner.ts`: remove `text`.
   - `mock-script.json`: turn the act rows into guide rows. The open_browser row keeps the guide wording.
   - Update `planStep.test.ts`.
   - `eval/lib/score.ts`: remove `"act"` from `TARGETING`. In the eval cases, `allowKinds`/`kind` "act" becomes "guide".
   - e2e: change only what breaks. `e2e/caregiver.mjs` keeps its Show-me step because the backend and caregiver app are unchanged.
5. **Docs** (`CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/TESTING.md`, `docs/MANUAL_SETUP.md`, new `docs/refined-plan-3.md`).
   - Replace the CLAUDE.md drive-mode block with a guide-only rule. JustAsk never clicks, types, chooses, scrolls, submits or opens anything for her. Each step highlights one element and says what to do. Stop always works.
   - Keep the rules that still apply: it never reads or stores sensitive values; risk steps ask first; suspicious blocks; never navigate to a URL from Claude.
   - Remove "JustAsk may write text built from her words".
   - Rewrite ARCHITECTURE §11 and fix §1, §2, §5, §6, §8, §9, §10, §12.
   - Update the TESTING and MANUAL_SETUP drive checks.
   - `docs/refined-plan-3.md` = this plan plus a note for Ami.

Not touched: `apps/caregiver` (Ami's).

## Integration (me, after the agents finish)

1. `npm test`, then `npx tsc --noEmit` for each workspace, `cargo test --lib` in `apps/desktop/src-tauri`, and `npm run test:e2e`.
2. Search for leftovers in `apps/extension`, `apps/desktop`, `packages/core`, `packages/shared` and `packages/page-agent`:
   ```
   git grep -nE "ja:act|performAct|ActSpec|ActResult|showMeInstead|\"acting\"|doneActed|open_browser\b.*spawn" -- apps/extension apps/desktop packages/core packages/shared packages/page-agent
   ```
   It should return nothing, except the backend fields we deliberately keep.
3. Fix anything left across packages, and report.

## Manual checks for you (easiest first)

1. **Unit tests**: `npm test`. Expect all green.
2. **Extension end to end (automatic)**: `npm run test:e2e`. It builds the extension and runs the fixture scenarios against the mock planner.
3. **Push the planner to Convex.** This is required: the deployed planner still allows "act" until you do it.
   ```
   cd packages/backend; npx convex dev
   ```
   Leave it running.
4. **Extension by hand**:
   - Run `npm run fixtures` and `npm run dev -w @justask/extension`. The browser that opens has JustAsk loaded.
   - Go to http://localhost:5174 and ask "refill my prescription".
   - Expect a green ring with "Click here" and a spoken line telling *you* to click. Nothing clicks or types by itself.
   - Click it: you get praise, then the next ring.
   - Settings has no "Show me instead" toggle.
5. **Desktop by hand**:
   - Run `npm run tauri -w @justask/desktop -- dev`. Open Notepad, click into JustAsk, and ask "help me save this file".
   - A ring appears in Notepad. Focus stays in JustAsk, and the Notepad window does not jump forward.
   - Click the ringed item yourself: JustAsk moves to the next step.
   - Ask "find a banana bread recipe" while in Notepad. JustAsk says "Please open your web browser, like Chrome or Edge. I'll wait." and nothing opens.
   - Open Edge yourself: JustAsk continues there.

## Note for Ami

- The caregiver app's **How JustAsk helps** card (`apps/caregiver/src/ui/Person.tsx`, about lines 417-445) has a "Click and type for {name}" toggle. It calls `people.setShowMe`.
- That toggle no longer changes anything. JustAsk only guides now, so there is nothing to switch.
- Please remove the card when you can.
- The backend keeps `showMeInstead`, `showMeSetBy`, `people.get` and `people.setShowMe` unchanged, so nothing breaks in the meantime.
