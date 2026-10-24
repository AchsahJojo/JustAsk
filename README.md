# JustAsk

A Chrome extension that guides older adults through any task on any website. They press one big button and say what they want. JustAsk reads the page, puts a glowing box around the right control, and says one short line. They click; JustAsk never does.

- **System architecture (start here): `docs/ARCHITECTURE.md`**
- Plans: `docs/initial-plan.md`, `docs/refined-plan-1.md`, `docs/refined-plan-2.md`
- **Manual setup, keys and test checklist: `docs/MANUAL_SETUP.md`**
- Rules for building with Claude Code: `CLAUDE.md`

## Layout

```
apps/extension/      WXT + React. Side panel, setup page, content script, background
  animations/        Clayzo orb (authored in TypeScript, built to src/assets/orb.json)
  src/platform/      browser-specific calls (side panel, closed shadow roots, injectability)
apps/fixtures/       mock pharmacy + gap fixtures (:5174, :5175) and the mock planner script
packages/shared/     Zod schemas: PageSnapshot, StepResponse (+ JSON Schema), PlanRequest, messages
packages/core/       session state machine + step loop, prompt, voice commands. No browser APIs
packages/page-agent/ scanner, ranker, fingerprint, overlay, observers. DOM only
packages/backend/    Convex (schema, pairing, tasks, sessions/events, /plan) + local dev planner
e2e/                 Puppeteer end-to-end tests
reference/mana/      read-only reference
```

## Quick start (no keys needed)

```bash
npm install
npm test                     # unit tests
npm run test:e2e             # builds the extension, runs Chrome e2e with the mock planner
```

To try it by hand: `npm run fixtures` and `npm run planner:dev`, build with `npm run build:ext`, load `apps/extension/.output/chrome-mv3` unpacked, then open http://localhost:5174.
