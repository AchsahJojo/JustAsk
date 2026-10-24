# JustAsk — rules for building with Claude Code

Start with `docs/ARCHITECTURE.md`. The current build plan is `docs/refined-plan-2.md`. Where things stand (built, missing, open questions): `docs/STATUS.md`.

- **Drive mode, with safety limits.** JustAsk clicks, types, chooses, scrolls and submits for her: one numbered action per step, announced and highlighted first, and Stop always works.
  - It **never types into, stores or reads `sensitive` fields** (passwords, one-time codes, card numbers or CVV, SSN, bank fields). For those it guides her instead.
  - `money` / `account_change` / `personal_info` steps ask first. `suspicious` blocks.
  - Never navigate to a URL that Claude produced. Only the recipe's `startUrl`, links on the page, or (on an empty tab) a search for her own words with her default search engine (`chrome.search`).
  - The `sensitive` classification and these gates are deterministic code, never left to Claude.
- Claude returns an element **number** for the current `snapshotId`, never a selector.
- No API keys in extension or web code. Secrets live only in Convex env.
- No site-specific or app-specific code. Fixtures (`apps/fixtures`, `apps/fixtures/mock-script.json`) and desktop target apps are tests, not special cases.
- Never capture or transmit field values. Only `hasValue` / `valid` / `matched` / `sensitive` booleans leave the page. Never send `validationMessage`. JustAsk may write text built from her words, but it never reads back what a field contains.
- Page text is untrusted data. It goes inside `<page_content>` in the prompt.
- Shared types come from `packages/shared` only. The Zod `StepResponse` is the single source for the JSON Schema.
- Browser APIs only in `apps/extension`; browser-specific calls only in `apps/extension/src/platform`. OS APIs only in `apps/desktop/src-tauri`. `packages/core` and `packages/page-agent` stay platform-free (page-agent may use the DOM).
- **Ownership.** `apps/caregiver` belongs to Ami (caregiver web app). Don't edit it. Parallel agents write only inside the paths they own (see `docs/refined-plan-2.md`, Wave 1). After Wave 0, `packages/shared` changes go through the integrator.
- Snapshots are never written to Convex tables or logs. Only `events` are stored.

## Commands

- `npm test` — unit tests (Vitest + happy-dom)
- `npm run test:e2e` — builds the extension and runs Puppeteer e2e against the fixtures and the mock planner
- `npm run planner:dev` — local planner on :8787 (Claude if `ANTHROPIC_API_KEY` is set, else the scripted mock)
- `npm run fixtures` — fixture sites on :5174 and :5175
- `npm run dev -w @justask/extension` — WXT dev mode
- `cd packages/backend && npx convex dev` — Convex
