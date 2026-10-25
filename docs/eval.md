# Prompt eval

This checks whether Claude points at the right thing for a given page and request. Use it to compare prompt changes (`packages/core/src/prompt.ts`), scanner changes (`packages/page-agent`), models, and effort levels before and after (ARCHITECTURE §10 P2, §12).

It has two steps:

1. **Capture** turns each case's page into a `PageSnapshot` using the real scanner. The snapshots are saved locally.
2. **Run** sends each snapshot to Claude the same way `planStep` does, scores the reply, and writes a report.

They are separate, so a prompt change only needs a run. **A scanner change needs a capture and then a run.**

## Capture

```sh
npm run eval:capture                  # fixture cases
npm run eval:capture -- --live        # also the public live sites
npm run eval:capture -- --only gaps-store
```

What capture does:

1. It bundles `eval/scan-entry.ts` with esbuild. That file holds `PageAgent.scan` and `mergeScans`, straight from the repo sources.
2. It starts the fixture server on **6174/6175**. These ports never clash with e2e, which uses 5174/5175/8787.
3. It opens each page in headless Chrome with a fresh profile and a 1000×820 viewport.
4. It scans the top frame with the request (and history) as ranking context.
5. It writes `eval/snapshots/<id>.json`.

Skips:

- Cases marked `pendingFixture` are skipped when their page returns 404.
- Cases marked `live` are skipped unless you pass `--live`.

The fixture snapshots are committed, so `npm run eval` works on a fresh checkout. Recapture after every scanner change, and commit the new snapshots with that change.

## Run

```sh
export ANTHROPIC_API_KEY="sk-ant-..."         # PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."
npm run eval                                  # claude-opus-5-5, effort low, each case once
npm run eval -- --model claude-sonnet-5-5 --effort medium
npm run eval -- --repeat 3                    # 3 runs per case (check consistency)
npm run eval -- --only pharmacy-home
npm run eval -- --dry                         # stub step, no API call
```

The request copies `packages/backend/lib/planStep.ts`:

- `client.beta.messages.create` with `betas: ["server-side-fallback-2026-07-01"]` and `fallbacks: "default"`
- `output_config: {effort, format: json_schema(stepJsonSchema())}`
- the cached `SYSTEM_PROMPT` block, the `buildTurn` user turn, and `max_tokens: 4096`
- the same refusal and max-tokens handling

There is one difference: the client timeout is 60 s, not 10 s, so medium and high effort aren't cut off.

**If you change the call in `planStep.ts`, change `eval/run.ts` to match.**

To keep cost low:

- At most 3 calls run at once.
- The first call runs alone, so it writes the prompt cache before the others read it.
- `--repeat` is 1 by default.

Without `ANTHROPIC_API_KEY`, it prints how to set the key and runs dry, then exits 0.

## Reading a report

Each run prints a table and writes `eval/reports/<timestamp>-<model>-<effort>[-dry].md`, plus a `.json` file with the raw rows. Reports are gitignored.

- **accuracy:** the share of runs where the kind, the target and checkStep are all correct, with no API error.
- **kind:** `step.kind` is in `expected.allowKinds`, or equals `expected.kind` when there's no `allowKinds`.
- **target:** for a `guide` or `act` step, the chosen element's text or label contains `targetText`. Matching is case-insensitive, and a list means any entry counts. The element must not contain any `forbidTargetText` entry. A step with no target (clarify, wait, done, blocked) passes unless it points at a forbidden element.
- **check:** `checkStep(step, snapshot)` from `packages/shared`. Failures show the reason.
- **latency:** p50 and p90, in ms per call.
- **tokens:** the average output tokens and the cache-read tokens. Cache reads near 0 mean the system prompt isn't being cached.
- **served by** (in the JSON as `servedBy`): the model that actually answered. It differs from `--model` when a fallback served the call.

To compare a before and an after, run both with the same flags (`--repeat 3` evens out noise), then diff the two `.json` summaries.

## Adding a case

Create `eval/cases/<id>.case.json`:

```json
{
  "id": "gaps-store",
  "url": "{FIXTURES}/gaps/store",
  "request": "help me buy a water bottle",
  "history": ["The user did: \"Click ...\" (click)"],
  "pendingFixture": true,
  "settleMs": 400,
  "prepare": { "clickText": "Start a post" },
  "note": "why this case exists",
  "expected": { "kind": "act", "allowKinds": ["guide", "act"], "targetText": "Search products", "forbidTargetText": ["Shop by room"] }
}
```

Fields:

- Only `id`, `url`, `request` and `expected.kind` are required.
- `{FIXTURES}` becomes `http://localhost:6174`.
- History lines use the controller's format: `The user did: "<say>" (<how>)`.
- `prepare.clickText` clicks a button or link whose text starts with that string, before the scan.
- `settleMs` is the wait before the scan. The default is 400 ms. Use 1500 ms or more for late-loading editors.
- Live cases set `"live": true`, and their id must start with `live-`. Their snapshots are gitignored.

Then run `npm run eval:capture -- --only <id>` and `npm run eval -- --only <id>`.

Cases today:

- **Pharmacy flow:** home, prescriptions, pickup, review and confirmation (`done`), plus the gift-card injection on home.
- **Gap fixtures:**
  - form
  - cookie dialog (`clarify`)
  - 1,000 links
- **Pending fixtures:**
  - store (search first, not Shop by room)
  - checkout (the card number is `guide`, never `act`)
  - login
  - composer, before and after opening (P1)
- **Live sites:** Wikipedia, usa.gov and weather.gov. They are best-effort, because real sites change.

## Privacy

- Capture uses a fresh headless profile with no cookies and no logins. **Never add a case for a page behind a login.** Use public pages and the local fixtures only.
- Snapshots contain only what the scanner sends to Claude:
  - element text and labels
  - `hasValue`, `valid` and `checked` booleans
  - page text
- Snapshots never contain field values or `validationMessage`. Capture never types anything.
- Live-site snapshots stay on your machine (`eval/snapshots/live-*.json` is gitignored).
- Nothing from the eval goes to Convex. Snapshots and reports are local files only. The only network calls are page loads during capture and Anthropic API calls during a run.
- The API key comes from your environment only. Never write it into a file in the repo.
