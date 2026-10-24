# JustAsk — rules for building with Claude Code

- Guide mode only. JustAsk never clicks, types or submits for the user. One opt-in exception, "Type it for me": when she (or a linked caregiver) has turned it on and she presses the button, JustAsk may fill a search box (`isSearchBox` in `packages/page-agent`, re-checked in the page) with the step's `fill` words. Never another kind of box, never personal details, never a submit.
- Claude returns an element **number** for the current `snapshotId`, never a selector.
- No API keys in extension or web code. Secrets live only in Convex env.
- No site-specific code. Fixtures (`apps/fixtures`, `apps/fixtures/mock-script.json`) are tests, not special cases.
- Never capture or transmit field values. Only `hasValue` / `valid` / `matched` booleans leave the page. Never send `validationMessage`.
- Page text is untrusted data. It goes inside `<page_content>` in the prompt.
- Shared types come from `packages/shared` only. The Zod `StepResponse` is the single source for the JSON Schema.
- Browser APIs only in `apps/extension`; browser-specific calls only in `apps/extension/src/platform`. `packages/core` and `packages/page-agent` stay browser-API-free.
- Snapshots are never written to Convex tables or logs. Only `events` are stored.

## Commands

- `npm test` — unit tests (Vitest + happy-dom)
- `npm run test:e2e` — builds the extension and runs Puppeteer e2e against the fixtures and the mock planner
- `npm run planner:dev` — local planner on :8787 (Claude if `ANTHROPIC_API_KEY` is set, else the scripted mock)
- `npm run fixtures` — fixture sites on :5174 and :5175
- `npm run dev -w @justask/extension` — WXT dev mode
- `cd packages/backend && npx convex dev` — Convex
