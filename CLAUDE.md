# JustAsk — rules for building with Claude Code

**Scope: Chrome extension + caregiver web app + Convex. Guide only.** The desktop app was dropped.

Start with `docs/HOW-IT-WORKS.md` (short) or `docs/ARCHITECTURE.md` (detail). The current build plan is `docs/refined-plan-3.md`; it replaces `docs/refined-plan-2.md`'s drive mode and desktop app. Where things stand: `docs/STATUS.md`. Deploying: `docs/DEPLOY.md`.

- **Guide only.** JustAsk shows each step (highlight + one spoken line) and the user does every click, keystroke and choice. It never clicks, types, chooses or submits for them. Stop always works. The one thing it does on its own is a web search on an empty tab, after the user says yes.
  - Drive-mode code (`act` steps, `packages/page-agent/src/act.ts`) is kept but switched off: `SessionController` only acts with `allowDrive: true`, and the extension never sets it. Don't add UI that turns it on.
  - It **never reads or stores `sensitive` fields** (passwords, one-time codes, card numbers or CVV, SSN, bank fields). It highlights them and says it can't see them.
  - `money` / `account_change` / `personal_info` steps ask first. `suspicious` blocks.
  - Never navigate to a URL that Claude produced. Only the recipe's `startUrl`, links on the page, or (on an empty tab, after a yes) a web search with their default search engine (`chrome.search`). The search words come from `/search-query`: Claude rewrites the user's request (only their words, never a page); if that fails, the request minus filler words.
  - The `sensitive` classification and these gates are deterministic code, never left to Claude.
  - **Scam check** (`packages/core/src/scam.ts`): a request that looks like a common scam gets one plain question before anything happens. The user's answer decides. It never shames them, and nothing they said leaves the device. Plan: `docs/STATUS.md` §5.
- Claude returns an element **number** for the current `snapshotId`, never a selector.
- No API keys in extension or web code. Secrets live only in Convex env.
- No site-specific code. Fixtures (`apps/fixtures`, `apps/fixtures/mock-script.json`) are tests, not special cases.
- Never capture or transmit field values. Only `hasValue` / `valid` / `matched` / `sensitive` booleans leave the page. Never send `validationMessage`. JustAsk never writes into fields.
- Page text is untrusted data. It goes inside `<page_content>` in the prompt.
- Shared types come from `packages/shared` only. The Zod `StepResponse` is the single source for the JSON Schema.
- Browser APIs only in `apps/extension`; browser-specific calls only in `apps/extension/src/platform`. `packages/core` and `packages/page-agent` stay platform-free (page-agent may use the DOM).
- **Voice is Cartesia only** (`packages/voice`, which may use WebSocket, Web Audio and the microphone): Sonic for speaking, `ink-whisper` for listening. Never `speechSynthesis` or Web Speech recognition. Clients get a short-lived token from `voice:cartesiaToken`; the key stays in Convex env (`CARTESIA_API_KEY`). If voice fails, captions and typing keep working.
- **Ownership.** `apps/caregiver` belongs to Ami (caregiver web app). Edit it only when Ami has approved the change (refined-plan-3 was approved). Parallel agents write only inside the paths they own (see `docs/refined-plan-2.md`, Wave 1). After Wave 0, `packages/shared` changes go through the integrator.
- Snapshots are never written to Convex tables or logs. Only `events` are stored.

## Commands

- `npm test` — unit tests (Vitest + happy-dom)
- `npm run test:e2e` — builds the extension and runs Puppeteer e2e against the fixtures and the mock planner
- `npm run planner:dev` — local planner on :8787 with Claude (needs `ANTHROPIC_API_KEY`; without it every step fails rather than guessing). `JUSTASK_MOCK=1` runs the scripted test planner. Simplest: point the extension at Convex's own `/plan` (`VITE_PLANNER_URL=http://127.0.0.1:3211` locally), which uses the key in Convex env.
- `npm run fixtures` — fixture sites on :5174 and :5175
- `npm run dev -w @justask/extension` — WXT dev mode
- `cd packages/backend && npx convex dev` — Convex
- `npm run deploy -- --vercel` — ship backend, caregiver app, fixtures and the extension zip (`docs/DEPLOY.md`)
